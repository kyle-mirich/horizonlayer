import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  requireActiveSession: vi.fn(),
  lockActiveSessionForChildWrite: vi.fn(),
  requireActiveWorkspace: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  poolQuery: vi.fn(),
  release: vi.fn(),
  touchSession: vi.fn(),
}));

vi.mock('../client.js', () => ({
  getPool: () => ({
    connect: mocks.connect,
    query: mocks.poolQuery,
  }),
}));

vi.mock('./scopeGuards.js', () => ({
  lockActiveSessionForChildWrite: mocks.lockActiveSessionForChildWrite,
  requireActiveSession: mocks.requireActiveSession,
  requireActiveWorkspace: mocks.requireActiveWorkspace,
  requireSession: mocks.requireSession,
}));

vi.mock('./sessions.js', () => ({
  touchSession: mocks.touchSession,
}));

function buildRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    workspace_id: 'ws-1',
    session_id: 'session-1',
    agent_name: 'planner',
    title: null,
    status: 'running',
    metadata: {},
    result: {},
    error_message: null,
    latest_checkpoint_sequence: 0,
    latest_checkpoint_at: null,
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockLockedRun(run: ReturnType<typeof buildRun>): void {
  mocks.clientQuery.mockImplementation(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('FROM agent_runs') && sql.includes('FOR UPDATE')) {
      return { rows: [run] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
}

describe('run query state machine', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.connect.mockResolvedValue({
      query: mocks.clientQuery,
      release: mocks.release,
    });
    mocks.requireSession.mockResolvedValue({ workspace_id: 'ws-1' });
    mocks.requireActiveSession.mockResolvedValue({ workspace_id: 'ws-1' });
    mocks.lockActiveSessionForChildWrite.mockResolvedValue({ workspace_id: 'ws-1' });
    mocks.requireActiveWorkspace.mockResolvedValue(undefined);
    mocks.touchSession.mockResolvedValue(undefined);
  });

  it('rejects blank agent names before starting a run', async () => {
    const { startRun } = await import('./runs.js');

    await expect(startRun({
      agent_name: '  ',
      workspace_id: 'ws-1',
    })).rejects.toThrow('agent_name is required');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('rejects checkpoints on terminal runs and rolls back', async () => {
    mockLockedRun(buildRun({ status: 'completed' }));

    const { checkpointRun } = await import('./runs.js');
    await expect(checkpointRun({
      run_id: 'run-1',
      summary: 'too late',
    })).rejects.toThrow('Run run-1 is already completed, cannot checkpoint');

    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('rejects finishing terminal runs and rolls back', async () => {
    mockLockedRun(buildRun({ status: 'failed' }));

    const { finishRun } = await import('./runs.js');
    await expect(finishRun({
      outcome: 'completed',
      run_id: 'run-1',
    })).rejects.toThrow('Run run-1 is already failed, cannot finish');

    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('rejects error_message for non-failed outcomes before checking out a client', async () => {
    const { finishRun } = await import('./runs.js');

    await expect(finishRun({
      error_message: 'not applicable',
      outcome: 'completed',
      run_id: 'run-1',
    })).rejects.toThrow('error_message is only valid when outcome is failed');
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
