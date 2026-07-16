import { getPool } from '../client.js';
import {
  requireActiveWorkspace,
  requireSession,
} from './scopeGuards.js';

export type SearchRecordType = 'page' | 'row';

export type SearchScopeInput =
  | {
      kind: 'workspace';
      workspace_id: string;
      types?: SearchRecordType[];
    }
  | {
      kind: 'session';
      session_id: string;
    }
  | {
      kind: 'database';
      database_id: string;
    };

export interface ResolvedSearchScope {
  kind: SearchScopeInput['kind'];
  workspace_id: string;
  types: SearchRecordType[];
  session_id: string | null;
  database_id: string | null;
}

export interface SearchRecord {
  id: string;
  type: 'page' | 'row';
  title: string;
  score: number;
  snippet: string;
  workspace_id: string;
  session_id: string | null;
  parent_page_id: string | null;
  database_id: string | null;
  tags: string[];
  importance: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface SearchRecordsResult {
  records: SearchRecord[];
  truncated: boolean;
}

interface PageSearchRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  parent_page_id: string | null;
  title: string;
  tags: string[] | null;
  importance: number;
  revision: number;
  created_at: string | Date;
  updated_at: string | Date;
  score: number | string;
  snippet: string | null;
}

interface RowSearchRow {
  id: string;
  workspace_id: string;
  database_id: string;
  title: string | null;
  tags: string[] | null;
  importance: number;
  revision: number;
  created_at: string | Date;
  updated_at: string | Date;
  score: number | string;
  snippet: string | null;
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('limit must be an integer between 1 and 50');
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

function normalizeRecordTypes(value: SearchRecordType[] | undefined): SearchRecordType[] {
  const recordTypes = value ?? ['page', 'row'];
  if (recordTypes.length === 0) {
    throw new Error('Workspace search types must contain at least one item');
  }
  if (recordTypes.some((recordType) => recordType !== 'page' && recordType !== 'row')) {
    throw new Error('Workspace search types may only contain page or row');
  }
  return [...new Set(recordTypes)];
}

async function requireActiveDatabaseScope(databaseId: string): Promise<{ workspace_id: string }> {
  const { rows } = await getPool().query<{ workspace_id: string }>(
    `SELECT d.workspace_id
     FROM databases d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.id = $1
       AND d.archived_at IS NULL
       AND w.archived_at IS NULL`,
    [databaseId]
  );
  if (!rows[0]) throw new Error(`Database ${databaseId} not found`);
  return rows[0];
}

export async function resolveSearchScope(scope: SearchScopeInput): Promise<ResolvedSearchScope> {
  switch (scope.kind) {
    case 'workspace': {
      const types = normalizeRecordTypes(scope.types);
      await requireActiveWorkspace(scope.workspace_id);
      return {
        kind: scope.kind,
        workspace_id: scope.workspace_id,
        types,
        session_id: null,
        database_id: null,
      };
    }
    case 'session': {
      const session = await requireSession(scope.session_id);
      return {
        kind: scope.kind,
        workspace_id: session.workspace_id,
        types: ['page'],
        session_id: scope.session_id,
        database_id: null,
      };
    }
    case 'database': {
      const database = await requireActiveDatabaseScope(scope.database_id);
      return {
        kind: scope.kind,
        workspace_id: database.workspace_id,
        types: ['row'],
        session_id: null,
        database_id: scope.database_id,
      };
    }
    default:
      throw new Error(`Unsupported search scope: ${String((scope as { kind?: unknown }).kind)}`);
  }
}

function normalizeImportance(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('min_importance must be a number between 0 and 1');
  }
  return value;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function searchExcerptSql(candidateSql: string, queryIndex: number): string {
  const matchPosition = `STRPOS(LOWER(${candidateSql}), LOWER($${queryIndex}))`;
  return `CASE
    WHEN ${matchPosition} > 0
      THEN SUBSTRING(${candidateSql} FROM GREATEST(1, ${matchPosition} - 80) FOR 400)
    ELSE LEFT(${candidateSql}, 400)
  END`;
}

async function searchPages(params: {
  query: string;
  workspace_id: string;
  session_id: string | null;
  tags?: string[];
  min_importance?: number;
  limit: number;
}): Promise<SearchRecord[]> {
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
  const candidateLimitIndex = index++;
  values.push(Math.min(500, Math.max(50, params.limit * 10)));
  const limitIndex = index;
  values.push(params.limit);
  const titleExcerpt = searchExcerptSql('p.title', queryIndex);
  const blockExcerpt = searchExcerptSql('b.content', queryIndex);

  const pool = getPool();
  const { rows } = await pool.query<PageSearchRow>(
    `WITH candidate_matches AS MATERIALIZED (
       SELECT p.id,
              (2 + p.importance * 0.05)::float AS candidate_score,
              ${titleExcerpt} AS snippet
       FROM pages p
       JOIN workspaces w
         ON w.id = p.workspace_id
        AND w.archived_at IS NULL
       WHERE ${conditions.join(' AND ')}
         AND p.id = CASE
           WHEN $${queryIndex} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             THEN $${queryIndex}::uuid
           ELSE NULL
         END
       UNION ALL
       SELECT p.id,
              (
                CASE
                  WHEN to_tsvector('simple', p.title)
                       @@ websearch_to_tsquery('simple', $${queryIndex})
                    THEN ts_rank_cd(
                      to_tsvector('simple', p.title),
                      websearch_to_tsquery('simple', $${queryIndex})
                    )
                  ELSE 0
                END
                + GREATEST(
                    similarity(p.title, $${queryIndex}),
                    word_similarity($${queryIndex}, p.title)
                  ) * 0.5
                + p.importance * 0.05
              )::float AS candidate_score,
              ${titleExcerpt} AS snippet
       FROM pages p
       JOIN workspaces w
         ON w.id = p.workspace_id
        AND w.archived_at IS NULL
       WHERE ${conditions.join(' AND ')}
         AND (
           to_tsvector('simple', p.title) @@ websearch_to_tsquery('simple', $${queryIndex})
           OR p.title % $${queryIndex}
           OR $${queryIndex} <% p.title
         )
       UNION ALL
       SELECT p.id,
              (
                CASE
                  WHEN to_tsvector('simple', b.content)
                       @@ websearch_to_tsquery('simple', $${queryIndex})
                    THEN ts_rank_cd(
                      to_tsvector('simple', b.content),
                      websearch_to_tsquery('simple', $${queryIndex})
                    )
                  ELSE 0
                END
                + GREATEST(
                    similarity(b.content, $${queryIndex}),
                    word_similarity($${queryIndex}, b.content)
                  ) * 0.5
                + p.importance * 0.05
              )::float AS candidate_score,
              ${blockExcerpt} AS snippet
       FROM blocks b
       JOIN pages p ON p.id = b.page_id
       JOIN workspaces w
         ON w.id = p.workspace_id
        AND w.archived_at IS NULL
       WHERE ${conditions.join(' AND ')}
         AND b.archived_at IS NULL
         AND (
           to_tsvector('simple', b.content) @@ websearch_to_tsquery('simple', $${queryIndex})
           OR b.content % $${queryIndex}
           OR $${queryIndex} <% b.content
         )
     ), ranked_matches AS MATERIALIZED (
       SELECT id,
              candidate_score,
              snippet,
              ROW_NUMBER() OVER (
                PARTITION BY id
                ORDER BY candidate_score DESC, snippet, id
              ) AS match_rank
       FROM candidate_matches
     ), candidates AS MATERIALIZED (
       SELECT id, candidate_score, snippet
       FROM ranked_matches
       WHERE match_rank = 1
       ORDER BY candidate_score DESC, id
       LIMIT $${candidateLimitIndex}
     )
     SELECT p.id,
            p.workspace_id,
            p.session_id,
            p.parent_page_id,
            p.title,
            p.tags,
            p.importance,
            p.revision,
            p.created_at,
            p.updated_at,
            c.candidate_score::float AS score,
            LEFT(c.snippet, 400) AS snippet
     FROM candidates c
     JOIN pages p ON p.id = c.id
     ORDER BY c.candidate_score DESC, p.updated_at DESC
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
    parent_page_id: row.parent_page_id ?? null,
    database_id: null,
    tags: row.tags ?? [],
    importance: row.importance,
    revision: row.revision,
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  }));
}

async function searchRows(params: {
  query: string;
  workspace_id: string;
  database_id: string | null;
  tags?: string[];
  min_importance?: number;
  limit: number;
}): Promise<SearchRecord[]> {
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
  const candidateLimitIndex = index++;
  values.push(Math.min(500, Math.max(50, params.limit * 10)));
  const limitIndex = index;
  values.push(params.limit);
  const rowValueText = `database_row_value_search_text(
    v.value_text,
    v.value_json,
    v.value_number,
    v.value_date,
    v.value_bool
  )`;
  const rowValueExcerpt = searchExcerptSql(rowValueText, queryIndex);

  const pool = getPool();
  const { rows } = await pool.query<RowSearchRow>(
    `WITH candidate_matches AS MATERIALIZED (
       SELECT r.id,
              (2 + r.importance * 0.05)::float AS candidate_score,
              'Row ' || LEFT(r.id::text, 8) AS snippet
       FROM database_rows r
       JOIN databases d ON d.id = r.database_id
       JOIN workspaces w
         ON w.id = d.workspace_id
        AND w.archived_at IS NULL
       WHERE ${conditions.join(' AND ')}
         AND r.id = CASE
           WHEN $${queryIndex} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             THEN $${queryIndex}::uuid
           ELSE NULL
         END
       UNION ALL
       SELECT r.id,
              (
                CASE
                  WHEN to_tsvector(
                    'simple',
                    database_row_value_search_text(
                      v.value_text,
                      v.value_json,
                      v.value_number,
                      v.value_date,
                      v.value_bool
                    )
                  ) @@ websearch_to_tsquery('simple', $${queryIndex})
                    THEN ts_rank_cd(
                      to_tsvector(
                        'simple',
                        database_row_value_search_text(
                          v.value_text,
                          v.value_json,
                          v.value_number,
                          v.value_date,
                          v.value_bool
                        )
                      ),
                      websearch_to_tsquery('simple', $${queryIndex})
                    )
                  ELSE 0
                END
                + CASE
                    WHEN v.value_text IS NULL THEN 0
                    ELSE GREATEST(
                      similarity(v.value_text, $${queryIndex}),
                      word_similarity($${queryIndex}, v.value_text)
                    ) * 0.5
                  END
                + r.importance * 0.05
              )::float AS candidate_score,
              p.name || ': ' || ${rowValueExcerpt} AS snippet
       FROM database_row_values v
       JOIN database_rows r ON r.id = v.row_id
       JOIN databases d ON d.id = r.database_id
       JOIN workspaces w
         ON w.id = d.workspace_id
        AND w.archived_at IS NULL
       JOIN database_properties p
         ON p.id = v.property_id
        AND p.database_id = r.database_id
        AND p.archived_at IS NULL
       WHERE ${conditions.join(' AND ')}
         AND (
           to_tsvector(
             'simple',
             database_row_value_search_text(
               v.value_text,
               v.value_json,
               v.value_number,
               v.value_date,
               v.value_bool
             )
           ) @@ websearch_to_tsquery('simple', $${queryIndex})
           OR (
             v.value_text IS NOT NULL
             AND (v.value_text % $${queryIndex} OR $${queryIndex} <% v.value_text)
           )
         )
       UNION ALL
       SELECT r.id,
              (
                CASE
                  WHEN to_tsvector('simple', p.name)
                       @@ websearch_to_tsquery('simple', $${queryIndex})
                    THEN ts_rank_cd(
                      to_tsvector('simple', p.name),
                      websearch_to_tsquery('simple', $${queryIndex})
                    )
                  ELSE 0
                END
                + GREATEST(
                    similarity(p.name, $${queryIndex}),
                    word_similarity($${queryIndex}, p.name)
                  ) * 0.25
                + r.importance * 0.05
              )::float AS candidate_score,
              p.name || ': ' || ${rowValueText} AS snippet
       FROM database_properties p
       JOIN database_row_values v ON v.property_id = p.id
       JOIN database_rows r
         ON r.id = v.row_id
        AND r.database_id = p.database_id
       JOIN databases d ON d.id = r.database_id
       JOIN workspaces w
         ON w.id = d.workspace_id
        AND w.archived_at IS NULL
       WHERE ${conditions.join(' AND ')}
         AND p.archived_at IS NULL
         AND (
           to_tsvector('simple', p.name) @@ websearch_to_tsquery('simple', $${queryIndex})
           OR p.name % $${queryIndex}
           OR $${queryIndex} <% p.name
         )
     ), ranked_matches AS MATERIALIZED (
       SELECT id,
              candidate_score,
              snippet,
              ROW_NUMBER() OVER (
                PARTITION BY id
                ORDER BY candidate_score DESC, snippet, id
              ) AS match_rank
       FROM candidate_matches
     ), candidates AS MATERIALIZED (
       SELECT id, candidate_score, snippet
       FROM ranked_matches
       WHERE match_rank = 1
       ORDER BY candidate_score DESC, id
       LIMIT $${candidateLimitIndex}
     )
     SELECT r.id,
            d.workspace_id,
            r.database_id,
            COALESCE(title_value.value_text, 'Row ' || LEFT(r.id::text, 8)) AS title,
            r.tags,
            r.importance,
            r.revision,
            r.created_at,
            r.updated_at,
            c.candidate_score::float AS score,
            LEFT(c.snippet, 400) AS snippet
     FROM candidates c
     JOIN database_rows r ON r.id = c.id
     JOIN databases d ON d.id = r.database_id
     LEFT JOIN database_properties title_property
       ON title_property.database_id = r.database_id
      AND title_property.property_type = 'title'
      AND title_property.archived_at IS NULL
     LEFT JOIN database_row_values title_value
       ON title_value.row_id = r.id
      AND title_value.property_id = title_property.id
     ORDER BY c.candidate_score DESC, r.updated_at DESC
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
    parent_page_id: null,
    database_id: row.database_id,
    tags: row.tags ?? [],
    importance: row.importance,
    revision: row.revision,
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  }));
}

export async function searchRecords(params: {
  query: string;
  scope: ResolvedSearchScope;
  tags?: string[];
  min_importance?: number;
  limit?: number;
}): Promise<SearchRecordsResult> {
  const query = normalizeQuery(params.query);
  const limit = normalizeLimit(params.limit);
  const minImportance = normalizeImportance(params.min_importance);
  const candidateLimit = limit + 1;

  const [pages, rows] = await Promise.all([
    params.scope.types.includes('page')
      ? searchPages({
        query,
        workspace_id: params.scope.workspace_id,
        session_id: params.scope.session_id,
        tags: params.tags,
        min_importance: minImportance,
        limit: candidateLimit,
      })
      : Promise.resolve([]),
    params.scope.types.includes('row')
      ? searchRows({
        query,
        workspace_id: params.scope.workspace_id,
        database_id: params.scope.database_id,
        tags: params.tags,
        min_importance: minImportance,
        limit: candidateLimit,
      })
      : Promise.resolve([]),
  ]);

  const ranked = [...pages, ...rows]
    .sort((left, right) => right.score - left.score || right.updated_at.localeCompare(left.updated_at));
  return {
    records: ranked.slice(0, limit),
    truncated: ranked.length > limit,
  };
}
