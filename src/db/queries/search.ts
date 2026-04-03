import type { AccessContext } from '../access.js';
import { getPool } from '../client.js';
import { embed, vectorToSql } from '../../embeddings/index.js';
import { assertSessionReadAccess } from './accessControl.js';

export type SearchMode =
  | 'similarity'
  | 'similarity_recency'
  | 'similarity_importance'
  | 'full_text'
  | 'grep'
  | 'regex'
  | 'hybrid';

export interface SearchResult {
  id: string;
  type: 'page' | 'row';
  title: string;
  score: number;
  snippet: string;
  workspace_id: string | null;
  tags: string[];
}

export async function search(params: {
  query: string;
  mode: SearchMode;
  content_types?: ('pages' | 'rows')[];
  workspace_id?: string;
  session_id?: string;
  database_id?: string;
  tags?: string[];
  min_importance?: number;
  limit?: number;
  access?: AccessContext;
}): Promise<SearchResult[]> {
  const contentTypes = params.content_types ?? ['pages', 'rows'];
  const limit = params.limit ?? 20;
  const access = params.access ?? { kind: 'system' as const };

  if (params.session_id) {
    const session = await assertSessionReadAccess(params.session_id, access);
    if (params.workspace_id && params.workspace_id !== session.workspace_id) {
      throw new Error('session_id must belong to the requested workspace');
    }
  }

  let vec: number[] | null = null;
  if (params.mode !== 'full_text' && params.mode !== 'grep' && params.mode !== 'regex') {
    vec = await embed(params.query);
  }

  const results: SearchResult[] = [];

  if (contentTypes.includes('pages') && !params.database_id) {
    const pageResults = await searchPages({
      query: params.query,
      mode: params.mode,
      vec,
      workspace_id: params.workspace_id,
      session_id: params.session_id,
      tags: params.tags,
      min_importance: params.min_importance,
      limit,
      access,
    });
    results.push(...pageResults);
  }

  if (contentTypes.includes('rows') && !params.session_id) {
    const rowResults = await searchRows({
      query: params.query,
      mode: params.mode,
      vec,
      workspace_id: params.workspace_id,
      database_id: params.database_id,
      tags: params.tags,
      min_importance: params.min_importance,
      limit,
      access,
    });
    results.push(...rowResults);
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// Truncate text to ~200 chars at a word boundary for snippets
function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return text.slice(0, cut > 0 ? cut : max) + '…';
}

function pageKeywordScoreExpression(qParam: number): string {
  return `(
    ts_rank(to_tsvector('english', p.title), plainto_tsquery('english', $${qParam}))
    + COALESCE((
      SELECT SUM(ts_rank(to_tsvector('english', b_score.content), plainto_tsquery('english', $${qParam})))
      FROM blocks b_score
      WHERE b_score.page_id = p.id
        AND to_tsvector('english', b_score.content) @@ plainto_tsquery('english', $${qParam})
    ), 0)
  )`;
}

function pageKeywordMatchExpression(qParam: number): string {
  return `(
    to_tsvector('english', p.title) @@ plainto_tsquery('english', $${qParam})
    OR EXISTS (
      SELECT 1
      FROM blocks b
      WHERE b.page_id = p.id
        AND to_tsvector('english', b.content) @@ plainto_tsquery('english', $${qParam})
    )
  )`;
}

function rowValueTextExpression(alias: string): string {
  return `COALESCE(${alias}.value_text, ${alias}.value_json::text, ${alias}.value_number::text, ${alias}.value_date::text, ${alias}.value_bool::text, '')`;
}

function rowValueDisplayExpression(alias: string): string {
  return `COALESCE(${alias}.value_text, ${alias}.value_json::text, ${alias}.value_number::text, ${alias}.value_date::text, ${alias}.value_bool::text)`;
}

function rowValueTsVectorExpression(alias: string): string {
  return `to_tsvector('english', ${rowValueTextExpression(alias)})`;
}

function rowKeywordScoreExpression(qParam: number): string {
  return `COALESCE((
    SELECT SUM(ts_rank(${rowValueTsVectorExpression('v_score')}, plainto_tsquery('english', $${qParam})))
    FROM database_row_values v_score
    WHERE v_score.row_id = r.id
      AND ${rowValueTsVectorExpression('v_score')} @@ plainto_tsquery('english', $${qParam})
  ), 0)`;
}

function rowKeywordMatchExpression(qParam: number): string {
  return `EXISTS (
    SELECT 1
    FROM database_row_values v
    WHERE v.row_id = r.id
      AND ${rowValueTsVectorExpression('v')} @@ plainto_tsquery('english', $${qParam})
  )`;
}

async function searchPages(params: {
  query: string;
  mode: SearchMode;
  vec: number[] | null;
  workspace_id?: string;
  session_id?: string;
  tags?: string[];
  min_importance?: number;
  limit: number;
  access: AccessContext;
}): Promise<SearchResult[]> {
  const pool = getPool();

  if (params.mode === 'full_text') {
    const conditions = ['true'];
    const values: unknown[] = [];
    let idx = 1;

    if (params.workspace_id) { conditions.push(`p.workspace_id = $${idx++}`); values.push(params.workspace_id); }
    if (params.session_id) { conditions.push(`p.session_id = $${idx++}`); values.push(params.session_id); }
    if (params.tags?.length) { conditions.push(`p.tags && $${idx++}`); values.push(params.tags); }
    if (params.min_importance != null) { conditions.push(`p.importance >= $${idx++}`); values.push(params.min_importance); }
    void params.access;
    values.push(params.query);

    const keywordScore = pageKeywordScoreExpression(idx);
    const keywordMatch = pageKeywordMatchExpression(idx);

    const { rows } = await pool.query<{
      id: string; title: string; workspace_id: string | null; tags: string[];
      score: number; snippet: string | null;
    }>(
      `SELECT p.id, p.title, p.workspace_id, p.tags,
              (${keywordScore})::float AS score,
              COALESCE(
                (SELECT b.content
                 FROM blocks b
                 WHERE b.page_id = p.id
                   AND to_tsvector('english', b.content) @@ plainto_tsquery('english', $${idx})
                 ORDER BY b.position
                 LIMIT 1),
                (SELECT b.content
                 FROM blocks b
                 WHERE b.page_id = p.id AND b.content != ''
                 ORDER BY b.position LIMIT 1),
                p.title
              ) AS snippet
       FROM pages p
       WHERE ${conditions.join(' AND ')}
         AND ${keywordMatch}
       ORDER BY score DESC
       LIMIT ${params.limit}`,
      values
    );

    return rows.map((r) => ({
      id: r.id, type: 'page' as const, title: r.title, score: r.score,
      snippet: truncate(r.snippet ?? r.title),
      workspace_id: r.workspace_id, tags: r.tags,
    }));
  }

  if (params.mode === 'grep') {
    const conditions = ['true'];
    const values: unknown[] = [];
    let idx = 1;

    if (params.workspace_id) { conditions.push(`p.workspace_id = $${idx++}`); values.push(params.workspace_id); }
    if (params.session_id) { conditions.push(`p.session_id = $${idx++}`); values.push(params.session_id); }
    if (params.tags?.length) { conditions.push(`p.tags && $${idx++}`); values.push(params.tags); }
    if (params.min_importance != null) { conditions.push(`p.importance >= $${idx++}`); values.push(params.min_importance); }
    void params.access;

    values.push(`%${params.query}%`);
    const qParam = idx++;

    const { rows } = await pool.query<{
      id: string; title: string; workspace_id: string | null; tags: string[];
      score: number; snippet: string | null;
    }>(
      `SELECT p.id, p.title, p.workspace_id, p.tags,
              (
                CASE WHEN p.title ILIKE $${qParam} THEN 2 ELSE 0 END
                + COALESCE((
                  SELECT COUNT(*)
                  FROM blocks b_score
                  WHERE b_score.page_id = p.id
                    AND b_score.content ILIKE $${qParam}
                ), 0)
              )::float AS score,
              COALESCE(
                (SELECT b.content
                 FROM blocks b
                 WHERE b.page_id = p.id AND b.content ILIKE $${qParam}
                 ORDER BY b.position
                 LIMIT 1),
                p.title
              ) AS snippet
       FROM pages p
       WHERE ${conditions.join(' AND ')}
         AND (
           p.title ILIKE $${qParam}
           OR EXISTS (
             SELECT 1 FROM blocks b
             WHERE b.page_id = p.id
               AND b.content ILIKE $${qParam}
           )
         )
       ORDER BY score DESC, p.updated_at DESC
       LIMIT ${params.limit}`,
      values
    );

    return rows.map((r) => ({
      id: r.id, type: 'page' as const, title: r.title, score: r.score,
      snippet: truncate(r.snippet ?? r.title),
      workspace_id: r.workspace_id, tags: r.tags,
    }));
  }

  if (params.mode === 'regex') {
    const conditions = ['true'];
    const values: unknown[] = [];
    let idx = 1;

    if (params.workspace_id) { conditions.push(`p.workspace_id = $${idx++}`); values.push(params.workspace_id); }
    if (params.session_id) { conditions.push(`p.session_id = $${idx++}`); values.push(params.session_id); }
    if (params.tags?.length) { conditions.push(`p.tags && $${idx++}`); values.push(params.tags); }
    if (params.min_importance != null) { conditions.push(`p.importance >= $${idx++}`); values.push(params.min_importance); }
    void params.access;

    values.push(params.query);
    const qParam = idx++;

    const { rows } = await pool.query<{
      id: string; title: string; workspace_id: string | null; tags: string[];
      score: number; snippet: string | null;
    }>(
      `SELECT p.id, p.title, p.workspace_id, p.tags,
              (
                CASE WHEN p.title ~* $${qParam} THEN 2 ELSE 0 END
                + COALESCE((
                  SELECT COUNT(*)
                  FROM blocks b_score
                  WHERE b_score.page_id = p.id
                    AND b_score.content ~* $${qParam}
                ), 0)
              )::float AS score,
              COALESCE(
                (SELECT b.content
                 FROM blocks b
                 WHERE b.page_id = p.id AND b.content ~* $${qParam}
                 ORDER BY b.position
                 LIMIT 1),
                p.title
              ) AS snippet
       FROM pages p
       WHERE ${conditions.join(' AND ')}
         AND (
           p.title ~* $${qParam}
           OR EXISTS (
             SELECT 1 FROM blocks b
             WHERE b.page_id = p.id
               AND b.content ~* $${qParam}
           )
         )
       ORDER BY score DESC, p.updated_at DESC
       LIMIT ${params.limit}`,
      values
    );

    return rows.map((r) => ({
      id: r.id, type: 'page' as const, title: r.title, score: r.score,
      snippet: truncate(r.snippet ?? r.title),
      workspace_id: r.workspace_id, tags: r.tags,
    }));
  }

  // Vector-based modes
  const conditions: string[] = ['p.embedding IS NOT NULL'];
  const values: unknown[] = [];
  let idx = 1;

  if (params.workspace_id) { conditions.push(`p.workspace_id = $${idx++}`); values.push(params.workspace_id); }
  if (params.session_id) { conditions.push(`p.session_id = $${idx++}`); values.push(params.session_id); }
  if (params.tags?.length) { conditions.push(`p.tags && $${idx++}`); values.push(params.tags); }
  if (params.min_importance != null) { conditions.push(`p.importance >= $${idx++}`); values.push(params.min_importance); }
  void params.access;

  values.push(vectorToSql(params.vec!));
  const vecParam = idx++;

  let scoreExpr: string;
  switch (params.mode) {
    case 'similarity':
      scoreExpr = `1 - (p.embedding <=> $${vecParam}::vector)`;
      break;
    case 'similarity_recency':
      scoreExpr = `0.7 * (1 - (p.embedding <=> $${vecParam}::vector)) + 0.3 * EXP(-EXTRACT(EPOCH FROM (NOW() - p.created_at)) / (30 * 86400))`;
      break;
    case 'similarity_importance':
      scoreExpr = `0.6 * (1 - (p.embedding <=> $${vecParam}::vector)) + 0.4 * p.importance`;
      break;
    case 'hybrid': {
      values.push(params.query);
      const ftsParam = idx++;
      scoreExpr = `0.5 * (1 - (p.embedding <=> $${vecParam}::vector))
        + 0.2 * p.importance
        + 0.2 * EXP(-EXTRACT(EPOCH FROM (NOW() - p.created_at)) / (30 * 86400))
        + 0.1 * (${pageKeywordScoreExpression(ftsParam)})`;
      break;
    }
    default:
      scoreExpr = `1 - (p.embedding <=> $${vecParam}::vector)`;
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const { rows } = await pool.query<{
    id: string; title: string; workspace_id: string | null; tags: string[];
    score: number; snippet: string | null;
  }>(
    `SELECT p.id, p.title, p.workspace_id, p.tags,
            (${scoreExpr}) AS score,
            (SELECT b.content FROM blocks b
             WHERE b.page_id = p.id AND b.content != ''
             ORDER BY b.position LIMIT 1) AS snippet
     FROM pages p
     ${where}
     ORDER BY score DESC
     LIMIT ${params.limit}`,
    values
  );

  return rows.map((r) => ({
    id: r.id, type: 'page' as const, title: r.title, score: r.score,
    snippet: truncate(r.snippet ?? r.title),
    workspace_id: r.workspace_id, tags: r.tags,
  }));
}

async function searchRows(params: {
  query: string;
  mode: SearchMode;
  vec: number[] | null;
  workspace_id?: string;
  database_id?: string;
  tags?: string[];
  min_importance?: number;
  limit: number;
  access: AccessContext;
}): Promise<SearchResult[]> {
  const pool = getPool();

  if (params.mode === 'full_text') {
    const conditions: string[] = ['true'];
    const values: unknown[] = [];
    let idx = 1;

    if (params.database_id) { conditions.push(`r.database_id = $${idx++}`); values.push(params.database_id); }
    if (params.workspace_id) { conditions.push(`d.workspace_id = $${idx++}`); values.push(params.workspace_id); }
    if (params.tags?.length) { conditions.push(`r.tags && $${idx++}`); values.push(params.tags); }
    if (params.min_importance != null) { conditions.push(`r.importance >= $${idx++}`); values.push(params.min_importance); }
    void params.access;

    values.push(params.query);
    const qParam = idx++;
    const keywordMatch = rowKeywordMatchExpression(qParam);
    const keywordScore = rowKeywordScoreExpression(qParam);

    const { rows } = await pool.query<{
      id: string; database_id: string; workspace_id: string | null; tags: string[];
      score: number; title: string | null; snippet: string | null;
    }>(
      `SELECT r.id, r.database_id, d.workspace_id, r.tags,
              (${keywordScore})::float AS score,
              (SELECT v.value_text
               FROM database_row_values v
               JOIN database_properties p ON p.id = v.property_id
               WHERE v.row_id = r.id
                 AND p.property_type = 'title'
               LIMIT 1) AS title,
              (SELECT ${rowValueDisplayExpression('v2')}
               FROM database_row_values v2
               WHERE v2.row_id = r.id
                 AND ${rowValueTsVectorExpression('v2')} @@ plainto_tsquery('english', $${qParam})
               LIMIT 1) AS snippet
       FROM database_rows r
       JOIN databases d ON d.id = r.database_id
       WHERE ${conditions.join(' AND ')}
         AND ${keywordMatch}
       ORDER BY score DESC, r.updated_at DESC
       LIMIT ${params.limit}`,
      values
    );

    return rows.map((r) => ({
      id: r.id, type: 'row' as const,
      title: r.title ?? '(untitled row)',
      score: r.score,
      snippet: truncate(r.snippet ?? r.title ?? ''),
      workspace_id: r.workspace_id, tags: r.tags,
    }));
  }

  if (params.mode === 'grep') {
    const conditions: string[] = ['true'];
    const values: unknown[] = [];
    let idx = 1;

    if (params.database_id) { conditions.push(`r.database_id = $${idx++}`); values.push(params.database_id); }
    if (params.workspace_id) { conditions.push(`d.workspace_id = $${idx++}`); values.push(params.workspace_id); }
    if (params.tags?.length) { conditions.push(`r.tags && $${idx++}`); values.push(params.tags); }
    if (params.min_importance != null) { conditions.push(`r.importance >= $${idx++}`); values.push(params.min_importance); }
    void params.access;

    values.push(`%${params.query}%`);
    const qParam = idx++;

    const { rows } = await pool.query<{
      id: string; database_id: string; workspace_id: string | null; tags: string[];
      score: number; title: string | null; snippet: string | null;
    }>(
      `SELECT r.id, r.database_id, d.workspace_id, r.tags,
              (
                COALESCE((
                  SELECT COUNT(*)
                  FROM database_row_values v_score
                  WHERE v_score.row_id = r.id
                    AND (
                      v_score.value_text ILIKE $${qParam}
                      OR v_score.value_json::text ILIKE $${qParam}
                      OR v_score.value_number::text ILIKE $${qParam}
                      OR v_score.value_date::text ILIKE $${qParam}
                      OR v_score.value_bool::text ILIKE $${qParam}
                    )
                ), 0)
              )::float AS score,
              (SELECT v.value_text
               FROM database_row_values v
               JOIN database_properties p ON p.id = v.property_id
               WHERE v.row_id = r.id
                 AND p.property_type = 'title'
               LIMIT 1) AS title,
              (SELECT ${rowValueDisplayExpression('v2')}
               FROM database_row_values v2
               WHERE v2.row_id = r.id
                 AND (
                   v2.value_text ILIKE $${qParam}
                   OR v2.value_json::text ILIKE $${qParam}
                   OR v2.value_number::text ILIKE $${qParam}
                   OR v2.value_date::text ILIKE $${qParam}
                   OR v2.value_bool::text ILIKE $${qParam}
                 )
               LIMIT 1) AS snippet
       FROM database_rows r
       JOIN databases d ON d.id = r.database_id
       WHERE ${conditions.join(' AND ')}
         AND EXISTS (
           SELECT 1
           FROM database_row_values v
           WHERE v.row_id = r.id
             AND (
               v.value_text ILIKE $${qParam}
               OR v.value_json::text ILIKE $${qParam}
               OR v.value_number::text ILIKE $${qParam}
               OR v.value_date::text ILIKE $${qParam}
               OR v.value_bool::text ILIKE $${qParam}
             )
         )
       ORDER BY score DESC, r.updated_at DESC
       LIMIT ${params.limit}`,
      values
    );

    return rows.map((r) => ({
      id: r.id, type: 'row' as const,
      title: r.title ?? '(untitled row)',
      score: r.score,
      snippet: truncate(r.snippet ?? r.title ?? ''),
      workspace_id: r.workspace_id, tags: r.tags,
    }));
  }

  if (params.mode === 'regex') {
    const conditions: string[] = ['true'];
    const values: unknown[] = [];
    let idx = 1;

    if (params.database_id) { conditions.push(`r.database_id = $${idx++}`); values.push(params.database_id); }
    if (params.workspace_id) { conditions.push(`d.workspace_id = $${idx++}`); values.push(params.workspace_id); }
    if (params.tags?.length) { conditions.push(`r.tags && $${idx++}`); values.push(params.tags); }
    if (params.min_importance != null) { conditions.push(`r.importance >= $${idx++}`); values.push(params.min_importance); }
    void params.access;

    values.push(params.query);
    const qParam = idx++;

    const { rows } = await pool.query<{
      id: string; database_id: string; workspace_id: string | null; tags: string[];
      score: number; title: string | null; snippet: string | null;
    }>(
      `SELECT r.id, r.database_id, d.workspace_id, r.tags,
              (
                COALESCE((
                  SELECT COUNT(*)
                  FROM database_row_values v_score
                  WHERE v_score.row_id = r.id
                    AND (
                      v_score.value_text ~* $${qParam}
                      OR v_score.value_json::text ~* $${qParam}
                      OR v_score.value_number::text ~* $${qParam}
                      OR v_score.value_date::text ~* $${qParam}
                      OR v_score.value_bool::text ~* $${qParam}
                    )
                ), 0)
              )::float AS score,
              (SELECT v.value_text
               FROM database_row_values v
               JOIN database_properties p ON p.id = v.property_id
               WHERE v.row_id = r.id
                 AND p.property_type = 'title'
               LIMIT 1) AS title,
              (SELECT ${rowValueDisplayExpression('v2')}
               FROM database_row_values v2
               WHERE v2.row_id = r.id
                 AND (
                   v2.value_text ~* $${qParam}
                   OR v2.value_json::text ~* $${qParam}
                   OR v2.value_number::text ~* $${qParam}
                   OR v2.value_date::text ~* $${qParam}
                   OR v2.value_bool::text ~* $${qParam}
                 )
               LIMIT 1) AS snippet
       FROM database_rows r
       JOIN databases d ON d.id = r.database_id
       WHERE ${conditions.join(' AND ')}
         AND EXISTS (
           SELECT 1
           FROM database_row_values v
           WHERE v.row_id = r.id
             AND (
               v.value_text ~* $${qParam}
               OR v.value_json::text ~* $${qParam}
               OR v.value_number::text ~* $${qParam}
               OR v.value_date::text ~* $${qParam}
               OR v.value_bool::text ~* $${qParam}
             )
         )
       ORDER BY score DESC, r.updated_at DESC
       LIMIT ${params.limit}`,
      values
    );

    return rows.map((r) => ({
      id: r.id, type: 'row' as const,
      title: r.title ?? '(untitled row)',
      score: r.score,
      snippet: truncate(r.snippet ?? r.title ?? ''),
      workspace_id: r.workspace_id, tags: r.tags,
    }));
  }

  const conditions: string[] = ['r.embedding IS NOT NULL'];
  const values: unknown[] = [];
  let idx = 1;

  if (params.database_id) { conditions.push(`r.database_id = $${idx++}`); values.push(params.database_id); }
  if (params.workspace_id) { conditions.push(`d.workspace_id = $${idx++}`); values.push(params.workspace_id); }
  if (params.tags?.length) { conditions.push(`r.tags && $${idx++}`); values.push(params.tags); }
  if (params.min_importance != null) { conditions.push(`r.importance >= $${idx++}`); values.push(params.min_importance); }
  void params.access;

  values.push(vectorToSql(params.vec!));
  const vecParam = idx++;

  let scoreExpr: string;
  switch (params.mode) {
    case 'similarity':
      scoreExpr = `1 - (r.embedding <=> $${vecParam}::vector)`;
      break;
    case 'similarity_recency':
      scoreExpr = `0.7 * (1 - (r.embedding <=> $${vecParam}::vector)) + 0.3 * EXP(-EXTRACT(EPOCH FROM (NOW() - r.created_at)) / (30 * 86400))`;
      break;
    case 'similarity_importance':
      scoreExpr = `0.6 * (1 - (r.embedding <=> $${vecParam}::vector)) + 0.4 * r.importance`;
      break;
    case 'hybrid': {
      values.push(params.query);
      const ftsParam = idx++;
      scoreExpr = `0.5 * (1 - (r.embedding <=> $${vecParam}::vector))
        + 0.2 * r.importance
        + 0.2 * EXP(-EXTRACT(EPOCH FROM (NOW() - r.created_at)) / (30 * 86400))
        + 0.1 * (${rowKeywordScoreExpression(ftsParam)})`;
      break;
    }
    default:
      scoreExpr = `1 - (r.embedding <=> $${vecParam}::vector)`;
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const { rows } = await pool.query<{
    id: string; database_id: string; workspace_id: string | null; tags: string[];
    score: number; title: string | null; snippet: string | null;
  }>(
    `SELECT r.id, r.database_id, d.workspace_id, r.tags,
            (${scoreExpr}) AS score,
            (SELECT v.value_text
             FROM database_row_values v
             JOIN database_properties p ON p.id = v.property_id
             WHERE v.row_id = r.id AND p.property_type = 'title'
             LIMIT 1) AS title,
            (SELECT v2.value_text
             FROM database_row_values v2
             JOIN database_properties p2 ON p2.id = v2.property_id
             WHERE v2.row_id = r.id AND p2.property_type = 'text'
               AND v2.value_text IS NOT NULL AND v2.value_text != ''
             LIMIT 1) AS snippet
     FROM database_rows r
     JOIN databases d ON d.id = r.database_id
     ${where}
     ORDER BY score DESC
     LIMIT ${params.limit}`,
    values
  );

  return rows.map((r) => ({
    id: r.id, type: 'row' as const,
    title: r.title ?? '(untitled row)',
    score: r.score,
    snippet: truncate(r.snippet ?? r.title ?? ''),
    workspace_id: r.workspace_id, tags: r.tags,
  }));
}
