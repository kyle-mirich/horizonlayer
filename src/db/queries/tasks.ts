import { isSystemAccess, type AccessContext } from '../access.js';
import { getPool, type PoolClient } from '../client.js';
import {
  assertSessionReadAccess,
  assertSessionWriteAccess,
  assertWorkspaceReadAccess,
  assertWorkspaceWriteAccess,
} from './accessControl.js';
import { touchSession } from './sessions.js';

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'claimed'
  | 'blocked'
  | 'handoff_pending'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface Task {
  id: string;
  workspace_id: string;
  session_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  owner_agent_name: string | null;
  lease_owner_agent_name: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  revision: number;
  attempt_count: number;
  max_attempts: number;
  handoff_target_agent_name: string | null;
  blocker_reason: string | null;
  required_ack_agent_names: string[];
  metadata: Record<string, unknown>;
  created_by_agent_name: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  last_event_at: string;
  created_at: string;
  updated_at: string;
}

export interface TaskDetails extends Task {
  acknowledged_agent_names: string[];
  depends_on_task_ids: string[];
}

export interface TaskEvent {
  id: string;
  workspace_id: string;
  task_id: string | null;
  event_type: string;
  actor_agent_name: string | null;
  target_agent_name: string | null;
  task_revision: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface InboxItem {
  id: string;
  workspace_id: string;
  agent_name: string;
  task_id: string | null;
  kind: string;
  actor_agent_name: string | null;
  payload: Record<string, unknown>;
  read_at: string | null;
  acknowledged_at: string | null;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;
const MAX_ATTEMPTS_BLOCKER_REASON = 'Maximum attempts exhausted';
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(['done', 'failed', 'cancelled']);

function ensureWorkspaceAccess(
  workspaceId: string,
  access: AccessContext,
  mode: 'read' | 'write'
): Promise<void> {
  return mode === 'read'
    ? assertWorkspaceReadAccess(workspaceId, access)
    : assertWorkspaceWriteAccess(workspaceId, access);
}

async function ensureSessionMatchesWorkspace(
  sessionId: string,
  workspaceId: string,
  access: AccessContext,
  mode: 'read' | 'write'
): Promise<void> {
  const session = mode === 'read'
    ? await assertSessionReadAccess(sessionId, access)
    : await assertSessionWriteAccess(sessionId, access);
  if (session.workspace_id !== workspaceId) {
    throw new Error(`session_id must belong to workspace ${workspaceId}`);
  }
}

function deriveInitialTaskStatus(params: {
  depends_on_task_ids?: string[];
  required_ack_agent_names?: string[];
}): TaskStatus {
  if ((params.required_ack_agent_names?.length ?? 0) > 0) {
    return 'handoff_pending';
  }
  if ((params.depends_on_task_ids?.length ?? 0) > 0) {
    return 'pending';
  }
  return 'ready';
}

function hasLeaseExpired(leaseExpiresAt: string | null): boolean {
  return leaseExpiresAt == null || new Date(leaseExpiresAt).getTime() <= Date.now();
}

function assertActiveTaskLease(
  task: Pick<Task, 'id' | 'status' | 'lease_owner_agent_name' | 'lease_expires_at'>,
  agentName: string,
  action: string
): void {
  if (task.status !== 'claimed') {
    throw new Error(`Task ${task.id} is not claimed, cannot ${action}`);
  }
  if (task.lease_owner_agent_name !== agentName) {
    throw new Error(`Task ${task.id} is not actively leased by ${agentName}`);
  }
  if (hasLeaseExpired(task.lease_expires_at)) {
    throw new Error(`Task ${task.id} lease held by ${agentName} has expired`);
  }
}

function assertTaskCanHandoff(task: TaskDetails, actorAgentName?: string): void {
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    throw new Error(`Task ${task.id} is already ${task.status}, cannot handoff`);
  }
  if (task.status === 'claimed') {
    if (!actorAgentName) {
      throw new Error('actor_agent_name is required to hand off a claimed task');
    }
    assertActiveTaskLease(task, actorAgentName, 'handoff');
  }
}

async function assertTaskIdsInWorkspace(
  client: Queryable,
  taskIds: string[],
  workspaceId: string,
  fieldName: string
): Promise<void> {
  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length === 0) {
    return;
  }

  const { rows } = await client.query<{ id: string }>(
    `SELECT id
     FROM tasks
     WHERE id = ANY($1)
       AND workspace_id = $2`,
    [uniqueTaskIds, workspaceId]
  );

  if (rows.length !== uniqueTaskIds.length) {
    throw new Error(`${fieldName} must all belong to workspace ${workspaceId}`);
  }
}

async function assertTaskDependenciesAcyclic(
  client: Queryable,
  taskIds: string[],
  workspaceId: string,
  fieldName: string
): Promise<void> {
  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length === 0) {
    return;
  }

  const { rows } = await client.query<{ start_id: string }>(
    `WITH RECURSIVE dependency_walk AS (
       SELECT td.task_id AS start_id,
              td.depends_on_task_id AS current_id,
              ARRAY[td.task_id, td.depends_on_task_id]::uuid[] AS path,
              td.depends_on_task_id = td.task_id AS has_cycle
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.task_id
       JOIN tasks dep ON dep.id = td.depends_on_task_id
       WHERE td.task_id = ANY($1)
         AND t.workspace_id = $2
         AND dep.workspace_id = $2

       UNION ALL

       SELECT walk.start_id,
              td.depends_on_task_id AS current_id,
              walk.path || td.depends_on_task_id,
              td.depends_on_task_id = ANY(walk.path) AS has_cycle
       FROM dependency_walk walk
       JOIN task_dependencies td ON td.task_id = walk.current_id
       JOIN tasks dep ON dep.id = td.depends_on_task_id
       WHERE dep.workspace_id = $2
         AND NOT walk.has_cycle
     )
     SELECT DISTINCT start_id
     FROM dependency_walk
     WHERE has_cycle`,
    [uniqueTaskIds, workspaceId]
  );

  if (rows.length > 0) {
    throw new Error(`${fieldName} cannot include tasks that participate in dependency cycles`);
  }
}

async function insertTaskEvent(
  client: Queryable,
  params: {
    workspace_id: string;
    task_id?: string | null;
    event_type: string;
    actor_agent_name?: string | null;
    target_agent_name?: string | null;
    task_revision?: number | null;
    payload?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO task_events (
       workspace_id,
       task_id,
       event_type,
       actor_agent_name,
       target_agent_name,
       task_revision,
       payload
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.workspace_id,
      params.task_id ?? null,
      params.event_type,
      params.actor_agent_name ?? null,
      params.target_agent_name ?? null,
      params.task_revision ?? null,
      JSON.stringify(params.payload ?? {}),
    ]
  );
}

async function enqueueInboxItem(
  client: Queryable,
  params: {
    workspace_id: string;
    agent_name: string;
    task_id?: string | null;
    kind: string;
    actor_agent_name?: string | null;
    payload?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO agent_inbox (
       workspace_id,
       agent_name,
       task_id,
       kind,
       actor_agent_name,
       payload
     )
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.workspace_id,
      params.agent_name,
      params.task_id ?? null,
      params.kind,
      params.actor_agent_name ?? null,
      JSON.stringify(params.payload ?? {}),
    ]
  );
}

async function refreshReadyTasks(client: Queryable, workspaceId: string): Promise<void> {
  await client.query(
    `UPDATE tasks t
     SET status = 'ready',
         lease_owner_agent_name = NULL,
         lease_expires_at = NULL,
         heartbeat_at = NULL,
         updated_at = NOW(),
         last_event_at = NOW(),
         revision = revision + 1
     WHERE t.workspace_id = $1
       AND t.status = 'claimed'
       AND t.lease_expires_at IS NOT NULL
       AND t.lease_expires_at <= NOW()`,
    [workspaceId]
  );

  await client.query(
    `UPDATE tasks t
     SET status = 'ready',
         updated_at = NOW(),
         last_event_at = NOW(),
         revision = revision + 1
     WHERE t.workspace_id = $1
       AND t.status IN ('pending', 'handoff_pending')
       AND NOT EXISTS (
         SELECT 1
         FROM task_dependencies td
         JOIN tasks dep ON dep.id = td.depends_on_task_id
         WHERE td.task_id = t.id
           AND dep.status <> 'done'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM unnest(t.required_ack_agent_names) AS required(agent_name)
         WHERE NOT EXISTS (
           SELECT 1
           FROM task_acknowledgements ta
           WHERE ta.task_id = t.id
             AND ta.agent_name = required.agent_name
         )
       )`,
    [workspaceId]
  );

  await client.query(
    `UPDATE tasks t
     SET status = 'blocked',
         blocker_reason = COALESCE(NULLIF(t.blocker_reason, ''), $2),
         updated_at = NOW(),
         last_event_at = NOW(),
         revision = revision + 1
     WHERE t.workspace_id = $1
       AND t.status = 'ready'
       AND t.attempt_count >= t.max_attempts`,
    [workspaceId, MAX_ATTEMPTS_BLOCKER_REASON]
  );
}

async function getTaskDetailsById(client: Queryable, taskId: string): Promise<TaskDetails | null> {
  const { rows } = await client.query<Task>(
    'SELECT * FROM tasks WHERE id = $1 LIMIT 1',
    [taskId]
  );
  const task = rows[0];
  if (!task) {
    return null;
  }

  const [ackRows, dependencyRows] = await Promise.all([
    client.query<{ agent_name: string }>(
      'SELECT agent_name FROM task_acknowledgements WHERE task_id = $1 ORDER BY agent_name ASC',
      [taskId]
    ),
    client.query<{ depends_on_task_id: string }>(
      'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1 ORDER BY depends_on_task_id ASC',
      [taskId]
    ),
  ]);

  return {
    ...task,
    acknowledged_agent_names: ackRows.rows.map((row) => row.agent_name),
    depends_on_task_ids: dependencyRows.rows.map((row) => row.depends_on_task_id),
  };
}

async function getTaskForMutation(
  client: Queryable,
  taskId: string
): Promise<Task | null> {
  const { rows } = await client.query<Task>(
    'SELECT * FROM tasks WHERE id = $1 LIMIT 1',
    [taskId]
  );
  return rows[0] ?? null;
}

export async function createTask(params: {
  workspace_id: string;
  session_id?: string;
  title: string;
  description?: string;
  priority?: number;
  owner_agent_name?: string;
  max_attempts?: number;
  metadata?: Record<string, unknown>;
  created_by_agent_name?: string;
  depends_on_task_ids?: string[];
  required_ack_agent_names?: string[];
  access?: AccessContext;
}): Promise<TaskDetails> {
  const access = params.access ?? { kind: 'system' as const };
  await ensureWorkspaceAccess(params.workspace_id, access, 'write');
  if (params.session_id) {
    await ensureSessionMatchesWorkspace(params.session_id, params.workspace_id, access, 'write');
  }
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await assertTaskIdsInWorkspace(
      client,
      params.depends_on_task_ids ?? [],
      params.workspace_id,
      'depends_on_task_ids'
    );
    await assertTaskDependenciesAcyclic(
      client,
      params.depends_on_task_ids ?? [],
      params.workspace_id,
      'depends_on_task_ids'
    );
    const status = deriveInitialTaskStatus(params);
    const { rows } = await client.query<Task>(
      `INSERT INTO tasks (
         workspace_id,
         session_id,
         title,
         description,
         status,
         priority,
         owner_agent_name,
         max_attempts,
         required_ack_agent_names,
         metadata,
         created_by_agent_name
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        params.workspace_id,
        params.session_id ?? null,
        params.title,
        params.description ?? null,
        status,
        params.priority ?? 100,
        params.owner_agent_name ?? null,
        params.max_attempts ?? 3,
        params.required_ack_agent_names ?? [],
        JSON.stringify(params.metadata ?? {}),
        params.created_by_agent_name ?? null,
      ]
    );

    const task = rows[0];
    for (const dependencyId of [...new Set(params.depends_on_task_ids ?? [])]) {
      await client.query(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id)
         VALUES ($1, $2)
         ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
        [task.id, dependencyId]
      );
    }

    await insertTaskEvent(client, {
      workspace_id: task.workspace_id,
      task_id: task.id,
      event_type: 'task.created',
      actor_agent_name: params.created_by_agent_name ?? params.owner_agent_name ?? null,
      target_agent_name: task.owner_agent_name,
      task_revision: task.revision,
      payload: {
        status: task.status,
      },
    });

    if (task.owner_agent_name) {
      await enqueueInboxItem(client, {
        workspace_id: task.workspace_id,
        agent_name: task.owner_agent_name,
        task_id: task.id,
        kind: 'task_assigned',
        actor_agent_name: params.created_by_agent_name ?? null,
        payload: {
          title: task.title,
        },
      });
    }

    await refreshReadyTasks(client, task.workspace_id);
    await touchSession(task.session_id, client);
    await client.query('COMMIT');

    const result = await getTaskDetailsById(pool, task.id);
    if (!result) {
      throw new Error(`Task ${task.id} not found after creation`);
    }
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getTask(
  taskId: string,
  access: AccessContext = { kind: 'system' }
): Promise<TaskDetails | null> {
  const pool = getPool();
  const task = await getTaskDetailsById(pool, taskId);
  if (!task) {
    return null;
  }
  if (!isSystemAccess(access)) {
    await ensureWorkspaceAccess(task.workspace_id, access, 'read');
  }
  return task;
}

export async function listTasks(params: {
  workspace_id: string;
  session_id?: string;
  status?: TaskStatus[];
  owner_agent_name?: string;
  handoff_target_agent_name?: string;
  lease_owner_agent_name?: string;
  limit?: number;
  offset?: number;
  access?: AccessContext;
}): Promise<Task[]> {
  const access = params.access ?? { kind: 'system' as const };
  await ensureWorkspaceAccess(params.workspace_id, access, 'read');
  if (params.session_id) {
    await ensureSessionMatchesWorkspace(params.session_id, params.workspace_id, access, 'read');
  }
  const pool = getPool();

  const conditions = ['workspace_id = $1'];
  const values: unknown[] = [params.workspace_id];
  let idx = 2;

  if (params.session_id) {
    conditions.push(`session_id = $${idx++}`);
    values.push(params.session_id);
  }

  if (params.status && params.status.length > 0) {
    conditions.push(`status = ANY($${idx++})`);
    values.push(params.status);
  }
  if (params.owner_agent_name) {
    conditions.push(`owner_agent_name = $${idx++}`);
    values.push(params.owner_agent_name);
  }
  if (params.handoff_target_agent_name) {
    conditions.push(`handoff_target_agent_name = $${idx++}`);
    values.push(params.handoff_target_agent_name);
  }
  if (params.lease_owner_agent_name) {
    conditions.push(`lease_owner_agent_name = $${idx++}`);
    values.push(params.lease_owner_agent_name);
  }

  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const { rows } = await pool.query<Task>(
    `SELECT *
     FROM tasks
     WHERE ${conditions.join(' AND ')}
     ORDER BY priority ASC, created_at ASC
     LIMIT ${limit}
     OFFSET ${offset}`,
    values
  );
  return rows;
}

export async function claimTask(params: {
  workspace_id: string;
  session_id?: string;
  agent_name: string;
  task_id?: string;
  lease_seconds?: number;
  access?: AccessContext;
}): Promise<TaskDetails | null> {
  const access = params.access ?? { kind: 'system' as const };
  await ensureWorkspaceAccess(params.workspace_id, access, 'write');
  if (params.session_id) {
    await ensureSessionMatchesWorkspace(params.session_id, params.workspace_id, access, 'write');
  }
  const pool = getPool();
  const client = await pool.connect();
  const leaseSeconds = params.lease_seconds ?? 300;

  try {
    await client.query('BEGIN');
    await refreshReadyTasks(client, params.workspace_id);

    let task: Task | null = null;
    if (params.task_id) {
      const { rows } = await client.query<Task>(
        `SELECT *
         FROM tasks
         WHERE id = $1
           AND workspace_id = $2${params.session_id ? ' AND session_id = $3' : ''}
         LIMIT 1
         FOR UPDATE`,
        params.session_id
          ? [params.task_id, params.workspace_id, params.session_id]
          : [params.task_id, params.workspace_id]
      );
      task = rows[0] ?? null;
    } else {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id
         FROM tasks
         WHERE workspace_id = $1
           AND status = 'ready'${params.session_id ? ' AND session_id = $2' : ''}
         ORDER BY priority ASC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        params.session_id ? [params.workspace_id, params.session_id] : [params.workspace_id]
      );
      task = rows[0] ? await getTaskForMutation(client, rows[0].id) : null;
    }

    if (!task) {
      await client.query('ROLLBACK');
      return null;
    }

    const leaseExpired = hasLeaseExpired(task.lease_expires_at);
    const leaseAvailable = task.status === 'ready'
      || (task.status === 'claimed'
        && (task.lease_owner_agent_name === params.agent_name || leaseExpired));

    if (!leaseAvailable || task.attempt_count >= task.max_attempts) {
      await client.query('ROLLBACK');
      return null;
    }

    const { rows } = await client.query<Task>(
      `UPDATE tasks
       SET status = 'claimed',
           owner_agent_name = $2,
           lease_owner_agent_name = $2,
           lease_expires_at = NOW() + ($3 * INTERVAL '1 second'),
           heartbeat_at = NOW(),
           attempt_count = attempt_count + 1,
           revision = revision + 1,
           updated_at = NOW(),
           last_event_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [task.id, params.agent_name, leaseSeconds]
    );

    const claimed = rows[0];
    await insertTaskEvent(client, {
      workspace_id: claimed.workspace_id,
      task_id: claimed.id,
      event_type: 'task.claimed',
      actor_agent_name: params.agent_name,
      task_revision: claimed.revision,
      payload: {
        lease_seconds: leaseSeconds,
      },
    });

    await touchSession(claimed.session_id, client);
    await client.query('COMMIT');

    return getTaskDetailsById(pool, claimed.id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function heartbeatTask(params: {
  task_id: string;
  agent_name: string;
  lease_seconds?: number;
  access?: AccessContext;
}): Promise<TaskDetails | null> {
  const access = params.access ?? { kind: 'system' as const };
  const current = await getTask(params.task_id, access);
  if (!current) {
    return null;
  }
  assertActiveTaskLease(current, params.agent_name, 'heartbeat');
  await ensureWorkspaceAccess(current.workspace_id, access, 'write');
  const pool = getPool();
  const leaseSeconds = params.lease_seconds ?? 300;
  const { rows } = await pool.query<Task>(
    `UPDATE tasks
     SET heartbeat_at = NOW(),
         lease_expires_at = NOW() + ($3 * INTERVAL '1 second'),
         updated_at = NOW()
     WHERE id = $1
       AND status = 'claimed'
       AND lease_owner_agent_name = $2
     RETURNING *`,
    [params.task_id, params.agent_name, leaseSeconds]
  );
  if (!rows[0]) {
    return null;
  }
  return getTaskDetailsById(pool, params.task_id);
}

async function updateTerminalTaskStatus(params: {
  task_id: string;
  actor_agent_name: string;
  event_type: string;
  status: Extract<TaskStatus, 'done' | 'failed' | 'cancelled' | 'blocked'>;
  blocker_reason?: string | null;
  payload?: Record<string, unknown>;
  access?: AccessContext;
}): Promise<TaskDetails | null> {
  const access = params.access ?? { kind: 'system' as const };
  const current = await getTask(params.task_id, access);
  if (!current) {
    return null;
  }
  assertActiveTaskLease(current, params.actor_agent_name, params.status === 'done' ? 'complete' : 'fail');
  await ensureWorkspaceAccess(current.workspace_id, access, 'write');
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const lockedTask = await getTaskForMutation(client, params.task_id);
    if (!lockedTask) {
      await client.query('ROLLBACK');
      return null;
    }
    assertActiveTaskLease(lockedTask, params.actor_agent_name, params.status === 'done' ? 'complete' : 'fail');

    const timestampColumn =
      params.status === 'done'
        ? 'completed_at'
        : params.status === 'failed'
          ? 'failed_at'
          : params.status === 'cancelled'
            ? 'cancelled_at'
            : null;
    const { rows } = await client.query<Task>(
      `UPDATE tasks
       SET status = $2,
           lease_owner_agent_name = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           blocker_reason = $3,
           revision = revision + 1,
           updated_at = NOW(),
           last_event_at = NOW()
           ${timestampColumn ? `, ${timestampColumn} = NOW()` : ''}
       WHERE id = $1
       RETURNING *`,
      [params.task_id, params.status, params.blocker_reason ?? null]
    );

    const task = rows[0];
    await insertTaskEvent(client, {
      workspace_id: task.workspace_id,
      task_id: task.id,
      event_type: params.event_type,
      actor_agent_name: params.actor_agent_name ?? null,
      task_revision: task.revision,
      payload: params.payload,
    });
    await refreshReadyTasks(client, task.workspace_id);
    await touchSession(task.session_id, client);
    await client.query('COMMIT');
    return getTaskDetailsById(pool, task.id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeTask(params: {
  task_id: string;
  agent_name: string;
  payload?: Record<string, unknown>;
  access?: AccessContext;
}): Promise<TaskDetails | null> {
  return updateTerminalTaskStatus({
    ...params,
    actor_agent_name: params.agent_name,
    event_type: 'task.completed',
    status: 'done',
  });
}

export async function failTask(params: {
  task_id: string;
  agent_name: string;
  blocker_reason?: string;
  payload?: Record<string, unknown>;
  access?: AccessContext;
}): Promise<TaskDetails | null> {
  return updateTerminalTaskStatus({
    ...params,
    actor_agent_name: params.agent_name,
    event_type: 'task.failed',
    status: 'failed',
    blocker_reason: params.blocker_reason,
  });
}

export async function handoffTask(params: {
  task_id: string;
  actor_agent_name?: string;
  target_agent_name: string;
  require_ack?: boolean;
  payload?: Record<string, unknown>;
  access?: AccessContext;
}): Promise<TaskDetails | null> {
  const access = params.access ?? { kind: 'system' as const };
  const current = await getTask(params.task_id, access);
  if (!current) {
    return null;
  }
  assertTaskCanHandoff(current, params.actor_agent_name);
  await ensureWorkspaceAccess(current.workspace_id, access, 'write');
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM task_acknowledgements WHERE task_id = $1', [params.task_id]);
    const requiredAckAgentNames = params.require_ack === false ? [] : [params.target_agent_name];
    const { rows } = await client.query<Task>(
      `UPDATE tasks
       SET status = $2,
           owner_agent_name = $3,
           handoff_target_agent_name = $3,
           required_ack_agent_names = $4,
           lease_owner_agent_name = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           revision = revision + 1,
           updated_at = NOW(),
           last_event_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        params.task_id,
        requiredAckAgentNames.length > 0 ? 'handoff_pending' : 'ready',
        params.target_agent_name,
        requiredAckAgentNames,
      ]
    );
    const task = rows[0];

    await insertTaskEvent(client, {
      workspace_id: task.workspace_id,
      task_id: task.id,
      event_type: 'task.handoff',
      actor_agent_name: params.actor_agent_name ?? null,
      target_agent_name: params.target_agent_name,
      task_revision: task.revision,
      payload: params.payload,
    });
    await enqueueInboxItem(client, {
      workspace_id: task.workspace_id,
      agent_name: params.target_agent_name,
      task_id: task.id,
      kind: 'task_handoff',
      actor_agent_name: params.actor_agent_name ?? null,
      payload: params.payload,
    });

    await refreshReadyTasks(client, task.workspace_id);
    await touchSession(task.session_id, client);
    await client.query('COMMIT');
    return getTaskDetailsById(pool, task.id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function acknowledgeTask(params: {
  task_id: string;
  agent_name: string;
  payload?: Record<string, unknown>;
  access?: AccessContext;
}): Promise<TaskDetails | null> {
  const access = params.access ?? { kind: 'system' as const };
  const current = await getTask(params.task_id, access);
  if (!current) {
    return null;
  }
  await ensureWorkspaceAccess(current.workspace_id, access, 'write');
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO task_acknowledgements (task_id, agent_name, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (task_id, agent_name) DO UPDATE SET
         acknowledged_at = NOW(),
         payload = EXCLUDED.payload`,
      [params.task_id, params.agent_name, JSON.stringify(params.payload ?? {})]
    );
    const task = await getTaskForMutation(client, params.task_id);
    if (!task) {
      throw new Error(`Task ${params.task_id} not found`);
    }
    await insertTaskEvent(client, {
      workspace_id: task.workspace_id,
      task_id: task.id,
      event_type: 'task.acknowledged',
      actor_agent_name: params.agent_name,
      task_revision: task.revision,
      payload: params.payload,
    });
    await refreshReadyTasks(client, task.workspace_id);
    await touchSession(task.session_id, client);
    await client.query('COMMIT');
    return getTaskDetailsById(pool, task.id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function appendTaskEvent(params: {
  task_id: string;
  event_type: string;
  actor_agent_name?: string;
  target_agent_name?: string;
  payload?: Record<string, unknown>;
  access?: AccessContext;
}): Promise<TaskEvent> {
  const access = params.access ?? { kind: 'system' as const };
  const task = await getTask(params.task_id, access);
  if (!task) {
    throw new Error(`Task ${params.task_id} not found`);
  }
  await ensureWorkspaceAccess(task.workspace_id, access, 'write');
  const pool = getPool();
  const { rows } = await pool.query<TaskEvent>(
    `INSERT INTO task_events (
       workspace_id,
       task_id,
       event_type,
       actor_agent_name,
       target_agent_name,
       task_revision,
       payload
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      task.workspace_id,
      task.id,
      params.event_type,
      params.actor_agent_name ?? null,
      params.target_agent_name ?? null,
      task.revision,
      JSON.stringify(params.payload ?? {}),
    ]
  );
  await pool.query(
    `UPDATE tasks
     SET last_event_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [task.id]
  );
  await touchSession(task.session_id);
  return rows[0];
}

export async function listInbox(params: {
  workspace_id: string;
  agent_name: string;
  unread_only?: boolean;
  limit?: number;
  offset?: number;
  access?: AccessContext;
}): Promise<InboxItem[]> {
  const access = params.access ?? { kind: 'system' as const };
  await ensureWorkspaceAccess(params.workspace_id, access, 'read');
  const pool = getPool();
  const values: unknown[] = [params.workspace_id, params.agent_name];
  const conditions = ['workspace_id = $1', 'agent_name = $2'];
  if (params.unread_only) {
    conditions.push('read_at IS NULL');
  }
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const { rows } = await pool.query<InboxItem>(
    `SELECT *
     FROM agent_inbox
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT ${limit}
     OFFSET ${offset}`,
    values
  );
  return rows;
}

export async function acknowledgeInboxItem(params: {
  id: string;
  agent_name: string;
  access?: AccessContext;
}): Promise<InboxItem | null> {
  const access = params.access ?? { kind: 'system' as const };
  const pool = getPool();
  const { rows: inboxRows } = await pool.query<InboxItem>(
    'SELECT * FROM agent_inbox WHERE id = $1 AND agent_name = $2 LIMIT 1',
    [params.id, params.agent_name]
  );
  const item = inboxRows[0];
  if (!item) {
    return null;
  }
  await ensureWorkspaceAccess(item.workspace_id, access, 'read');

  const { rows } = await pool.query<InboxItem>(
    `UPDATE agent_inbox
     SET read_at = COALESCE(read_at, NOW()),
         acknowledged_at = NOW()
     WHERE id = $1
       AND agent_name = $2
     RETURNING *`,
    [params.id, params.agent_name]
  );
  return rows[0] ?? null;
}
