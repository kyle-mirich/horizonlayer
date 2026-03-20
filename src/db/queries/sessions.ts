import { writeFile } from 'node:fs/promises';
import { getPool, type PoolClient } from '../client.js';
import type { AccessContext } from '../access.js';
import {
  assertSessionReadAccess,
  assertSessionWriteAccess,
  assertWorkspaceReadAccess,
  assertWorkspaceWriteAccess,
} from './accessControl.js';

export type SessionStatus = 'active' | 'closed';

export interface Session {
  id: string;
  workspace_id: string;
  title: string;
  status: SessionStatus;
  summary: string | null;
  metadata: Record<string, unknown>;
  started_at: string;
  last_activity_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionWithCounts extends Session {
  page_count: number;
  task_count: number;
  run_count: number;
}

export interface SessionResumePage {
  id: string;
  parent_page_id: string | null;
  title: string;
  importance: number;
  tags: string[];
  created_at: string;
  updated_at: string;
  content_preview: string;
}

export interface SessionResumeTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  owner_agent_name: string | null;
  handoff_target_agent_name: string | null;
  blocker_reason: string | null;
  last_event_at: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRunCheckpoint {
  id: string;
  run_id: string;
  sequence: number;
  summary: string | null;
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SessionResumeRun {
  id: string;
  task_id: string | null;
  parent_run_id: string | null;
  agent_name: string;
  title: string | null;
  status: string;
  metadata: Record<string, unknown>;
  result: Record<string, unknown>;
  error_message: string | null;
  latest_checkpoint_sequence: number;
  latest_checkpoint_at: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  latest_checkpoint: SessionRunCheckpoint | null;
}

export interface SessionResumeSearchHit {
  id: string;
  title: string;
  score: number;
  snippet: string;
  updated_at: string;
}

export interface SessionResumeBundle {
  session: SessionWithCounts;
  recent_pages: SessionResumePage[];
  open_and_recent_tasks: SessionResumeTask[];
  recent_runs: SessionResumeRun[];
  search_hits: SessionResumeSearchHit[];
}

export interface SessionResumeBundleResult {
  bytes: number;
  bundle?: SessionResumeBundle;
  file_path?: string;
  max_bytes: number;
  preview?: {
    recent_page_count: number;
    recent_run_count: number;
    search_hit_count: number;
    session: SessionWithCounts;
    task_count: number;
  };
  truncated: boolean;
}

type Queryable = Pick<PoolClient, 'query'>;

function ensureWorkspaceMatch(actualWorkspaceId: string, expectedWorkspaceId?: string): void {
  if (expectedWorkspaceId && expectedWorkspaceId !== actualWorkspaceId) {
    throw new Error(`Session belongs to workspace ${actualWorkspaceId}, not ${expectedWorkspaceId}`);
  }
}

function defaultSessionTitle(): string {
  return `Session ${new Date().toISOString()}`;
}

function truncate(text: string, max = 400): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return `${text.slice(0, cut > 0 ? cut : max)}...`;
}

async function getSessionRowById(client: Queryable, sessionId: string): Promise<Session | null> {
  const { rows } = await client.query<Session>(
    'SELECT * FROM sessions WHERE id = $1 LIMIT 1',
    [sessionId]
  );
  return rows[0] ?? null;
}

export async function createSession(params: {
  workspace_id: string;
  title?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  access?: AccessContext;
}): Promise<Session> {
  const access = params.access ?? { kind: 'system' as const };
  await assertWorkspaceWriteAccess(params.workspace_id, access);
  const pool = getPool();
  const { rows } = await pool.query<Session>(
    `INSERT INTO sessions (
       workspace_id,
       title,
       summary,
       metadata
     )
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      params.workspace_id,
      params.title ?? defaultSessionTitle(),
      params.summary ?? null,
      JSON.stringify(params.metadata ?? {}),
    ]
  );
  return rows[0];
}

export async function closeSession(
  sessionId: string,
  access: AccessContext = { kind: 'system' }
): Promise<Session | null> {
  const sessionAccess = await assertSessionWriteAccess(sessionId, access);
  const pool = getPool();
  const { rows } = await pool.query<Session>(
    `UPDATE sessions
     SET status = 'closed',
         ended_at = COALESCE(ended_at, NOW()),
         last_activity_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND workspace_id = $2
     RETURNING *`,
    [sessionId, sessionAccess.workspace_id]
  );
  return rows[0] ?? null;
}

export async function getSession(
  sessionId: string,
  params: {
    workspace_id?: string;
    access?: AccessContext;
  } = {}
): Promise<SessionWithCounts | null> {
  const access = params.access ?? { kind: 'system' as const };
  const sessionAccess = await assertSessionReadAccess(sessionId, access);
  ensureWorkspaceMatch(sessionAccess.workspace_id, params.workspace_id);
  const pool = getPool();
  const { rows } = await pool.query<SessionWithCounts>(
    `SELECT s.*,
            (SELECT COUNT(*) FROM pages WHERE session_id = s.id)::int AS page_count,
            (SELECT COUNT(*) FROM tasks WHERE session_id = s.id)::int AS task_count,
            (SELECT COUNT(*) FROM agent_runs WHERE session_id = s.id)::int AS run_count
     FROM sessions s
     WHERE s.id = $1
       AND s.workspace_id = $2
     LIMIT 1`,
    [sessionId, sessionAccess.workspace_id]
  );
  return rows[0] ?? null;
}

export async function listSessions(params: {
  workspace_id: string;
  limit?: number;
  offset?: number;
  access?: AccessContext;
}): Promise<Session[]> {
  const access = params.access ?? { kind: 'system' as const };
  await assertWorkspaceReadAccess(params.workspace_id, access);
  const pool = getPool();
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const { rows } = await pool.query<Session>(
    `SELECT *
     FROM sessions
     WHERE workspace_id = $1
     ORDER BY last_activity_at DESC, created_at DESC
     LIMIT ${limit}
     OFFSET ${offset}`,
    [params.workspace_id]
  );
  return rows;
}

export async function touchSession(
  sessionId?: string | null,
  queryable?: Queryable
): Promise<void> {
  if (!sessionId) {
    return;
  }
  const executor = queryable ?? getPool();
  await executor.query(
    `UPDATE sessions
     SET last_activity_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [sessionId]
  );
}

export async function getSessionResumeBundle(params: {
  session_id: string;
  workspace_id?: string;
  max_items?: number;
  max_bytes?: number;
  access?: AccessContext;
}): Promise<SessionResumeBundleResult | null> {
  const access = params.access ?? { kind: 'system' as const };
  const session = await getSession(params.session_id, {
    workspace_id: params.workspace_id,
    access,
  });
  if (!session) {
    return null;
  }

  const maxItems = params.max_items ?? 10;
  const maxBytes = params.max_bytes ?? 32768;
  const pool = getPool();

  const [recentPagesResult, recentTasksResult, recentRunsResult] = await Promise.all([
    pool.query<SessionResumePage>(
      `SELECT p.id,
              p.parent_page_id,
              p.title,
              p.importance,
              p.tags,
              p.created_at,
              p.updated_at,
              LEFT(
                COALESCE((
                  SELECT string_agg(b.content, E'\n' ORDER BY b.position)
                  FROM (
                    SELECT content, position
                    FROM blocks
                    WHERE page_id = p.id
                      AND content <> ''
                    ORDER BY position ASC
                    LIMIT 8
                  ) b
                ), ''),
                2000
              ) AS content_preview
       FROM pages p
       WHERE p.session_id = $1
       ORDER BY p.updated_at DESC
       LIMIT $2`,
      [params.session_id, maxItems]
    ),
    pool.query<SessionResumeTask>(
      `SELECT id,
              title,
              status,
              priority,
              owner_agent_name,
              handoff_target_agent_name,
              blocker_reason,
              last_event_at,
              created_at,
              updated_at
       FROM tasks
       WHERE session_id = $1
       ORDER BY
         CASE
           WHEN status IN ('done', 'failed', 'cancelled') THEN 1
           ELSE 0
         END ASC,
         last_event_at DESC
       LIMIT $2`,
      [params.session_id, maxItems]
    ),
    pool.query<SessionResumeRun>(
      `SELECT r.*,
              checkpoint.latest_checkpoint
       FROM agent_runs r
       LEFT JOIN LATERAL (
         SELECT row_to_json(rc) AS latest_checkpoint
         FROM (
           SELECT id, run_id, sequence, summary, state, metadata, created_at
           FROM run_checkpoints
           WHERE run_id = r.id
           ORDER BY sequence DESC
           LIMIT 1
         ) rc
       ) checkpoint ON TRUE
       WHERE r.session_id = $1
       ORDER BY r.started_at DESC
       LIMIT $2`,
      [params.session_id, maxItems]
    ),
  ]);

  let searchHits: SessionResumeSearchHit[] = [];
  const resumeQuery = (session.summary ?? '').trim() || session.title.trim();
  if (resumeQuery.length > 0) {
    const ilikeQuery = `%${resumeQuery}%`;
    const { rows } = await pool.query<SessionResumeSearchHit>(
      `SELECT p.id,
              p.title,
              (
                CASE WHEN p.title ILIKE $2 THEN 2 ELSE 0 END
                + COALESCE((
                  SELECT COUNT(*)
                  FROM blocks b_score
                  WHERE b_score.page_id = p.id
                    AND b_score.content ILIKE $2
                ), 0)
              )::float AS score,
              COALESCE(
                (
                  SELECT b.content
                  FROM blocks b
                  WHERE b.page_id = p.id
                    AND b.content ILIKE $2
                  ORDER BY b.position ASC
                  LIMIT 1
                ),
                p.title
              ) AS snippet,
              p.updated_at
       FROM pages p
       WHERE p.session_id = $1
         AND (
           p.title ILIKE $2
           OR EXISTS (
             SELECT 1
             FROM blocks b
             WHERE b.page_id = p.id
               AND b.content ILIKE $2
           )
         )
       ORDER BY score DESC, p.updated_at DESC
       LIMIT $3`,
      [params.session_id, ilikeQuery, Math.min(maxItems, 5)]
    );
    searchHits = rows.map((row) => ({
      ...row,
      snippet: truncate(row.snippet),
    }));
  }

  const bundle: SessionResumeBundle = {
    session,
    recent_pages: recentPagesResult.rows.map((page) => ({
      ...page,
      content_preview: truncate(page.content_preview, 1200),
    })),
    open_and_recent_tasks: recentTasksResult.rows,
    recent_runs: recentRunsResult.rows,
    search_hits: searchHits,
  };

  const serialized = JSON.stringify(bundle, null, 2);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maxBytes) {
    const filePath = `/tmp/horizondb-session-${params.session_id}-${Date.now()}.txt`;
    await writeFile(filePath, serialized, 'utf8');
    return {
      bytes,
      file_path: filePath,
      max_bytes: maxBytes,
      preview: {
        recent_page_count: bundle.recent_pages.length,
        recent_run_count: bundle.recent_runs.length,
        search_hit_count: bundle.search_hits.length,
        session: bundle.session,
        task_count: bundle.open_and_recent_tasks.length,
      },
      truncated: true,
    };
  }

  return {
    bundle,
    bytes,
    max_bytes: maxBytes,
    truncated: false,
  };
}
