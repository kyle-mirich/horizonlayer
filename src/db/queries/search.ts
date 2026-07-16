import { getPool } from '../client.js';
import {
  requireActiveWorkspace,
  requireDatabase,
  requireSession,
} from './scopeGuards.js';

export type SearchContentType = 'pages' | 'rows';

export interface SearchResult {
  id: string;
  type: 'page' | 'row';
  title: string;
  score: number;
  snippet: string;
  workspace_id: string;
  session_id: string | null;
  database_id: string | null;
  tags: string[];
  updated_at: string;
}

interface PageSearchRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  title: string;
  tags: string[] | null;
  updated_at: string;
  score: number | string;
  snippet: string | null;
}

interface RowSearchRow {
  id: string;
  workspace_id: string;
  database_id: string;
  title: string | null;
  tags: string[] | null;
  updated_at: string;
  score: number | string;
  snippet: string | null;
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer between 1 and 100');
  }
  return limit;
}

function normalizeQuery(value: string): string {
  if (typeof value !== 'string') throw new Error('query cannot be empty');
  const query = value.trim();
  if (!query) throw new Error('query cannot be empty');
  if (query.length > 1_000) throw new Error('query cannot exceed 1000 characters');
  return query;
}

function normalizeContentTypes(value: SearchContentType[] | undefined): SearchContentType[] {
  const contentTypes = value ?? ['pages', 'rows'];
  if (contentTypes.length === 0) {
    throw new Error('content_types must contain at least one item');
  }
  if (contentTypes.some((contentType) => contentType !== 'pages' && contentType !== 'rows')) {
    throw new Error('content_types may only contain pages or rows');
  }
  return [...new Set(contentTypes)];
}

function resolveContentTypes(
  value: SearchContentType[] | undefined,
  params: { database_id?: string; session_id?: string }
): SearchContentType[] {
  if (params.session_id && params.database_id) {
    throw new Error('session_id and database_id cannot be combined');
  }

  if (value === undefined) {
    if (params.session_id) return ['pages'];
    if (params.database_id) return ['rows'];
    return ['pages', 'rows'];
  }

  const contentTypes = normalizeContentTypes(value);
  if (params.session_id && (contentTypes.length !== 1 || contentTypes[0] !== 'pages')) {
    throw new Error('session_id can only be used with page search');
  }
  if (params.database_id && (contentTypes.length !== 1 || contentTypes[0] !== 'rows')) {
    throw new Error('database_id can only be used with row search');
  }
  return contentTypes;
}

function normalizeImportance(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('min_importance must be a number between 0 and 1');
  }
  return value;
}

async function searchPages(params: {
  query: string;
  workspace_id: string;
  session_id?: string;
  tags?: string[];
  min_importance?: number;
  limit: number;
}): Promise<SearchResult[]> {
  const values: unknown[] = [params.workspace_id];
  const conditions = ['p.workspace_id = $1', 'p.archived_at IS NULL'];
  let index = 2;
  if (params.session_id) {
    conditions.push(`p.session_id = $${index++}`);
    values.push(params.session_id);
  }
  if (params.tags?.length) {
    conditions.push(`p.tags && $${index++}`);
    values.push(params.tags);
  }
  if (params.min_importance !== undefined) {
    conditions.push(`p.importance >= $${index++}`);
    values.push(params.min_importance);
  }
  const queryIndex = index++;
  values.push(params.query);
  const limitIndex = index;
  values.push(params.limit);

  const pool = getPool();
  const { rows } = await pool.query<PageSearchRow>(
    `WITH page_documents AS (
       SELECT p.id,
              p.workspace_id,
              p.session_id,
              p.title,
              p.tags,
              p.importance,
              p.updated_at,
              COALESCE(string_agg(b.content, E'\n' ORDER BY b.position), '') AS body
       FROM pages p
       LEFT JOIN blocks b
         ON b.page_id = p.id
        AND b.archived_at IS NULL
       WHERE ${conditions.join(' AND ')}
       GROUP BY p.id
     ), ranked AS (
       SELECT *,
              to_tsvector('simple', title || ' ' || body) AS document,
              GREATEST(similarity(title, $${queryIndex}), similarity(body, $${queryIndex})) AS fuzzy_score
       FROM page_documents
     )
     SELECT id,
            workspace_id,
            session_id,
            title,
            tags,
            updated_at,
            (
              CASE
                WHEN document @@ websearch_to_tsquery('simple', $${queryIndex})
                  THEN ts_rank_cd(document, websearch_to_tsquery('simple', $${queryIndex}))
                ELSE 0
              END
              + fuzzy_score * 0.5
              + importance * 0.05
            )::float AS score,
            LEFT(CASE WHEN body <> '' THEN body ELSE title END, 400) AS snippet
     FROM ranked
     WHERE document @@ websearch_to_tsquery('simple', $${queryIndex})
        OR fuzzy_score >= 0.08
        OR STRPOS(LOWER(title), LOWER($${queryIndex})) > 0
        OR STRPOS(LOWER(body), LOWER($${queryIndex})) > 0
     ORDER BY score DESC, updated_at DESC
     LIMIT $${limitIndex}`,
    values
  );

  return rows.map((row) => ({
    id: row.id,
    type: 'page',
    title: row.title,
    score: Number(row.score),
    snippet: row.snippet ?? row.title,
    workspace_id: row.workspace_id,
    session_id: row.session_id ?? null,
    database_id: null,
    tags: row.tags ?? [],
    updated_at: row.updated_at,
  }));
}

async function searchRows(params: {
  query: string;
  workspace_id: string;
  database_id?: string;
  tags?: string[];
  min_importance?: number;
  limit: number;
}): Promise<SearchResult[]> {
  const values: unknown[] = [params.workspace_id];
  const conditions = [
    'd.workspace_id = $1',
    'd.archived_at IS NULL',
    'r.archived_at IS NULL',
  ];
  let index = 2;
  if (params.database_id) {
    conditions.push(`r.database_id = $${index++}`);
    values.push(params.database_id);
  }
  if (params.tags?.length) {
    conditions.push(`r.tags && $${index++}`);
    values.push(params.tags);
  }
  if (params.min_importance !== undefined) {
    conditions.push(`r.importance >= $${index++}`);
    values.push(params.min_importance);
  }
  const queryIndex = index++;
  values.push(params.query);
  const limitIndex = index;
  values.push(params.limit);

  const pool = getPool();
  const { rows } = await pool.query<RowSearchRow>(
    `WITH row_documents AS (
       SELECT r.id,
              d.workspace_id,
              r.database_id,
              r.tags,
              r.importance,
              r.updated_at,
              COALESCE(
                MAX(v.value_text) FILTER (WHERE p.property_type = 'title'),
                'Row ' || LEFT(r.id::text, 8)
              ) AS title,
              COALESCE(
                string_agg(
                  COALESCE(v.value_text, v.value_number::text, v.value_date::text, v.value_bool::text, v.value_json::text, ''),
                  E'\n' ORDER BY p.position
                ) FILTER (WHERE p.id IS NOT NULL),
                ''
              ) AS body
       FROM database_rows r
       JOIN databases d ON d.id = r.database_id
       LEFT JOIN database_row_values v ON v.row_id = r.id
       LEFT JOIN database_properties p
         ON p.id = v.property_id
        AND p.database_id = r.database_id
        AND p.archived_at IS NULL
       WHERE ${conditions.join(' AND ')}
       GROUP BY r.id, d.workspace_id
     ), ranked AS (
       SELECT *,
              to_tsvector('simple', title || ' ' || body) AS document,
              GREATEST(similarity(title, $${queryIndex}), similarity(body, $${queryIndex})) AS fuzzy_score
       FROM row_documents
     )
     SELECT id,
            workspace_id,
            database_id,
            title,
            tags,
            updated_at,
            (
              CASE
                WHEN document @@ websearch_to_tsquery('simple', $${queryIndex})
                  THEN ts_rank_cd(document, websearch_to_tsquery('simple', $${queryIndex}))
                ELSE 0
              END
              + fuzzy_score * 0.5
              + importance * 0.05
            )::float AS score,
            LEFT(CASE WHEN body <> '' THEN body ELSE title END, 400) AS snippet
     FROM ranked
     WHERE document @@ websearch_to_tsquery('simple', $${queryIndex})
        OR fuzzy_score >= 0.08
        OR STRPOS(LOWER(title), LOWER($${queryIndex})) > 0
        OR STRPOS(LOWER(body), LOWER($${queryIndex})) > 0
     ORDER BY score DESC, updated_at DESC
     LIMIT $${limitIndex}`,
    values
  );

  return rows.map((row) => ({
    id: row.id,
    type: 'row',
    title: row.title ?? '(untitled row)',
    score: Number(row.score),
    snippet: row.snippet ?? row.title ?? '',
    workspace_id: row.workspace_id,
    session_id: null,
    database_id: row.database_id,
    tags: row.tags ?? [],
    updated_at: row.updated_at,
  }));
}

export async function search(params: {
  query: string;
  workspace_id: string;
  content_types?: SearchContentType[];
  session_id?: string;
  database_id?: string;
  tags?: string[];
  min_importance?: number;
  limit?: number;
}): Promise<SearchResult[]> {
  if (typeof params.workspace_id !== 'string' || !params.workspace_id.trim()) {
    throw new Error('workspace_id is required');
  }
  const query = normalizeQuery(params.query);
  const limit = normalizeLimit(params.limit);
  const contentTypes = new Set(resolveContentTypes(params.content_types, params));
  const minImportance = normalizeImportance(params.min_importance);
  await requireActiveWorkspace(params.workspace_id);

  if (params.session_id) {
    const session = await requireSession(params.session_id);
    if (session.workspace_id !== params.workspace_id) {
      throw new Error('session_id must belong to the requested workspace');
    }
  }
  if (params.database_id) {
    const database = await requireDatabase(params.database_id);
    if (database.workspace_id !== params.workspace_id) {
      throw new Error('database_id must belong to the requested workspace');
    }
  }

  const [pages, rows] = await Promise.all([
    contentTypes.has('pages')
      ? searchPages({ ...params, query, limit, min_importance: minImportance })
      : Promise.resolve([]),
    contentTypes.has('rows')
      ? searchRows({ ...params, query, limit, min_importance: minImportance })
      : Promise.resolve([]),
  ]);

  return [...pages, ...rows]
    .sort((left, right) => right.score - left.score || right.updated_at.localeCompare(left.updated_at))
    .slice(0, limit);
}
