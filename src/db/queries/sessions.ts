import { getPool, type PoolClient } from '../client.js';
import {
  requireActiveSession,
  requireActiveWorkspace,
  requireSession,
} from './scopeGuards.js';

export type SessionStatus = 'active' | 'closed';

const SESSION_COLUMNS = `
  id,
  workspace_id,
  title,
  status,
  summary,
  metadata,
  started_at,
  last_activity_at,
  ended_at,
  created_at,
  updated_at
`;

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
  run_count: number;
}

export interface SessionResumePage {
  id: string;
  parent_page_id: string | null;
  title: string;
  revision: number;
  importance: number;
  tags: string[];
  created_at: string;
  updated_at: string;
  content_preview: string;
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
  workspace_id: string;
  session_id: string | null;
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

export interface SessionResumeCollectionStatus {
  complete: boolean;
  has_more: boolean;
  limit: number;
  returned: number;
}

export interface SessionResumeResult {
  session: SessionWithCounts;
  recent_pages: SessionResumePage[];
  recent_runs: SessionResumeRun[];
  search_hits: SessionResumeSearchHit[];
  collection_status: {
    recent_pages: SessionResumeCollectionStatus;
    recent_runs: SessionResumeCollectionStatus;
    search_hits: SessionResumeCollectionStatus;
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

function boundedInteger(name: string, value: number | undefined, fallback: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
  return resolved;
}

function truncate(text: string, max = 400): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return `${text.slice(0, cut > 0 ? cut : max)}...`;
}

function boundedRecord(
  value: Record<string, unknown> | undefined,
  maxBytes: number
): { value: Record<string, unknown>; truncated: boolean } {
  const record = value ?? {};
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') <= maxBytes) {
    return { value: record, truncated: false };
  }
  return {
    value: { _truncated: true },
    truncated: true,
  };
}

function boundedCollection<T>(records: T[], limit: number): {
  items: T[];
  status: SessionResumeCollectionStatus;
} {
  const hasMore = records.length > limit;
  const items = hasMore ? records.slice(0, limit) : records;
  return {
    items,
    status: {
      complete: !hasMore,
      has_more: hasMore,
      limit,
      returned: items.length,
    },
  };
}

export async function createSession(params: {
  workspace_id: string;
  title?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}): Promise<Session> {
  await requireActiveWorkspace(params.workspace_id);
  const pool = getPool();
  const { rows } = await pool.query<Session>(
    `INSERT INTO sessions (
       workspace_id,
       title,
       summary,
       metadata
     )
     VALUES ($1, $2, $3, $4)
     RETURNING ${SESSION_COLUMNS}`,
    [
      params.workspace_id,
      params.title ?? defaultSessionTitle(),
      params.summary ?? null,
      JSON.stringify(params.metadata ?? {}),
    ]
  );
  return rows[0];
}

export async function closeSession(sessionId: string): Promise<Session | null> {
  const sessionScope = await requireActiveSession(sessionId);
  const pool = getPool();
  const { rows } = await pool.query<Session>(
    `UPDATE sessions
     SET status = 'closed',
         ended_at = COALESCE(ended_at, NOW()),
         last_activity_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND workspace_id = $2
       AND status = 'active'
     RETURNING ${SESSION_COLUMNS}`,
    [sessionId, sessionScope.workspace_id]
  );
  return rows[0] ?? null;
}

export async function getSession(
  sessionId: string,
  params: {
    workspace_id?: string;
  } = {}
): Promise<SessionWithCounts | null> {
  const sessionScope = await requireSession(sessionId);
  ensureWorkspaceMatch(sessionScope.workspace_id, params.workspace_id);
  const pool = getPool();
  const { rows } = await pool.query<SessionWithCounts>(
    `SELECT s.id, s.workspace_id, s.title, s.status, s.summary, s.metadata,
            s.started_at, s.last_activity_at, s.ended_at, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM pages WHERE session_id = s.id AND archived_at IS NULL)::int AS page_count,
            (SELECT COUNT(*) FROM agent_runs WHERE session_id = s.id)::int AS run_count
     FROM sessions s
     WHERE s.id = $1
       AND s.workspace_id = $2
     LIMIT 1`,
    [sessionId, sessionScope.workspace_id]
  );
  return rows[0] ?? null;
}

export async function listSessions(params: {
  workspace_id: string;
  status?: SessionStatus[];
  limit?: number;
  offset?: number;
}): Promise<Session[]> {
  await requireActiveWorkspace(params.workspace_id);
  const pool = getPool();
  const limit = boundedInteger('limit', params.limit, 50, 101);
  const offset = boundedInteger('offset', params.offset, 0, 1_000_000);
  const { rows } = await pool.query<Session>(
    `SELECT ${SESSION_COLUMNS}
     FROM sessions
     WHERE workspace_id = $1
       AND ($2::text[] IS NULL OR status = ANY($2))
     ORDER BY last_activity_at DESC, created_at DESC
     LIMIT $3 OFFSET $4`,
    [params.workspace_id, params.status?.length ? params.status : null, limit, offset]
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
     WHERE id = $1
       AND status = 'active'`,
    [sessionId]
  );
}

export async function resumeSession(params: {
  session_id: string;
  workspace_id?: string;
  max_items?: number;
}): Promise<SessionResumeResult | null> {
  const session = await getSession(params.session_id, {
    workspace_id: params.workspace_id,
  });
  if (!session) {
    return null;
  }

  const maxItems = boundedInteger('max_items', params.max_items, 10, 100);
  const searchLimit = Math.min(maxItems, 5);
  const pool = getPool();

  const [recentPagesResult, recentRunsResult] = await Promise.all([
    pool.query<SessionResumePage>(
      `SELECT p.id,
              p.parent_page_id,
              p.title,
              p.revision,
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
                      AND archived_at IS NULL
                      AND content <> ''
                    ORDER BY position ASC
                    LIMIT 8
                  ) b
                ), ''),
                2000
              ) AS content_preview
       FROM pages p
       WHERE p.session_id = $1
         AND p.archived_at IS NULL
       ORDER BY p.updated_at DESC
       LIMIT $2`,
      [params.session_id, maxItems + 1]
    ),
    pool.query<SessionResumeRun>(
      `SELECT r.id,
              r.workspace_id,
              r.session_id,
              r.agent_name,
              r.title,
              r.status,
              r.metadata,
              r.result,
              r.error_message,
              r.latest_checkpoint_sequence,
              r.latest_checkpoint_at,
              r.started_at,
              r.finished_at,
              r.created_at,
              r.updated_at,
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
      [params.session_id, maxItems + 1]
    ),
  ]);

  let searchHits: SessionResumeSearchHit[] = [];
  const resumeQuery = (session.summary ?? '').trim() || session.title.trim();
  if (resumeQuery.length > 0) {
    const { rows } = await pool.query<SessionResumeSearchHit>(
      `SELECT p.id,
              p.title,
              (
                CASE WHEN STRPOS(LOWER(p.title), LOWER($2)) > 0 THEN 2 ELSE 0 END
                + COALESCE((
                  SELECT COUNT(*)
                  FROM blocks b_score
                  WHERE b_score.page_id = p.id
                    AND b_score.archived_at IS NULL
                    AND STRPOS(LOWER(b_score.content), LOWER($2)) > 0
                ), 0)
              )::float AS score,
              COALESCE(
                (
                  SELECT b.content
                  FROM blocks b
                  WHERE b.page_id = p.id
                    AND b.archived_at IS NULL
                    AND STRPOS(LOWER(b.content), LOWER($2)) > 0
                  ORDER BY b.position ASC
                  LIMIT 1
                ),
                p.title
              ) AS snippet,
              p.updated_at
       FROM pages p
       WHERE p.session_id = $1
         AND p.archived_at IS NULL
         AND (
           STRPOS(LOWER(p.title), LOWER($2)) > 0
           OR EXISTS (
             SELECT 1
             FROM blocks b
             WHERE b.page_id = p.id
               AND b.archived_at IS NULL
               AND STRPOS(LOWER(b.content), LOWER($2)) > 0
           )
         )
       ORDER BY score DESC, p.updated_at DESC
       LIMIT $3`,
      [params.session_id, resumeQuery, searchLimit + 1]
    );
    searchHits = rows;
  }

  const recentPages = boundedCollection(recentPagesResult.rows, maxItems);
  const recentRuns = boundedCollection(recentRunsResult.rows, maxItems);
  const boundedSearchHits = boundedCollection(searchHits, searchLimit);
  const collectionStatus = {
    recent_pages: recentPages.status,
    recent_runs: recentRuns.status,
    search_hits: boundedSearchHits.status,
  };
  let truncated = Object.values(collectionStatus).some((status) => status.has_more);
  const boundRecord = (value: Record<string, unknown> | undefined, maxBytes: number) => {
    const bounded = boundedRecord(value, maxBytes);
    truncated ||= bounded.truncated;
    return bounded.value;
  };
  const boundText = (value: string, max: number) => {
    const bounded = truncate(value, max);
    truncated ||= bounded !== value;
    return bounded;
  };

  return {
    session: {
      ...session,
      metadata: boundRecord(session.metadata, 4_096),
    },
    recent_pages: recentPages.items.map((page) => ({
      ...page,
      content_preview: boundText(page.content_preview, 1_200),
    })),
    recent_runs: recentRuns.items.map((run) => ({
      ...run,
      metadata: boundRecord(run.metadata, 4_096),
      result: boundRecord(run.result, 8_192),
      latest_checkpoint: run.latest_checkpoint
        ? {
          ...run.latest_checkpoint,
          summary: run.latest_checkpoint.summary
            ? boundText(run.latest_checkpoint.summary, 1_000)
            : null,
          state: boundRecord(run.latest_checkpoint.state, 8_192),
          metadata: boundRecord(run.latest_checkpoint.metadata, 4_096),
        }
        : null,
    })),
    search_hits: boundedSearchHits.items.map((hit) => ({
      ...hit,
      snippet: boundText(hit.snippet, 400),
    })),
    collection_status: collectionStatus,
    truncated,
  };
}
