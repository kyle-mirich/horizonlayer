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
  assertWorkspaceReadAccess: vi.fn().mockResolvedValue(undefined),
  assertWorkspaceWriteAccess: vi.fn().mockResolvedValue(undefined),
}));

function buildTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    workspace_id: 'ws-1',
    title: 'Task',
    description: null,
    status: 'ready',
    priority: 100,
    owner_agent_name: null,
    lease_owner_agent_name: null,
    lease_expires_at: '2026-01-01T00:10:00.000Z',
    heartbeat_at: '2026-01-01T00:00:00.000Z',
    revision: 1,
    attempt_count: 0,
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

describe('task query coordination', () => {
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

  it('reclaims expired claimed tasks before selecting from the queue', async () => {
    let releasedExpiredClaims = false;
    const claimedTask = buildTask({
      attempt_count: 1,
      heartbeat_at: '2026-01-01T00:05:00.000Z',
      lease_expires_at: '2026-01-01T00:10:00.000Z',
      lease_owner_agent_name: 'planner',
      owner_agent_name: 'planner',
      revision: 2,
      status: 'claimed',
    });

    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("t.status = 'claimed'") && sql.includes('t.lease_expires_at <= NOW()')) {
        releasedExpiredClaims = true;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("t.status IN ('pending', 'handoff_pending')") || sql.includes("SET status = 'blocked'")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM tasks') && sql.includes("status = 'ready'")) {
        expect(releasedExpiredClaims).toBe(true);
        return { rows: [{ id: 'task-1' }] };
      }
      if (sql === 'SELECT * FROM tasks WHERE id = $1 LIMIT 1') {
        return { rows: [buildTask()] };
      }
      if (sql.includes("SET status = 'claimed'")) {
        return { rows: [claimedTask] };
      }
      if (sql.includes('INSERT INTO task_events')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT * FROM tasks WHERE id = $1 LIMIT 1') {
        return { rows: [claimedTask] };
      }
      if (sql.includes('SELECT agent_name FROM task_acknowledgements')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT depends_on_task_id FROM task_dependencies')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    });

    const { claimTask } = await import('./tasks.js');
    const task = await claimTask({
      agent_name: 'planner',
      workspace_id: 'ws-1',
    });

    expect(task?.status).toBe('claimed');
    expect(releasedExpiredClaims).toBe(true);
    expect(releaseMock).toHaveBeenCalled();
  });

  it('refuses to claim tasks that have exhausted max_attempts', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (
        sql.includes("t.status = 'claimed'") ||
        sql.includes("t.status IN ('pending', 'handoff_pending')") ||
        sql.includes("SET status = 'blocked'")
      ) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM tasks') && sql.includes('workspace_id = $2') && sql.includes('FOR UPDATE')) {
        return {
          rows: [
            buildTask({
              attempt_count: 3,
              max_attempts: 3,
            }),
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { claimTask } = await import('./tasks.js');
    const task = await claimTask({
      agent_name: 'planner',
      task_id: 'task-1',
      workspace_id: 'ws-1',
    });

    expect(task).toBeNull();
    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes("SET status = 'claimed'"))).toBe(false);
  });

  it('requires the active lease owner to complete a task', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT * FROM tasks WHERE id = $1 LIMIT 1') {
        return {
          rows: [
            buildTask({
              status: 'claimed',
              lease_owner_agent_name: 'worker-a',
              owner_agent_name: 'worker-a',
              lease_expires_at: '2099-01-01T00:00:00.000Z',
            }),
          ],
        };
      }
      if (sql.includes('SELECT agent_name FROM task_acknowledgements')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT depends_on_task_id FROM task_dependencies')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    });

    const { completeTask } = await import('./tasks.js');
    await expect(
      completeTask({
        agent_name: 'worker-b',
        task_id: 'task-1',
      })
    ).rejects.toThrow('Task task-1 is not actively leased by worker-b');
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rejects delayed completion after another agent has reclaimed the task', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT * FROM tasks WHERE id = $1 LIMIT 1') {
        return {
          rows: [
            buildTask({
              status: 'claimed',
              lease_owner_agent_name: 'worker-a',
              owner_agent_name: 'worker-a',
              lease_expires_at: '2099-01-01T00:00:00.000Z',
            }),
          ],
        };
      }
      if (sql.includes('SELECT agent_name FROM task_acknowledgements')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT depends_on_task_id FROM task_dependencies')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    });

    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'SELECT * FROM tasks WHERE id = $1 LIMIT 1') {
        return {
          rows: [
            buildTask({
              status: 'claimed',
              lease_owner_agent_name: 'worker-b',
              owner_agent_name: 'worker-b',
              lease_expires_at: '2099-01-01T00:00:00.000Z',
              revision: 2,
            }),
          ],
        };
      }
      if (sql.includes('UPDATE tasks')) {
        throw new Error('terminal update should not run after lease ownership changes');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { completeTask } = await import('./tasks.js');
    await expect(
      completeTask({
        agent_name: 'worker-a',
        task_id: 'task-1',
      })
    ).rejects.toThrow('Task task-1 is not actively leased by worker-a');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('rejects heartbeats after the task lease has expired', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT * FROM tasks WHERE id = $1 LIMIT 1') {
        return {
          rows: [
            buildTask({
              status: 'claimed',
              lease_owner_agent_name: 'worker-a',
              owner_agent_name: 'worker-a',
              lease_expires_at: '2000-01-01T00:00:00.000Z',
            }),
          ],
        };
      }
      if (sql.includes('SELECT agent_name FROM task_acknowledgements')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT depends_on_task_id FROM task_dependencies')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    });

    const { heartbeatTask } = await import('./tasks.js');
    await expect(
      heartbeatTask({
        agent_name: 'worker-a',
        task_id: 'task-1',
      })
    ).rejects.toThrow('Task task-1 lease held by worker-a has expired');
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rejects handoff attempts from a non-owner on claimed tasks', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT * FROM tasks WHERE id = $1 LIMIT 1') {
        return {
          rows: [
            buildTask({
              status: 'claimed',
              lease_owner_agent_name: 'worker-a',
              owner_agent_name: 'worker-a',
              lease_expires_at: '2099-01-01T00:00:00.000Z',
            }),
          ],
        };
      }
      if (sql.includes('SELECT agent_name FROM task_acknowledgements')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT depends_on_task_id FROM task_dependencies')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    });

    const { handoffTask } = await import('./tasks.js');
    await expect(
      handoffTask({
        actor_agent_name: 'worker-b',
        target_agent_name: 'worker-c',
        task_id: 'task-1',
      })
    ).rejects.toThrow('Task task-1 is not actively leased by worker-b');
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rejects cross-workspace task dependencies during creation', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM tasks') && sql.includes('workspace_id = $2')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO tasks')) {
        throw new Error('task should not be inserted when dependency scope validation fails');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { createTask } = await import('./tasks.js');
    await expect(
      createTask({
        depends_on_task_ids: ['task-foreign'],
        title: 'Task',
        workspace_id: 'ws-1',
      })
    ).rejects.toThrow('depends_on_task_ids must all belong to workspace ws-1');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('rejects task creation when a dependency already participates in a cycle', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM tasks') && sql.includes('workspace_id = $2')) {
        return { rows: [{ id: 'task-a' }] };
      }
      if (sql.includes('WITH RECURSIVE dependency_walk')) {
        return { rows: [{ start_id: 'task-a' }] };
      }
      if (sql.includes('INSERT INTO tasks')) {
        throw new Error('task should not be inserted when dependency cycle validation fails');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { createTask } = await import('./tasks.js');
    await expect(
      createTask({
        depends_on_task_ids: ['task-a'],
        title: 'Task',
        workspace_id: 'ws-1',
      })
    ).rejects.toThrow('depends_on_task_ids cannot include tasks that participate in dependency cycles');
    expect(releaseMock).toHaveBeenCalled();
  });
});
