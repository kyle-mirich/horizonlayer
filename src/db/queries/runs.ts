import { getPool, type PoolClient } from '../client.js';
import { withTransaction } from '../transaction.js';
import type { RunOutcome, RunStatus } from '../../domain.js';
import {
  lockActiveSessionForChildWrite,
  requireActiveSession,
  requireActiveWorkspace,
  requireSession,
} from './scopeGuards.js';
import { touchSession } from './sessions.js';

export type { RunOutcome, RunStatus } from '../../domain.js';

const RUN_COLUMNS = `
  id,
  workspace_id,
  session_id,
  agent_name,
  title,
  status,
  metadata,
  result,
  error_message,
  latest_checkpoint_sequence,
  latest_checkpoint_at,
  started_at,
  finished_at,
  created_at,
  updated_at
`;

const CHECKPOINT_COLUMNS = `
  id,
  run_id,
  sequence,
  summary,
  state,
  metadata,
  created_at
`;

export interface AgentRun {
  id: string;
  workspace_id: string;
  session_id: string | null;
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
  checkpoints_page: RunCheckpointsPage;
}

export interface RunCheckpointsPage {
  has_more: boolean;
  limit: number;
  next_offset: number | null;
  offset: number;
}

export interface RunCheckpointMutation {
  checkpoint: RunCheckpoint;
  run: AgentRun;
}

export interface RunFinishMutation {
  latest_checkpoint: RunCheckpoint | null;
  run: AgentRun;
}

export interface GetRunOptions {
  checkpoint_limit?: number;
  checkpoint_offset?: number;
  session_id?: string;
}

type Queryable = Pick<PoolClient, 'query'>;
const DEFAULT_CHECKPOINT_LIMIT = 20;

function boundedInteger(name: string, value: number | undefined, fallback: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
  return resolved;
}

function checkpointLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_CHECKPOINT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('checkpoint_limit must be an integer between 1 and 100');
  }
  return limit;
}

function normalizeAgentName(agentName: string): string {
  const normalized = typeof agentName === 'string' ? agentName.trim() : '';
  if (!normalized) throw new Error('agent_name is required');
  return normalized;
}

async function ensureSessionMatchesWorkspace(
  sessionId: string,
  workspaceId: string,
  mode: 'read' | 'write'
): Promise<void> {
  const session = mode === 'read'
    ? await requireSession(sessionId)
    : await requireActiveSession(sessionId);
  if (session.workspace_id !== workspaceId) {
    throw new Error(`session_id must belong to workspace ${workspaceId}`);
  }
}

function assertRunIsRunning(run: AgentRun, action: 'checkpoint' | 'finish'): void {
  if (run.status !== 'running') {
    throw new Error(`Run ${run.id} is already ${run.status}, cannot ${action}`);
  }
}

async function getRunById(
  queryable: Queryable,
  runId: string,
  forUpdate = false
): Promise<AgentRun | null> {
  const { rows } = await queryable.query<AgentRun>(
    `SELECT ${RUN_COLUMNS}
     FROM agent_runs
     WHERE id = $1
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [runId]
  );
  return rows[0] ?? null;
}

async function listRunCheckpoints(
  queryable: Queryable,
  runId: string,
  limit: number,
  offset: number
): Promise<{ checkpoints: RunCheckpoint[]; checkpoints_page: RunCheckpointsPage }> {
  const { rows } = await queryable.query<RunCheckpoint>(
    `SELECT ${CHECKPOINT_COLUMNS}
     FROM run_checkpoints
     WHERE run_id = $1
     ORDER BY sequence DESC
     LIMIT $2 OFFSET $3`,
    [runId, limit + 1, offset]
  );
  const hasMore = rows.length > limit;
  return {
    checkpoints: hasMore ? rows.slice(0, limit) : rows,
    checkpoints_page: {
      has_more: hasMore,
      limit,
      next_offset: hasMore ? offset + limit : null,
      offset,
    },
  };
}

async function getLatestRunCheckpoint(queryable: Queryable, runId: string): Promise<RunCheckpoint | null> {
  const { rows } = await queryable.query<RunCheckpoint>(
    `SELECT ${CHECKPOINT_COLUMNS}
     FROM run_checkpoints
     WHERE run_id = $1
     ORDER BY sequence DESC
     LIMIT 1`,
    [runId]
  );
  return rows[0] ?? null;
}

export async function startRun(params: {
  workspace_id: string;
  session_id?: string;
  agent_name: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): Promise<AgentRunDetails> {
  const agentName = normalizeAgentName(params.agent_name);
  await requireActiveWorkspace(params.workspace_id);
  if (params.session_id) {
    await ensureSessionMatchesWorkspace(params.session_id, params.workspace_id, 'write');
  }

  return withTransaction(async (client) => {
    if (params.session_id) {
      const lockedSession = await lockActiveSessionForChildWrite(params.session_id, client);
      if (lockedSession.workspace_id !== params.workspace_id) {
        throw new Error(`session_id must belong to workspace ${params.workspace_id}`);
      }
    }
    const { rows } = await client.query<AgentRun>(
      `INSERT INTO agent_runs (workspace_id, session_id, agent_name, title, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${RUN_COLUMNS}`,
      [
        params.workspace_id,
        params.session_id ?? null,
        agentName,
        params.title?.trim() || null,
        JSON.stringify(params.metadata ?? {}),
      ]
    );
    await touchSession(params.session_id, client);
    return {
      ...rows[0],
      checkpoints: [],
      checkpoints_page: {
        has_more: false,
        limit: DEFAULT_CHECKPOINT_LIMIT,
        next_offset: null,
        offset: 0,
      },
    };
  });
}

export async function getRun(
  runId: string,
  options: GetRunOptions = {}
): Promise<AgentRunDetails | null> {
  const limit = checkpointLimit(options.checkpoint_limit);
  const offset = boundedInteger('checkpoint_offset', options.checkpoint_offset, 0, 1_000_000);
  const pool = getPool();
  const run = await getRunById(pool, runId);
  if (!run || (options.session_id && run.session_id !== options.session_id)) return null;
  await requireActiveWorkspace(run.workspace_id);
  if (options.session_id) await requireSession(options.session_id);
  return { ...run, ...await listRunCheckpoints(pool, runId, limit, offset) };
}

export async function listRuns(params: {
  workspace_id: string;
  session_id?: string;
  agent_name?: string;
  status?: RunStatus[];
  limit?: number;
  offset?: number;
}): Promise<AgentRun[]> {
  await requireActiveWorkspace(params.workspace_id);
  if (params.session_id) {
    await ensureSessionMatchesWorkspace(params.session_id, params.workspace_id, 'read');
  }

  const conditions = ['workspace_id = $1'];
  const values: unknown[] = [params.workspace_id];
  let index = 2;
  if (params.session_id) {
    conditions.push(`session_id = $${index++}`);
    values.push(params.session_id);
  }
  if (params.agent_name) {
    conditions.push(`agent_name = $${index++}`);
    values.push(params.agent_name);
  }
  if (params.status?.length) {
    conditions.push(`status = ANY($${index++})`);
    values.push(params.status);
  }
  const limit = boundedInteger('limit', params.limit, 50, 101);
  const offset = boundedInteger('offset', params.offset, 0, 1_000_000);
  values.push(limit, offset);

  const pool = getPool();
  const { rows } = await pool.query<AgentRun>(
    `SELECT ${RUN_COLUMNS}
     FROM agent_runs
     WHERE ${conditions.join(' AND ')}
     ORDER BY started_at DESC
     LIMIT $${index++} OFFSET $${index}`,
    values
  );
  return rows;
}

export async function checkpointRun(params: {
  run_id: string;
  summary?: string;
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<RunCheckpointMutation | null> {
  return withTransaction(async (client, transaction) => {
    const run = await getRunById(client, params.run_id, true);
    if (!run) {
      await transaction.rollback();
      return null;
    }
    assertRunIsRunning(run, 'checkpoint');
    if (run.session_id) {
      // Lock the attached session before this checkpoint's workspace-triggered
      // write. Session close takes the same session-then-workspace order.
      const session = await lockActiveSessionForChildWrite(run.session_id, client);
      if (session.workspace_id !== run.workspace_id) {
        throw new Error(`Run ${run.id} is associated with a session in another workspace`);
      }
    }
    await requireActiveWorkspace(run.workspace_id, client);

    const sequence = run.latest_checkpoint_sequence + 1;
    const { rows: checkpointRows } = await client.query<RunCheckpoint>(
      `INSERT INTO run_checkpoints (run_id, sequence, summary, state, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${CHECKPOINT_COLUMNS}`,
      [
        params.run_id,
        sequence,
        params.summary ?? null,
        JSON.stringify(params.state ?? {}),
        JSON.stringify(params.metadata ?? {}),
      ]
    );
    const { rows: runRows } = await client.query<AgentRun>(
      `UPDATE agent_runs
       SET latest_checkpoint_sequence = $2,
           latest_checkpoint_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND status = 'running'
       RETURNING ${RUN_COLUMNS}`,
      [params.run_id, sequence]
    );
    if (!runRows[0]) throw new Error(`Run ${params.run_id} is no longer running`);
    await touchSession(run.session_id, client);
    return { checkpoint: checkpointRows[0], run: runRows[0] };
  });
}

export async function finishRun(params: {
  run_id: string;
  outcome: RunOutcome;
  result?: Record<string, unknown>;
  error_message?: string;
}): Promise<RunFinishMutation | null> {
  if (params.outcome !== 'failed' && params.error_message !== undefined) {
    throw new Error('error_message is only valid when outcome is failed');
  }
  return withTransaction(async (client, transaction) => {
    const run = await getRunById(client, params.run_id, true);
    if (!run) {
      await transaction.rollback();
      return null;
    }
    assertRunIsRunning(run, 'finish');
    await requireActiveWorkspace(run.workspace_id, client);

    const { rows } = await client.query<AgentRun>(
      `UPDATE agent_runs
       SET status = $2,
           result = $3,
           error_message = $4,
           finished_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND status = 'running'
       RETURNING ${RUN_COLUMNS}`,
      [
        params.run_id,
        params.outcome,
        JSON.stringify(params.result ?? {}),
        params.outcome === 'failed' ? params.error_message ?? null : null,
      ]
    );
    if (!rows[0]) throw new Error(`Run ${params.run_id} is no longer running`);
    const latestCheckpoint = run.latest_checkpoint_sequence > 0
      ? await getLatestRunCheckpoint(client, params.run_id)
      : null;
    await touchSession(run.session_id, client);
    return { latest_checkpoint: latestCheckpoint, run: rows[0] };
  });
}
