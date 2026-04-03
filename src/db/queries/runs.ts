import { isSystemAccess, type AccessContext } from '../access.js';
import { getPool, type PoolClient } from '../client.js';
import {
  assertSessionReadAccess,
  assertSessionWriteAccess,
  assertWorkspaceReadAccess,
  assertWorkspaceWriteAccess,
} from './accessControl.js';
import { touchSession } from './sessions.js';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentRun {
  id: string;
  workspace_id: string;
  session_id: string | null;
  task_id: string | null;
  parent_run_id: string | null;
  agent_name: string;
  title: string | null;
  status: RunStatus;
  metadata: Record<string, unknown>;
  result: Record<string, unknown>;
  error_message: string | null;
  latest_checkpoint_sequence: number;
  latest_checkpoint_at: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunCheckpoint {
  id: string;
  run_id: string;
  sequence: number;
  summary: string | null;
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AgentRunDetails extends AgentRun {
  checkpoints: RunCheckpoint[];
}

type Queryable = Pick<PoolClient, 'query'>;

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

function assertRunIsRunning(run: AgentRun, action: 'checkpoint' | 'complete' | 'fail' | 'cancel'): void {
  if (run.status !== 'running') {
    throw new Error(`Run ${run.id} is already ${run.status}, cannot ${action}`);
  }
}

async function getRunById(client: Queryable, runId: string): Promise<AgentRun | null> {
  const { rows } = await client.query<AgentRun>(
    'SELECT * FROM agent_runs WHERE id = $1 LIMIT 1',
    [runId]
  );
  return rows[0] ?? null;
}

async function listRunCheckpoints(client: Queryable, runId: string): Promise<RunCheckpoint[]> {
  const { rows } = await client.query<RunCheckpoint>(
    `SELECT *
     FROM run_checkpoints
     WHERE run_id = $1
     ORDER BY sequence ASC`,
    [runId]
  );
  return rows;
}

async function getRunDetailsById(client: Queryable, runId: string): Promise<AgentRunDetails | null> {
  const run = await getRunById(client, runId);
  if (!run) {
    return null;
  }
  const checkpoints = await listRunCheckpoints(client, runId);
  return {
    ...run,
    checkpoints,
  };
}

async function assertTaskReferenceMatchesScope(
  taskId: string,
  workspaceId: string,
  sessionId?: string
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ session_id: string | null; workspace_id: string }>(
    `SELECT workspace_id, session_id
     FROM tasks
     WHERE id = $1
     LIMIT 1`,
    [taskId]
  );
  const task = rows[0];
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  if (task.workspace_id !== workspaceId) {
    throw new Error(`task_id must belong to workspace ${workspaceId}`);
  }
  if ((task.session_id ?? null) !== (sessionId ?? null)) {
    throw new Error('task_id must belong to the requested session');
  }
}

async function assertParentRunMatchesScope(
  parentRunId: string,
  workspaceId: string,
  sessionId?: string
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ session_id: string | null; workspace_id: string }>(
    `SELECT workspace_id, session_id
     FROM agent_runs
     WHERE id = $1
     LIMIT 1`,
    [parentRunId]
  );
  const parentRun = rows[0];
  if (!parentRun) {
    throw new Error(`Run ${parentRunId} not found`);
  }
  if (parentRun.workspace_id !== workspaceId) {
    throw new Error(`parent_run_id must belong to workspace ${workspaceId}`);
  }
  if ((parentRun.session_id ?? null) !== (sessionId ?? null)) {
    throw new Error('parent_run_id must belong to the requested session');
  }
}

export async function startRun(params: {
  workspace_id: string;
  session_id?: string;
  agent_name: string;
  task_id?: string;
  parent_run_id?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  access?: AccessContext;
}): Promise<AgentRunDetails> {
  const access = params.access ?? { kind: 'system' as const };
  await ensureWorkspaceAccess(params.workspace_id, access, 'write');
  if (params.session_id) {
    await ensureSessionMatchesWorkspace(params.session_id, params.workspace_id, access, 'write');
  }
  if (params.task_id) {
    await assertTaskReferenceMatchesScope(params.task_id, params.workspace_id, params.session_id);
  }
  if (params.parent_run_id) {
    await assertParentRunMatchesScope(params.parent_run_id, params.workspace_id, params.session_id);
  }
  const pool = getPool();
  const { rows } = await pool.query<AgentRun>(
    `INSERT INTO agent_runs (
       workspace_id,
       session_id,
       task_id,
       parent_run_id,
       agent_name,
       title,
       metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.workspace_id,
      params.session_id ?? null,
      params.task_id ?? null,
      params.parent_run_id ?? null,
      params.agent_name,
      params.title ?? null,
      JSON.stringify(params.metadata ?? {}),
    ]
  );
  const run = rows[0];
  await touchSession(run.session_id);
  return {
    ...run,
    checkpoints: [],
  };
}

export async function getRun(
  runId: string,
  access: AccessContext = { kind: 'system' },
  session_id?: string
): Promise<AgentRunDetails | null> {
  const pool = getPool();
  const run = await getRunDetailsById(pool, runId);
  if (!run) {
    return null;
  }
  if (session_id && run.session_id !== session_id) {
    return null;
  }
  if (!isSystemAccess(access)) {
    await ensureWorkspaceAccess(run.workspace_id, access, 'read');
  }
  if (session_id) {
    await assertSessionReadAccess(session_id, access);
  }
  return run;
}

export async function listRuns(params: {
  workspace_id: string;
  session_id?: string;
  task_id?: string;
  agent_name?: string;
  status?: RunStatus[];
  limit?: number;
  offset?: number;
  access?: AccessContext;
}): Promise<AgentRun[]> {
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

  if (params.task_id) {
    conditions.push(`task_id = $${idx++}`);
    values.push(params.task_id);
  }
  if (params.agent_name) {
    conditions.push(`agent_name = $${idx++}`);
    values.push(params.agent_name);
  }
  if (params.status && params.status.length > 0) {
    conditions.push(`status = ANY($${idx++})`);
    values.push(params.status);
  }

  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const { rows } = await pool.query<AgentRun>(
    `SELECT *
     FROM agent_runs
     WHERE ${conditions.join(' AND ')}
     ORDER BY started_at DESC
     LIMIT ${limit}
     OFFSET ${offset}`,
    values
  );
  return rows;
}

export async function checkpointRun(params: {
  run_id: string;
  summary?: string;
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  access?: AccessContext;
}): Promise<AgentRunDetails | null> {
  const access = params.access ?? { kind: 'system' as const };
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const { rows: runRows } = await client.query<AgentRun>(
      'SELECT * FROM agent_runs WHERE id = $1 LIMIT 1 FOR UPDATE',
      [params.run_id]
    );
    const run = runRows[0] ?? null;
    if (!run) {
      await client.query('ROLLBACK');
      return null;
    }
    assertRunIsRunning(run, 'checkpoint');
    if (!isSystemAccess(access)) {
      await ensureWorkspaceAccess(run.workspace_id, access, 'write');
    }
    const nextSequence = run.latest_checkpoint_sequence + 1;
    await client.query(
      `INSERT INTO run_checkpoints (
         run_id,
         sequence,
         summary,
         state,
         metadata
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        params.run_id,
        nextSequence,
        params.summary ?? null,
        JSON.stringify(params.state ?? {}),
        JSON.stringify(params.metadata ?? {}),
      ]
    );
    const updateResult = await client.query(
      `UPDATE agent_runs
       SET latest_checkpoint_sequence = $2,
           latest_checkpoint_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND status = 'running'`,
      [params.run_id, nextSequence]
    );
    if ((updateResult.rowCount ?? 0) === 0) {
      throw new Error(`Run ${params.run_id} is no longer running`);
    }
    await touchSession(run.session_id, client);
    await client.query('COMMIT');
    return getRunDetailsById(pool, params.run_id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateRunStatus(params: {
  run_id: string;
  status: Exclude<RunStatus, 'running'>;
  result?: Record<string, unknown>;
  error_message?: string;
  access?: AccessContext;
}): Promise<AgentRunDetails | null> {
  const access = params.access ?? { kind: 'system' as const };
  const pool = getPool();
  const run = await getRun(params.run_id, access);
  if (!run) {
    return null;
  }
  assertRunIsRunning(
    run,
    params.status === 'completed'
      ? 'complete'
      : params.status === 'failed'
        ? 'fail'
        : 'cancel'
  );
  await ensureWorkspaceAccess(run.workspace_id, access, 'write');

  const { rows } = await pool.query<AgentRun>(
    `UPDATE agent_runs
     SET status = $2,
         result = $3,
         error_message = $4,
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND status = 'running'
     RETURNING *`,
    [
      params.run_id,
      params.status,
      JSON.stringify(params.result ?? {}),
      params.error_message ?? null,
    ]
  );
  if (!rows[0]) {
    throw new Error(`Run ${params.run_id} is no longer running`);
  }
  await touchSession(run.session_id);
  return getRunDetailsById(pool, params.run_id);
}

export async function completeRun(params: {
  run_id: string;
  result?: Record<string, unknown>;
  access?: AccessContext;
}): Promise<AgentRunDetails | null> {
  return updateRunStatus({
    ...params,
    status: 'completed',
  });
}

export async function failRun(params: {
  run_id: string;
  result?: Record<string, unknown>;
  error_message?: string;
  access?: AccessContext;
}): Promise<AgentRunDetails | null> {
  return updateRunStatus({
    ...params,
    status: 'failed',
  });
}

export async function cancelRun(params: {
  run_id: string;
  result?: Record<string, unknown>;
  access?: AccessContext;
}): Promise<AgentRunDetails | null> {
  return updateRunStatus({
    ...params,
    status: 'cancelled',
  });
}
