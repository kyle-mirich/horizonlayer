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

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    workspace_id: 'ws-1',
    session_id: 'session-1',
    title: 'Task',
    description: null,
    status: 'claimed',
    priority: 100,
    owner_agent_name: 'agent',
    lease_owner_agent_name: 'agent',
    lease_expires_at: '2099-01-01T00:00:00.000Z',
    heartbeat_at: '2026-01-01T00:00:00.000Z',
    revision: 1,
    attempt_count: 1,
    max_attempts: 3,
    handoff_target_agent_name: null,
    blocker_reason: null,
    required_ack_agent_names: [],
    metadata: {},
    created_by_agent_name: null,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    last_event_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function queueTaskDetails(taskRow = task()) {
  poolQueryMock
    .mockResolvedValueOnce({ rows: [taskRow] })
    .mockResolvedValueOnce({ rows: [{ agent_name: 'reviewer' }] })
    .mockResolvedValueOnce({ rows: [{ depends_on_task_id: 'dep-1' }] });
}

describe('task query contracts', () => {
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

  it('creates tasks with dependencies, required acknowledgements, events, inbox items, and session touch', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'dep-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [task({ status: 'handoff_pending', owner_agent_name: 'owner', lease_owner_agent_name: null })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    queueTaskDetails(task({ status: 'handoff_pending', owner_agent_name: 'owner', lease_owner_agent_name: null }));

    const { createTask } = await import('./tasks.js');
    const created = await createTask({
      workspace_id: 'ws-1',
      session_id: 'session-1',
      title: 'Task',
      owner_agent_name: 'owner',
      created_by_agent_name: 'creator',
      depends_on_task_ids: ['dep-1', 'dep-1'],
      required_ack_agent_names: ['reviewer'],
      metadata: { priority: 'high' },
    });

    expect(created.status).toBe('handoff_pending');
    expect(clientQueryMock.mock.calls[3]?.[1]?.[4]).toBe('handoff_pending');
    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO agent_inbox'))).toBe(true);
    expect(touchSessionMock).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back task creation when dependencies are outside the workspace', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { createTask } = await import('./tasks.js');
    await expect(createTask({
      workspace_id: 'ws-1',
      title: 'Task',
      depends_on_task_ids: ['dep-1'],
    })).rejects.toThrow('depends_on_task_ids must all belong to workspace ws-1');

    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('lists tasks with all filters and heartbeats an active lease', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [task({ status: 'ready' })] });
    queueTaskDetails(task());
    poolQueryMock
      .mockResolvedValueOnce({ rows: [task({ heartbeat_at: '2026-01-01T00:01:00.000Z' })] });
    queueTaskDetails(task({ heartbeat_at: '2026-01-01T00:01:00.000Z' }));

    const { heartbeatTask, listTasks } = await import('./tasks.js');
    await expect(listTasks({
      workspace_id: 'ws-1',
      session_id: 'session-1',
      status: ['ready'],
      owner_agent_name: 'owner',
      handoff_target_agent_name: 'reviewer',
      lease_owner_agent_name: 'agent',
      limit: 5,
      offset: 2,
      access: { kind: 'user', workspaceIds: ['ws-1'] } as never,
    })).resolves.toHaveLength(1);
    await expect(heartbeatTask({ task_id: 'task-1', agent_name: 'agent', lease_seconds: 60 })).resolves.toMatchObject({
      heartbeat_at: '2026-01-01T00:01:00.000Z',
    });

    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('handoff_target_agent_name = $5');
    expect(String(poolQueryMock.mock.calls[4]?.[0])).toContain('lease_expires_at = NOW() + ($3 * INTERVAL');
  });

  it.each([
    ['completeTask', 'done', 'task.completed'],
    ['failTask', 'failed', 'task.failed'],
  ] as const)('updates terminal task state through %s', async (fnName, status, eventType) => {
    queueTaskDetails(task());
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [task()] })
      .mockResolvedValueOnce({ rows: [task({ status, lease_owner_agent_name: null, lease_expires_at: null })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    queueTaskDetails(task({ status, lease_owner_agent_name: null, lease_expires_at: null }));

    const tasksModule = await import('./tasks.js');
    await expect(tasksModule[fnName]({
      task_id: 'task-1',
      agent_name: 'agent',
      blocker_reason: status === 'failed' ? 'blocked' : undefined,
      payload: { ok: status === 'done' },
    } as never)).resolves.toMatchObject({ status });

    expect(clientQueryMock.mock.calls.some(([sql, values]) => String(sql).includes('INSERT INTO task_events') && values[2] === eventType)).toBe(true);
  });

  it('hands off tasks, requires an active claimed lease, and enqueues the target inbox item', async () => {
    queueTaskDetails(task());
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [task({ status: 'handoff_pending', owner_agent_name: 'reviewer', handoff_target_agent_name: 'reviewer' })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    queueTaskDetails(task({ status: 'handoff_pending', owner_agent_name: 'reviewer', handoff_target_agent_name: 'reviewer' }));

    const { handoffTask } = await import('./tasks.js');
    await expect(handoffTask({
      task_id: 'task-1',
      actor_agent_name: 'agent',
      target_agent_name: 'reviewer',
      payload: { note: 'please review' },
    })).resolves.toMatchObject({ handoff_target_agent_name: 'reviewer' });

    expect(clientQueryMock.mock.calls[2]?.[1]?.[1]).toBe('handoff_pending');
    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO agent_inbox'))).toBe(true);
  });

  it('acknowledges tasks and refreshes readiness', async () => {
    queueTaskDetails(task({ status: 'handoff_pending', lease_owner_agent_name: null }));
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [task({ status: 'handoff_pending', lease_owner_agent_name: null })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    queueTaskDetails(task({ status: 'ready', lease_owner_agent_name: null }));

    const { acknowledgeTask } = await import('./tasks.js');
    await expect(acknowledgeTask({ task_id: 'task-1', agent_name: 'reviewer', payload: { ack: true } })).resolves.toMatchObject({
      status: 'ready',
    });

    expect(clientQueryMock.mock.calls[1]?.[1]).toEqual(['task-1', 'reviewer', JSON.stringify({ ack: true })]);
  });

  it('appends task events and rolls back failed inserts', async () => {
    queueTaskDetails(task());
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'event-1', event_type: 'note' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { appendTaskEvent } = await import('./tasks.js');
    await expect(appendTaskEvent({
      task_id: 'task-1',
      event_type: 'note',
      actor_agent_name: 'agent',
      target_agent_name: 'reviewer',
      payload: { text: 'hello' },
    })).resolves.toMatchObject({ id: 'event-1' });

    queueTaskDetails(task());
    clientQueryMock.mockReset();
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(new Error('event insert failed'))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(appendTaskEvent({ task_id: 'task-1', event_type: 'note' })).rejects.toThrow('event insert failed');
    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('lists and acknowledges inbox items', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ id: 'inbox-1', workspace_id: 'ws-1', agent_name: 'agent', read_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'inbox-1', workspace_id: 'ws-1', agent_name: 'agent', read_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'inbox-1', workspace_id: 'ws-1', agent_name: 'agent', read_at: 'now', acknowledged_at: 'now' }] })
      .mockResolvedValueOnce({ rows: [] });

    const { acknowledgeInboxItem, listInbox } = await import('./tasks.js');
    await expect(listInbox({
      workspace_id: 'ws-1',
      agent_name: 'agent',
      unread_only: true,
      limit: 10,
      offset: 5,
      access: { kind: 'user', workspaceIds: ['ws-1'] } as never,
    })).resolves.toHaveLength(1);
    await expect(acknowledgeInboxItem({ id: 'inbox-1', agent_name: 'agent' })).resolves.toMatchObject({ acknowledged_at: 'now' });
    await expect(acknowledgeInboxItem({ id: 'missing', agent_name: 'agent' })).resolves.toBeNull();

    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('read_at IS NULL');
  });
});
