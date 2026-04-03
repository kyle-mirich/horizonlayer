import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientQueryMock = vi.fn();
const poolQueryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    connect: connectMock,
    query: poolQueryMock,
  }),
}));

vi.mock('./accessControl.js', () => ({
  assertSessionReadAccess: vi.fn().mockResolvedValue(undefined),
  assertSessionWriteAccess: vi.fn().mockResolvedValue({ workspace_id: 'ws-1' }),
  assertWorkspaceReadAccess: vi.fn().mockResolvedValue(undefined),
  assertWorkspaceWriteAccess: vi.fn().mockResolvedValue(undefined),
}));

function buildRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    workspace_id: 'ws-1',
    task_id: null,
    parent_run_id: null,
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

describe('run query state machine', () => {
  beforeEach(() => {
    clientQueryMock.mockReset();
    poolQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockReset();
    connectMock.mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock,
    });
  });

  it('rejects checkpoints on non-running runs', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT * FROM agent_runs WHERE id = $1 LIMIT 1 FOR UPDATE')) {
        return {
          rows: [
            buildRun({
              status: 'completed',
            }),
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { checkpointRun } = await import('./runs.js');
    await expect(
      checkpointRun({
        run_id: 'run-1',
        summary: 'done',
      })
    ).rejects.toThrow('Run run-1 is already completed, cannot checkpoint');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('rejects terminal transitions on non-running runs', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT * FROM agent_runs WHERE id = $1 LIMIT 1') {
        return {
          rows: [
            buildRun({
              status: 'failed',
            }),
          ],
        };
      }
      if (sql.includes('SELECT *') && sql.includes('FROM run_checkpoints')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { completeRun } = await import('./runs.js');
    await expect(
      completeRun({
        run_id: 'run-1',
      })
    ).rejects.toThrow('Run run-1 is already failed, cannot complete');
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rejects starting a run with a task from another workspace', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tasks')) {
        return {
          rows: [{ session_id: null, workspace_id: 'ws-2' }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { startRun } = await import('./runs.js');
    await expect(
      startRun({
        agent_name: 'planner',
        task_id: 'task-1',
        workspace_id: 'ws-1',
      })
    ).rejects.toThrow('task_id must belong to workspace ws-1');
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rejects starting a run when the parent run session does not match', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agent_runs')) {
        return {
          rows: [{ session_id: null, workspace_id: 'ws-1' }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { startRun } = await import('./runs.js');
    await expect(
      startRun({
        agent_name: 'planner',
        parent_run_id: 'run-0',
        session_id: 'session-1',
        workspace_id: 'ws-1',
      })
    ).rejects.toThrow('parent_run_id must belong to the requested session');
    expect(connectMock).not.toHaveBeenCalled();
  });
});
