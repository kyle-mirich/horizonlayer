import { isOrganizationAdmin, isSystemAccess, requireUserAccess, type AccessContext } from '../access.js';
import { getPool } from '../client.js';
import { embed, vectorToSql } from '../../embeddings/index.js';
import type { DatabaseProperty } from './databases.js';
import { assertDatabaseReadAccess, assertDatabaseWriteAccess, assertRowReadAccess, assertRowWriteAccess } from './accessControl.js';

export interface DatabaseRow {
  id: string;
  database_id: string;
  tags: string[];
  source: string | null;
  importance: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
}

export interface RowValue {
  id: string;
  row_id: string;
  property_id: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_bool: boolean | null;
  value_json: unknown | null;
}

export interface HydratedRow extends DatabaseRow {
  values: Record<string, unknown>;
}

export interface RowFilter {
  property: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'is_empty';
  value?: unknown;
}

function logEmbeddingFailure(entityId: string, error: unknown): void {
  console.error(`Failed to update row embedding for ${entityId}:`, error);
}

async function assertRowConflict(id: string, expectedUpdatedAt?: string): Promise<void> {
  if (!expectedUpdatedAt) {
    return;
  }
  const pool = getPool();
  const { rows } = await pool.query<{ updated_at: string }>(
    'SELECT updated_at FROM database_rows WHERE id = $1',
    [id]
  );
  if (rows[0]) {
    throw new Error(`Conflict: row ${id} was modified by another agent`);
  }
}

function setRowValue(
  prop: DatabaseProperty,
  value: unknown
): {
  value_text?: string | null;
  value_number?: number | null;
  value_date?: string | null;
  value_bool?: boolean | null;
  value_json?: unknown | null;
} {
  switch (prop.property_type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return { value_text: value != null ? String(value) : null };
    case 'number':
      return { value_number: value != null ? Number(value) : null };
    case 'date':
      return { value_date: value != null ? String(value) : null };
    case 'checkbox':
      return { value_bool: value != null ? Boolean(value) : null };
    case 'select':
    case 'multi_select':
    case 'files':
    case 'relation':
      return { value_json: value };
    default:
      return { value_text: value != null ? String(value) : null };
  }
}

function extractRowValue(val: RowValue, propType: string): unknown {
  switch (propType) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return val.value_text;
    case 'number':
      return val.value_number;
    case 'date':
      return val.value_date;
    case 'checkbox':
      return val.value_bool;
    case 'select':
    case 'multi_select':
    case 'files':
    case 'relation':
      return val.value_json;
    default:
      return val.value_text;
  }
}

export async function createRow(params: {
  database_id: string;
  values: Record<string, unknown>;
  tags?: string[];
  source?: string;
  importance?: number;
  expires_in_days?: number;
  properties: DatabaseProperty[];
  access?: AccessContext;
}): Promise<HydratedRow> {
  const pool = getPool();
  const client = await pool.connect();
  const access = params.access ?? { kind: 'system' as const };
  let committed = false;
  let rowId: string | null = null;

  if (!isSystemAccess(access)) {
    await assertDatabaseWriteAccess(params.database_id, access);
  }

  try {
    await client.query('BEGIN');

    const expiresAt = params.expires_in_days
      ? new Date(Date.now() + params.expires_in_days * 86400000).toISOString()
      : null;

    const { rows } = await client.query<DatabaseRow>(
      `INSERT INTO database_rows (database_id, tags, source, importance, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        params.database_id,
        params.tags ?? [],
        params.source ?? null,
        params.importance ?? 0.5,
        expiresAt,
      ]
    );
    const row = rows[0];
    rowId = row.id;

    // Insert values
    for (const prop of params.properties) {
      if (!(prop.name in params.values)) continue;
      const val = params.values[prop.name];
      const typed = setRowValue(prop, val);

      await client.query(
        `INSERT INTO database_row_values (row_id, property_id, value_text, value_number, value_date, value_bool, value_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (row_id, property_id) DO UPDATE SET
           value_text = EXCLUDED.value_text,
           value_number = EXCLUDED.value_number,
           value_date = EXCLUDED.value_date,
           value_bool = EXCLUDED.value_bool,
           value_json = EXCLUDED.value_json`,
        [
          row.id,
          prop.id,
          typed.value_text ?? null,
          typed.value_number ?? null,
          typed.value_date ?? null,
          typed.value_bool ?? null,
          typed.value_json !== undefined ? JSON.stringify(typed.value_json) : null,
        ]
      );
    }

    await client.query('COMMIT');
    committed = true;
  } catch (err) {
    if (!committed) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    client.release();
  }

  if (!rowId) {
    throw new Error('Row creation failed');
  }

  try {
    await updateRowEmbedding(rowId, params.values, params.properties);
  } catch (error) {
    logEmbeddingFailure(rowId, error);
  }

  const hydrated = await getRow(rowId, params.properties, access);
  if (!hydrated) {
    throw new Error(`Row ${rowId} not found after creation`);
  }
  return hydrated;
}

export async function getRow(
  id: string,
  properties: DatabaseProperty[],
  access: AccessContext = { kind: 'system' }
): Promise<HydratedRow | null> {
  const pool = getPool();

  if (!isSystemAccess(access)) {
    await assertRowReadAccess(id, access);
  }

  const { rows: rowRows } = await pool.query<DatabaseRow>(
    `UPDATE database_rows SET last_accessed_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!rowRows[0]) return null;

  const { rows: valRows } = await pool.query<RowValue>(
    'SELECT * FROM database_row_values WHERE row_id = $1',
    [id]
  );

  const propMap = new Map(properties.map((p) => [p.id, p]));
  const values: Record<string, unknown> = {};
  for (const val of valRows) {
    const prop = propMap.get(val.property_id);
    if (prop) {
      values[prop.name] = extractRowValue(val, prop.property_type);
    }
  }

  return { ...rowRows[0], values };
}

export async function getRowDatabaseId(
  id: string,
  access: AccessContext = { kind: 'system' }
): Promise<string | null> {
  if (!isSystemAccess(access)) {
    const result = await assertRowReadAccess(id, access);
    return result.database_id;
  }
  const pool = getPool();
  const { rows } = await pool.query<{ database_id: string }>(
    'SELECT database_id FROM database_rows WHERE id = $1',
    [id]
  );
  return rows[0]?.database_id ?? null;
}

export async function updateRow(
  id: string,
  params: {
    values?: Record<string, unknown>;
    tags?: string[];
    importance?: number;
    properties: DatabaseProperty[];
    expected_updated_at?: string;
  },
  access: AccessContext = { kind: 'system' }
): Promise<HydratedRow | null> {
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;

  if (!isSystemAccess(access)) {
    await assertRowWriteAccess(id, access);
  }

  try {
    await client.query('BEGIN');

    const sets: string[] = ['updated_at = NOW()'];
    const setValues: unknown[] = [];
    let idx = 1;

    if (params.tags !== undefined) {
      sets.push(`tags = $${idx++}`);
      setValues.push(params.tags);
    }
    if (params.importance !== undefined) {
      sets.push(`importance = $${idx++}`);
      setValues.push(params.importance);
    }

    setValues.push(id);
    if (params.expected_updated_at) {
      setValues.push(params.expected_updated_at);
    }
    const updateResult = await client.query(
      `UPDATE database_rows SET ${sets.join(', ')} WHERE id = $${idx}${params.expected_updated_at ? ` AND updated_at = $${idx + 1}` : ''}`,
      setValues
    );
    if ((updateResult.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      committed = true;
      await assertRowConflict(id, params.expected_updated_at);
      return null;
    }

    if (params.values) {
      for (const prop of params.properties) {
        if (!(prop.name in params.values)) continue;
        const val = params.values[prop.name];
        const typed = setRowValue(prop, val);

        await client.query(
          `INSERT INTO database_row_values (row_id, property_id, value_text, value_number, value_date, value_bool, value_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (row_id, property_id) DO UPDATE SET
             value_text = EXCLUDED.value_text,
             value_number = EXCLUDED.value_number,
             value_date = EXCLUDED.value_date,
             value_bool = EXCLUDED.value_bool,
             value_json = EXCLUDED.value_json`,
          [
            id,
            prop.id,
            typed.value_text ?? null,
            typed.value_number ?? null,
            typed.value_date ?? null,
            typed.value_bool ?? null,
            typed.value_json !== undefined ? JSON.stringify(typed.value_json) : null,
          ]
        );
      }
    }

    await client.query('COMMIT');
    committed = true;
  } catch (err) {
    if (!committed) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    client.release();
  }

  if (params.values) {
    try {
      const currentValues = await loadRowValues(id, params.properties);
      await updateRowEmbedding(id, currentValues, params.properties);
    } catch (error) {
      logEmbeddingFailure(id, error);
    }
  }

  const row = await getRow(id, params.properties, access);
  if (!row) {
    await assertRowConflict(id, params.expected_updated_at);
  }
  return row;
}

export async function deleteRow(
  id: string,
  access: AccessContext = { kind: 'system' },
  expected_updated_at?: string
): Promise<boolean> {
  if (!isSystemAccess(access)) {
    await assertRowWriteAccess(id, access);
  }
  const pool = getPool();
  const values: unknown[] = [id];
  let sql = 'DELETE FROM database_rows WHERE id = $1';
  if (expected_updated_at) {
    values.push(expected_updated_at);
    sql += ' AND updated_at = $2';
  }
  const { rowCount } = await pool.query(sql, values);
  if ((rowCount ?? 0) === 0) {
    await assertRowConflict(id, expected_updated_at);
  }
  return (rowCount ?? 0) > 0;
}

export async function queryRows(params: {
  database_id: string;
  filters?: RowFilter[];
  sort_by?: string;
  limit?: number;
  offset?: number;
  properties: DatabaseProperty[];
  access?: AccessContext;
}): Promise<{ rows: HydratedRow[]; total: number }> {
  const pool = getPool();
  const access = params.access ?? { kind: 'system' as const };

  if (!isSystemAccess(access)) {
    await assertDatabaseReadAccess(params.database_id, access);
  }

  const propByName = new Map(params.properties.map((p) => [p.name, p]));

  const conditions: string[] = ['r.database_id = $1'];
  const values: unknown[] = [params.database_id];
  let idx = 2;

  if (params.filters) {
    for (const filter of params.filters) {
      const prop = propByName.get(filter.property);
      if (!prop) continue;

      const col = getValueColumn(prop.property_type);

      switch (filter.operator) {
        case 'is_empty':
          conditions.push(
            `NOT EXISTS (SELECT 1 FROM database_row_values v WHERE v.row_id = r.id AND v.property_id = $${idx} AND ${col} IS NOT NULL)`
          );
          values.push(prop.id);
          idx++;
          break;
        case 'eq':
          conditions.push(
            `EXISTS (SELECT 1 FROM database_row_values v WHERE v.row_id = r.id AND v.property_id = $${idx} AND ${col} = $${idx + 1})`
          );
          values.push(prop.id, coerceValue(filter.value, prop.property_type));
          idx += 2;
          break;
        case 'neq':
          conditions.push(
            `NOT EXISTS (SELECT 1 FROM database_row_values v WHERE v.row_id = r.id AND v.property_id = $${idx} AND ${col} = $${idx + 1})`
          );
          values.push(prop.id, coerceValue(filter.value, prop.property_type));
          idx += 2;
          break;
        case 'gt':
          conditions.push(
            `EXISTS (SELECT 1 FROM database_row_values v WHERE v.row_id = r.id AND v.property_id = $${idx} AND ${col} > $${idx + 1})`
          );
          values.push(prop.id, coerceValue(filter.value, prop.property_type));
          idx += 2;
          break;
        case 'lt':
          conditions.push(
            `EXISTS (SELECT 1 FROM database_row_values v WHERE v.row_id = r.id AND v.property_id = $${idx} AND ${col} < $${idx + 1})`
          );
          values.push(prop.id, coerceValue(filter.value, prop.property_type));
          idx += 2;
          break;
        case 'contains':
          conditions.push(
            `EXISTS (SELECT 1 FROM database_row_values v WHERE v.row_id = r.id AND v.property_id = $${idx} AND ${getContainsExpression(prop.property_type)} ILIKE $${idx + 1})`
          );
          values.push(prop.id, `%${filter.value}%`);
          idx += 2;
          break;
      }
    }
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM database_rows r ${where}`,
    values
  );
  const total = parseInt(countRows[0].count);

  let orderBy = 'r.created_at DESC';
  if (params.sort_by) {
    const sortProp = propByName.get(params.sort_by);
    if (sortProp) {
      orderBy = `(SELECT ${getValueColumn(sortProp.property_type)} FROM database_row_values v WHERE v.row_id = r.id AND v.property_id = '${sortProp.id}' LIMIT 1) ASC NULLS LAST`;
    }
  }

  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const { rows: rowRows } = await pool.query<DatabaseRow>(
    `SELECT r.* FROM database_rows r ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
    values
  );

  if (rowRows.length === 0) return { rows: [], total };

  const rowIds = rowRows.map((r) => r.id);
  const { rows: valRows } = await pool.query<RowValue>(
    'SELECT * FROM database_row_values WHERE row_id = ANY($1)',
    [rowIds]
  );

  const propMap = new Map(params.properties.map((p) => [p.id, p]));
  const valsByRow = new Map<string, RowValue[]>();
  for (const val of valRows) {
    if (!valsByRow.has(val.row_id)) valsByRow.set(val.row_id, []);
    valsByRow.get(val.row_id)!.push(val);
  }

  const hydratedRows: HydratedRow[] = rowRows.map((row) => {
    const rowVals = valsByRow.get(row.id) ?? [];
    const values: Record<string, unknown> = {};
    for (const val of rowVals) {
      const prop = propMap.get(val.property_id);
      if (prop) values[prop.name] = extractRowValue(val, prop.property_type);
    }
    return { ...row, values };
  });

  return { rows: hydratedRows, total };
}

export async function countRows(params: {
  database_id: string;
  filters?: RowFilter[];
  properties: DatabaseProperty[];
  access?: AccessContext;
}): Promise<number> {
  const result = await queryRows({ ...params, limit: 0, offset: 0 });
  return result.total;
}

export async function bulkCreateRows(params: {
  database_id: string;
  rows: Array<{
    values: Record<string, unknown>;
    tags?: string[];
    source?: string;
    importance?: number;
    expires_in_days?: number;
  }>;
  properties: DatabaseProperty[];
  access?: AccessContext;
}): Promise<HydratedRow[]> {
  const access = params.access ?? { kind: 'system' as const };
  if (!isSystemAccess(access)) {
    await assertDatabaseWriteAccess(params.database_id, access);
  }
  const results: HydratedRow[] = [];
  for (const row of params.rows) {
    const created = await createRow({
      database_id: params.database_id,
      properties: params.properties,
      access,
      ...row,
    });
    results.push(created);
  }
  return results;
}

export async function cleanupExpired(
  access: AccessContext = { kind: 'system' }
): Promise<{ pages_deleted: number; rows_deleted: number }> {
  const pool = getPool();
  const now = new Date().toISOString();
  let pageCount = 0;
  let rowCount = 0;

  if (isSystemAccess(access) || isOrganizationAdmin(access)) {
    const pageResult = await pool.query(
      'DELETE FROM pages WHERE expires_at IS NOT NULL AND expires_at < $1',
      [now]
    );
    const rowResult = await pool.query(
      'DELETE FROM database_rows WHERE expires_at IS NOT NULL AND expires_at < $1',
      [now]
    );
    pageCount = pageResult.rowCount ?? 0;
    rowCount = rowResult.rowCount ?? 0;
  } else {
    const pageResult = await pool.query(
      `DELETE FROM pages p
       WHERE p.expires_at IS NOT NULL
         AND p.expires_at < $1
         AND p.workspace_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM workspaces w
           WHERE w.id = p.workspace_id
             AND w.owner_user_id = $2
         )`,
      [now, requireUserAccess(access).userId]
    );
    const rowResult = await pool.query(
      `DELETE FROM database_rows r
       USING databases d
       WHERE r.database_id = d.id
         AND r.expires_at IS NOT NULL
         AND r.expires_at < $1
         AND d.workspace_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM workspaces w
           WHERE w.id = d.workspace_id
             AND w.owner_user_id = $2
         )`,
      [now, requireUserAccess(access).userId]
    );
    pageCount = pageResult.rowCount ?? 0;
    rowCount = rowResult.rowCount ?? 0;
  }

  return {
    pages_deleted: pageCount,
    rows_deleted: rowCount,
  };
}

function getValueColumn(propType: string): string {
  switch (propType) {
    case 'number': return 'value_number';
    case 'date': return 'value_date';
    case 'checkbox': return 'value_bool';
    case 'select':
    case 'multi_select':
    case 'files':
    case 'relation':
      return 'value_json';
    default: return 'value_text';
  }
}

function getContainsExpression(propType: string): string {
  const valueColumn = getValueColumn(propType);
  switch (propType) {
    case 'number':
    case 'date':
    case 'checkbox':
      return `${valueColumn}::text`;
    case 'select':
    case 'multi_select':
    case 'files':
    case 'relation':
      return 'value_json::text';
    default:
      return valueColumn;
  }
}

function coerceValue(value: unknown, propType: string): unknown {
  if (propType === 'number') return Number(value);
  if (propType === 'checkbox') return Boolean(value);
  if (['select', 'multi_select', 'files', 'relation'].includes(propType)) {
    return value !== undefined ? JSON.stringify(value) : null;
  }
  return value;
}

async function updateRowEmbedding(
  rowId: string,
  values: Record<string, unknown>,
  properties: DatabaseProperty[]
): Promise<void> {
  const textParts: string[] = [];

  // Title first
  const titleProp = properties.find((p) => p.property_type === 'title');
  if (titleProp && values[titleProp.name] != null) {
    textParts.push(String(values[titleProp.name]));
  }

  // Then text/url/email fields
  for (const prop of properties) {
    if (prop.property_type === 'title') continue;
    if (['text', 'url', 'email'].includes(prop.property_type)) {
      const val = values[prop.name];
      if (val != null && String(val).trim()) {
        textParts.push(String(val));
      }
    }
  }

  const pool = getPool();
  if (textParts.length === 0) {
    await pool.query('UPDATE database_rows SET embedding = NULL WHERE id = $1', [rowId]);
    return;
  }

  const text = textParts.join('\n');
  const vec = await embed(text);
  await pool.query('UPDATE database_rows SET embedding = $1 WHERE id = $2', [vectorToSql(vec), rowId]);
}

async function loadRowValues(
  rowId: string,
  properties: DatabaseProperty[]
): Promise<Record<string, unknown>> {
  const pool = getPool();
  const { rows } = await pool.query<RowValue>(
    'SELECT * FROM database_row_values WHERE row_id = $1',
    [rowId]
  );

  const propMap = new Map(properties.map((property) => [property.id, property]));
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    const property = propMap.get(row.property_id);
    if (property) {
      values[property.name] = extractRowValue(row, property.property_type);
    }
  }
  return values;
}
