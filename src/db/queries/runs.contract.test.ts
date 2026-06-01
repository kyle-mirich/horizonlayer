import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const clientQueryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn();
const touchSessionMock = vi.fn();
const assertSessionReadAccessMock = vi.fn();
const assertSessionWriteAccessMock = vi.fn();
const assertWorkspaceReadAccessMock = vi.fn();
const assertWorkspaceWriteAccessMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    connect: connectMock,
    query: poolQueryMock,
  }),
}));

vi.mock('./sessions.js', () => ({
  touchSession: touchSessionMock,
}));

vi.mock('./accessControl.js', () => ({
  assertSessionReadAccess: assertSessionReadAccessMock,
  assertSessionWriteAccess: assertSessionWriteAccessMock,
  assertWorkspaceReadAccess: assertWorkspaceReadAccessMock,
  assertWorkspaceWriteAccess: assertWorkspaceWriteAccessMock,
}));

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    workspace_id: 'ws-1',
    session_id: 'session-1',
    task_id: null,
    parent_run_id: null,
    agent_name: 'agent',
    title: 'Run',
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

describe('run query contracts', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockReset();
    touchSessionMock.mockReset();
    assertSessionReadAccessMock.mockReset();
    assertSessionWriteAccessMock.mockReset();
    assertWorkspaceReadAccessMock.mockReset();
    assertWorkspaceWriteAccessMock.mockReset();
    connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    assertSessionReadAccessMock.mockResolvedValue({ workspace_id: 'ws-1' });
    assertSessionWriteAccessMock.mockResolvedValue({ workspace_id: 'ws-1' });
    assertWorkspaceReadAccessMock.mockResolvedValue(undefined);
    assertWorkspaceWriteAccessMock.mockResolvedValue(undefined);
  });

  it('starts runs after validating workspace, session, task, and parent scope', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ workspace_id: 'ws-1', session_id: 'session-1' }] })
      .mockResolvedValueOnce({ rows: [{ workspace_id: 'ws-1', session_id: 'session-1' }] })
      .mockResolvedValueOnce({ rows: [run({ task_id: 'task-1', parent_run_id: 'parent-1' })] });

    const { startRun } = await import('./runs.js');
    const started = await startRun({
      workspace_id: 'ws-1',
      session_id: 'session-1',
      task_id: 'task-1',
      parent_run_id: 'parent-1',
      agent_name: 'agent',
      title: 'Run',
      metadata: { plan: true },
    });

    expect(started.checkpoints).toEqual([]);
    expect(assertWorkspaceWriteAccessMock).toHaveBeenCalledWith('ws-1', { kind: 'system' });
    expect(assertSessionWriteAccessMock).toHaveBeenCalledWith('session-1', { kind: 'system' });
    expect(touchSessionMock).toHaveBeenCalledWith('session-1');
    expect(poolQueryMock.mock.calls[2]?.[1]).toEqual([
      'ws-1',
      'session-1',
      'task-1',
      'parent-1',
      'agent',
      'Run',
      JSON.stringify({ plan: true }),
    ]);
  });

  it.each([
    ['missing task', { taskRows: [], parentRows: [], message: 'Task task-1 not found' }],
    ['wrong task workspace', { taskRows: [{ workspace_id: 'ws-2', session_id: 'session-1' }], parentRows: [], message: 'task_id must belong to workspace ws-1' }],
    ['wrong task session', { taskRows: [{ workspace_id: 'ws-1', session_id: 'other-session' }], parentRows: [], message: 'task_id must belong to the requested session' }],
    ['missing parent', { taskRows: [{ workspace_id: 'ws-1', session_id: 'session-1' }], parentRows: [], message: 'Run parent-1 not found' }],
    ['wrong parent workspace', { taskRows: [{ workspace_id: 'ws-1', session_id: 'session-1' }], parentRows: [{ workspace_id: 'ws-2', session_id: 'session-1' }], message: 'parent_run_id must belong to workspace ws-1' }],
    ['wrong parent session', { taskRows: [{ workspace_id: 'ws-1', session_id: 'session-1' }], parentRows: [{ workspace_id: 'ws-1', session_id: null }], message: 'parent_run_id must belong to the requested session' }],
  ])('rejects %s references while starting runs', async (_case, config) => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: config.taskRows })
      .mockResolvedValueOnce({ rows: config.parentRows });

    const { startRun } = await import('./runs.js');
    await expect(startRun({
      workspace_id: 'ws-1',
      session_id: 'session-1',
      task_id: 'task-1',
      parent_run_id: 'parent-1',
      agent_name: 'agent',
    })).rejects.toThrow(config.message);
  });

  it('gets and lists runs with access and filter checks', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [run()] })
      .mockResolvedValueOnce({ rows: [{ id: 'checkpoint-1', sequence: 1 }] })
      .mockResolvedValueOnce({ rows: [run({ session_id: 'other-session' })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [run()] });

    const { getRun, listRuns } = await import('./runs.js');

    await expect(getRun('run-1', { kind: 'user', workspaceIds: ['ws-1'] } as never, 'session-1')).resolves.toMatchObject({
      id: 'run-1',
      checkpoints: [{ id: 'checkpoint-1' }],
    });
    await expect(getRun('run-1', { kind: 'system' }, 'session-1')).resolves.toBeNull();
    await expect(listRuns({
      workspace_id: 'ws-1',
      session_id: 'session-1',
      task_id: 'task-1',
      agent_name: 'agent',
      status: ['running'],
      limit: 10,
      offset: 5,
      access: { kind: 'user', workspaceIds: ['ws-1'] } as never,
    })).resolves.toHaveLength(1);

    expect(String(poolQueryMock.mock.calls.at(-1)?.[0])).toContain('status = ANY($5)');
  });

  it('checkpoints running runs and rolls back missing or stale runs', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [run({ latest_checkpoint_sequence: 2 })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    poolQueryMock
      .mockResolvedValueOnce({ rows: [run({ latest_checkpoint_sequence: 3 })] })
      .mockResolvedValueOnce({ rows: [{ id: 'checkpoint-3', sequence: 3 }] });

    const { checkpointRun } = await import('./runs.js');
    await expect(checkpointRun({ run_id: 'run-1', agent_name: 'agent', summary: 'Saved', state: { step: 1 } })).resolves.toMatchObject({
      latest_checkpoint_sequence: 3,
      checkpoints: [{ sequence: 3 }],
    });

    expect(touchSessionMock).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(clientQueryMock.mock.calls[2]?.[1]).toEqual(['run-1', 3, 'Saved', JSON.stringify({ step: 1 }), JSON.stringify({})]);

    clientQueryMock.mockReset();
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(checkpointRun({ run_id: 'missing', agent_name: 'agent' })).resolves.toBeNull();
    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');

    clientQueryMock.mockReset();
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [run({ status: 'completed' })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(checkpointRun({ run_id: 'run-1', agent_name: 'agent' })).rejects.toThrow(
      'Run run-1 is already completed, cannot checkpoint'
    );
  });

  it.each([
    ['completeRun', 'completed'],
    ['failRun', 'failed'],
    ['cancelRun', 'cancelled'],
  ] as const)('updates run status through %s', async (fnName, status) => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [run()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [run({ status })] })
      .mockResolvedValueOnce({ rows: [run({ status })] })
      .mockResolvedValueOnce({ rows: [] });

    const runsModule = await import('./runs.js');
    await expect(runsModule[fnName]({
      run_id: 'run-1',
      agent_name: 'agent',
      result: { ok: true },
      error_message: status === 'failed' ? 'failed' : undefined,
    } as never)).resolves.toMatchObject({ status });

    expect(touchSessionMock).toHaveBeenCalledWith('session-1');
  });

  it('rejects run mutations from the wrong owner or after concurrent completion', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [run({ agent_name: 'owner' })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [run()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { completeRun } = await import('./runs.js');

    await expect(completeRun({ run_id: 'run-1', agent_name: 'agent' })).rejects.toThrow('Run run-1 is owned by owner, not agent');
    await expect(completeRun({ run_id: 'run-1', agent_name: 'agent' })).rejects.toThrow('Run run-1 is no longer running');
  });
});
