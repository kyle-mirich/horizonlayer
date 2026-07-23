import { getPool, type PoolClient } from '../client.js';
import { isPropertyType, type PropertyType } from '../../domain.js';
import { assertArchiveTransition } from './archiveState.js';
import { normalizePropertyOptions, type DatabaseProperty } from './databases.js';
import { requireActiveWorkspace } from './scopeGuards.js';

const ROW_COLUMNS = `
  id,
  database_id,
  tags,
  importance,
  revision,
  archived_at,
  created_at,
  updated_at
`;

const ROW_SELECT = `
  r.id,
  r.database_id,
  r.tags,
  r.importance,
  r.revision,
  r.archived_at,
  r.created_at,
  r.updated_at
`;

const ROW_VALUE_COLUMNS = `
  id,
  row_id,
  property_id,
  value_text,
  value_number,
  value_date,
  value_bool,
  value_json
`;

const PROPERTY_COLUMNS = `
  id,
  database_id,
  name,
  property_type,
  options,
  position,
  revision,
  archived_at,
  created_at,
  updated_at
`;

type Queryable = Pick<PoolClient, 'query'>;

export interface DatabaseRow {
  id: string;
  database_id: string;
  tags: string[];
  importance: number;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
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

export type RowFilter =
  | { property: string; operator: 'is_empty' }
  | {
      property: string;
      operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains';
      value: unknown;
    };

interface TypedValue {
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_bool: boolean | null;
  value_json: unknown | null;
}

interface DatabaseSchema {
  id: string;
  workspace_id: string;
  properties: DatabaseProperty[];
}

function assertRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error('revision must be a positive integer');
  }
}

function pagination(name: 'limit' | 'offset', value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  const max = name === 'limit' ? 101 : 1_000_000;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
  return resolved;
}

function assertImportance(importance: number | undefined): void {
  if (importance !== undefined && (!Number.isFinite(importance) || importance < 0 || importance > 1)) {
    throw new Error('importance must be a number between 0 and 1');
  }
}

function strictNumber(value: unknown, propertyName: string): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Property ${propertyName} must be a finite number`);
  }
  return value;
}

const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/u;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseDate(value: unknown, propertyName: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Property ${propertyName} must be a valid date`);
  }

  const match = ISO_DATE_TIME.exec(value);
  if (!match) {
    throw new Error(`Property ${propertyName} must be a valid date`);
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = match[4] === undefined ? undefined : Number.parseInt(match[4], 10);
  const minute = match[5] === undefined ? undefined : Number.parseInt(match[5], 10);
  const second = match[6] === undefined ? undefined : Number.parseInt(match[6], 10);
  const timezone = match[8];

  const invalidTime = hour !== undefined
    && (hour > 23 || minute === undefined || minute > 59 || (second !== undefined && second > 59));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || invalidTime) {
    throw new Error(`Property ${propertyName} must be a valid date`);
  }

  if (timezone !== undefined && timezone !== 'Z') {
    const timezoneHour = Number.parseInt(timezone.slice(1, 3), 10);
    const timezoneMinute = Number.parseInt(timezone.slice(timezone.includes(':') ? 4 : 3), 10);
    if (timezoneHour > 23 || timezoneMinute > 59) {
      throw new Error(`Property ${propertyName} must be a valid date`);
    }
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Property ${propertyName} must be a valid date`);
  }
  return date.toISOString();
}

function typedValue(property: DatabaseProperty, value: unknown): TypedValue {
  const empty: TypedValue = {
    value_text: null,
    value_number: null,
    value_date: null,
    value_bool: null,
    value_json: null,
  };
  switch (property.property_type) {
    case 'title':
      if (value == null) return empty;
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Property ${property.name} must be a non-empty string`);
      }
      return { ...empty, value_text: value };
    case 'text':
    case 'url':
      if (value == null) return empty;
      if (typeof value !== 'string') {
        throw new Error(`Property ${property.name} must be a string`);
      }
      return { ...empty, value_text: value };
    case 'number':
      return { ...empty, value_number: strictNumber(value, property.name) };
    case 'date':
      return { ...empty, value_date: parseDate(value, property.name) };
    case 'checkbox':
      if (value == null) return empty;
      if (typeof value !== 'boolean') {
        throw new Error(`Property ${property.name} must be a boolean`);
      }
      return { ...empty, value_bool: value };
    case 'select':
      if (value == null) return empty;
      if (typeof value !== 'string') {
        throw new Error(`Property ${property.name} must be a string`);
      }
      if (property.options.choices !== undefined && !property.options.choices.includes(value)) {
        throw new Error(`Property ${property.name} must be one of: ${property.options.choices.join(', ')}`);
      }
      return { ...empty, value_text: value };
    case 'multi_select':
      if (value == null) return empty;
      if (!Array.isArray(value) || value.some((choice) => typeof choice !== 'string')) {
        throw new Error(`Property ${property.name} must be an array of strings`);
      }
      if (property.options.choices !== undefined) {
        const invalid = value.find((choice) => !property.options.choices!.includes(choice));
        if (invalid !== undefined) {
          throw new Error(`Property ${property.name} contains unsupported choice: ${String(invalid)}`);
        }
      }
      return { ...empty, value_json: value };
    default:
      throw new Error(`Unsupported property type: ${String(property.property_type)}`);
  }
}

function valueForOutput(value: TypedValue, type: PropertyType): unknown {
  switch (type) {
    case 'title':
    case 'text':
    case 'url':
    case 'select':
      return value.value_text;
    case 'number':
      return value.value_number;
    case 'date':
      return value.value_date;
    case 'checkbox':
      return value.value_bool;
    case 'multi_select':
      return value.value_json;
    default:
      throw new Error(`Unsupported property type: ${String(type)}`);
  }
}

function extractStoredValue(value: RowValue, type: PropertyType): unknown {
  return valueForOutput(value, type);
}

function jsonParameter(value: unknown | null): string | null {
  // JavaScript null must become SQL NULL, not a JSONB `null` value.
  return value == null ? null : JSON.stringify(value);
}

function assertRowValues(
  values: Record<string, unknown>,
  properties: DatabaseProperty[],
  mode: 'create' | 'update'
): void {
  const byName = new Map(properties.map((property) => [property.name, property]));
  const unknown = Object.keys(values).filter((name) => !byName.has(name));
  if (unknown.length > 0) throw new Error(`Unknown properties: ${unknown.join(', ')}`);

  const missing = properties
    .filter((property) => property.property_type === 'title')
    .filter((property) => mode === 'create'
      ? !Object.prototype.hasOwnProperty.call(values, property.name) || values[property.name] == null
      : Object.prototype.hasOwnProperty.call(values, property.name) && values[property.name] == null)
    .map((property) => property.name);
  if (missing.length > 0) throw new Error(`Missing required properties: ${missing.join(', ')}`);

  for (const [name, value] of Object.entries(values)) {
    typedValue(byName.get(name)!, value);
  }
}

async function loadProperties(
  databaseId: string,
  includeArchived: boolean,
  queryable: Queryable
): Promise<DatabaseProperty[]> {
  const { rows } = await queryable.query<Array<DatabaseProperty>[number] & { property_type: string }>(
    `SELECT ${PROPERTY_COLUMNS}
     FROM database_properties
     WHERE database_id = $1
       AND ($2::boolean OR archived_at IS NULL)
     ORDER BY position ASC, created_at ASC`,
    [databaseId, includeArchived]
  );
  for (const property of rows) {
    if (!isPropertyType(property.property_type)) {
      throw new Error(`Unsupported property type: ${property.property_type}`);
    }
    property.options = normalizePropertyOptions(property.property_type, property.options);
  }
  return rows as DatabaseProperty[];
}

async function loadDatabaseSchema(
  databaseId: string,
  includeArchived: boolean,
  queryable: Queryable,
  lockForRowWrite = false
): Promise<DatabaseSchema | null> {
  const { rows } = await queryable.query<{ id: string; workspace_id: string }>(
    `SELECT id, workspace_id
     FROM databases
     WHERE id = $1
       AND ($2::boolean OR archived_at IS NULL)
     ${lockForRowWrite ? 'FOR SHARE' : ''}`,
    [databaseId, includeArchived]
  );
  const database = rows[0];
  if (!database) return null;
  return {
    ...database,
    properties: await loadProperties(databaseId, includeArchived, queryable),
  };
}

async function writeRowValues(
  client: PoolClient,
  rowId: string,
  values: Record<string, unknown>,
  properties: DatabaseProperty[]
): Promise<void> {
  const byName = new Map(properties.map((property) => [property.name, property]));
  for (const [name, rawValue] of Object.entries(values)) {
    const property = byName.get(name)!;
    const value = typedValue(property, rawValue);
    await client.query(
      `INSERT INTO database_row_values
         (row_id, property_id, value_text, value_number, value_date, value_bool, value_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (row_id, property_id) DO UPDATE SET
         value_text = EXCLUDED.value_text,
         value_number = EXCLUDED.value_number,
         value_date = EXCLUDED.value_date,
         value_bool = EXCLUDED.value_bool,
         value_json = EXCLUDED.value_json`,
      [
        rowId,
        property.id,
        value.value_text,
        value.value_number,
        value.value_date,
        value.value_bool,
        jsonParameter(value.value_json),
      ]
    );
  }
}

async function hydrateRows(
  rows: DatabaseRow[],
  properties: DatabaseProperty[],
  queryable: Queryable
): Promise<HydratedRow[]> {
  if (rows.length === 0) return [];
  const { rows: storedValues } = await queryable.query<RowValue>(
    `SELECT ${ROW_VALUE_COLUMNS}
     FROM database_row_values
     WHERE row_id = ANY($1::uuid[])`,
    [rows.map((row) => row.id)]
  );
  const propertiesById = new Map(properties.map((property) => [property.id, property]));
  const valuesByRow = new Map<string, Record<string, unknown>>();
  for (const stored of storedValues) {
    const property = propertiesById.get(stored.property_id);
    if (!property) continue;
    const values = valuesByRow.get(stored.row_id) ?? {};
    values[property.name] = extractStoredValue(stored, property.property_type);
    valuesByRow.set(stored.row_id, values);
  }
  return rows.map((row) => ({ ...row, values: valuesByRow.get(row.id) ?? {} }));
}

async function assertRowRevision(id: string, revision: number, queryable: Queryable = getPool()): Promise<void> {
  const { rows } = await queryable.query<{ revision: number }>(
    'SELECT revision FROM database_rows WHERE id = $1',
    [id]
  );
  if (rows[0] && rows[0].revision !== revision) {
    throw new Error(`Conflict: row ${id} is at revision ${rows[0].revision}, not ${revision}`);
  }
}

async function assertRowArchiveTransition(
  id: string,
  revision: number,
  archived: boolean,
  queryable: Queryable = getPool()
): Promise<void> {
  const { rows } = await queryable.query<{ revision: number; archived_at: string | null }>(
    'SELECT revision, archived_at FROM database_rows WHERE id = $1',
    [id]
  );
  assertArchiveTransition('row', id, revision, archived, rows[0]);
}

export async function createRow(params: {
  database_id: string;
  values: Record<string, unknown>;
  tags?: string[];
  importance?: number;
}): Promise<HydratedRow> {
  assertImportance(params.importance);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const database = await loadDatabaseSchema(params.database_id, false, client, true);
    if (!database) throw new Error(`Database ${params.database_id} not found`);
    await requireActiveWorkspace(database.workspace_id, client);
    assertRowValues(params.values, database.properties, 'create');

    const { rows } = await client.query<DatabaseRow>(
      `INSERT INTO database_rows (database_id, tags, importance)
       VALUES ($1, $2, $3)
       RETURNING ${ROW_COLUMNS}`,
      [params.database_id, params.tags ?? [], params.importance ?? 0.5]
    );
    await writeRowValues(client, rows[0].id, params.values, database.properties);
    const hydrated = (await hydrateRows(rows, database.properties, client))[0];
    await client.query('COMMIT');
    return hydrated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getRow(
  id: string,
  params: { include_archived?: boolean } = {}
): Promise<HydratedRow | null> {
  const pool = getPool();
  const includeArchived = params.include_archived ?? false;
  const { rows } = await pool.query<DatabaseRow & { workspace_id: string }>(
    `SELECT ${ROW_SELECT}, d.workspace_id
     FROM database_rows r
     JOIN databases d ON d.id = r.database_id
     WHERE r.id = $1
       AND ($2::boolean OR r.archived_at IS NULL)
       AND ($2::boolean OR d.archived_at IS NULL)`,
    [id, includeArchived]
  );
  const selected = rows[0];
  if (!selected) return null;
  const { workspace_id: workspaceId, ...row } = selected;
  await requireActiveWorkspace(workspaceId);
  const properties = await loadProperties(row.database_id, includeArchived, pool);
  return (await hydrateRows([row], properties, pool))[0];
}

function assertFilters(
  filters: RowFilter[] | undefined,
  properties: Map<string, DatabaseProperty>
): void {
  const operators = new Set(['eq', 'neq', 'gt', 'lt', 'contains', 'is_empty']);
  for (const filter of filters ?? []) {
    const property = properties.get(filter.property);
    if (!property) {
      throw new Error(`Unknown filter property: ${filter.property}`);
    }
    if (!operators.has(filter.operator)) {
      throw new Error(`Unsupported row filter operator: ${String(filter.operator)}`);
    }
    const hasValue = Object.prototype.hasOwnProperty.call(filter, 'value');
    if (filter.operator === 'is_empty' && hasValue) {
      throw new Error('is_empty filters cannot include a value');
    }
    if (filter.operator !== 'is_empty' && !hasValue) {
      throw new Error(`${filter.operator} filters require a value`);
    }
    if ((filter.operator === 'gt' || filter.operator === 'lt')
      && property.property_type !== 'number'
      && property.property_type !== 'date') {
      throw new Error(
        `Operator ${filter.operator} is not supported for ${property.property_type}; use it only with number or date properties`
      );
    }
    if (filter.operator === 'contains'
      && !['title', 'text', 'url', 'select', 'multi_select'].includes(property.property_type)) {
      throw new Error(
        `Operator contains is not supported for ${property.property_type} properties`
      );
    }
    if (filter.operator === 'contains' && typeof filter.value !== 'string') {
      throw new Error('contains filters require a string value');
    }
  }
}

function valueColumn(type: PropertyType): string {
  switch (type) {
    case 'number': return 'value_number';
    case 'date': return 'value_date';
    case 'checkbox': return 'value_bool';
    case 'multi_select':
      return 'value_json';
    case 'title':
    case 'text':
    case 'url':
    case 'select':
      return 'value_text';
    default:
      throw new Error(`Unsupported property type: ${String(type)}`);
  }
}

function filterValue(value: unknown, property: DatabaseProperty): unknown {
  const typed = typedValue(property, value);
  switch (property.property_type) {
    case 'number': return typed.value_number;
    case 'date': return typed.value_date;
    case 'checkbox': return typed.value_bool;
    case 'multi_select':
      return jsonParameter(typed.value_json);
    case 'title':
    case 'text':
    case 'url':
    case 'select':
      return typed.value_text;
    default:
      throw new Error(`Unsupported property type: ${String(property.property_type)}`);
  }
}

export async function queryRows(params: {
  database_id: string;
  filters?: RowFilter[];
  sort_by?: string;
  sort_direction?: 'asc' | 'desc';
  tags?: string[];
  include_archived?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ rows: HydratedRow[]; total: number }> {
  const pool = getPool();
  const includeArchived = params.include_archived ?? false;
  const limit = pagination('limit', params.limit, 50);
  const offset = pagination('offset', params.offset, 0);
  if (params.sort_direction !== undefined && params.sort_direction !== 'asc' && params.sort_direction !== 'desc') {
    throw new Error('sort_direction must be asc or desc');
  }
  if (params.sort_direction !== undefined && params.sort_by === undefined) {
    throw new Error('sort_direction requires sort_by');
  }

  const database = await loadDatabaseSchema(params.database_id, includeArchived, pool);
  if (!database) throw new Error(`Database ${params.database_id} not found`);
  await requireActiveWorkspace(database.workspace_id);
  const propertiesByName = new Map(database.properties.map((property) => [property.name, property]));
  assertFilters(params.filters, propertiesByName);
  if (params.sort_by && !propertiesByName.has(params.sort_by)) {
    throw new Error(`Unknown sort property: ${params.sort_by}`);
  }
  if (params.sort_by && propertiesByName.get(params.sort_by)?.property_type === 'multi_select') {
    throw new Error('multi_select properties cannot be used for sorting');
  }

  const conditions = [
    'r.database_id = $1',
    '($2::boolean OR r.archived_at IS NULL)',
    '($3::text[] IS NULL OR r.tags && $3::text[])',
  ];
  const values: unknown[] = [
    params.database_id,
    includeArchived,
    params.tags?.length ? params.tags : null,
  ];

  for (const filter of params.filters ?? []) {
    const property = propertiesByName.get(filter.property)!;
    const column = valueColumn(property.property_type);
    values.push(property.id);
    const propertyParameter = `$${values.length}`;

    if (filter.operator === 'is_empty') {
      conditions.push(
        `NOT EXISTS (SELECT 1 FROM database_row_values v
         WHERE v.row_id = r.id AND v.property_id = ${propertyParameter} AND v.${column} IS NOT NULL)`
      );
      continue;
    }

    if (filter.operator === 'contains') {
      values.push(filter.value);
      conditions.push(property.property_type === 'multi_select'
        ? `EXISTS (SELECT 1 FROM database_row_values v
           WHERE v.row_id = r.id AND v.property_id = ${propertyParameter}
             AND v.value_json ? $${values.length}::text)`
        : `EXISTS (SELECT 1 FROM database_row_values v
           WHERE v.row_id = r.id AND v.property_id = ${propertyParameter}
             AND STRPOS(LOWER(v.${column}::text), LOWER($${values.length}::text)) > 0)`);
      continue;
    }

    const normalizedValue = filterValue(filter.value, property);
    if (normalizedValue == null) {
      if (filter.operator !== 'eq' && filter.operator !== 'neq') {
        throw new Error(`${filter.operator} filters cannot compare against null`);
      }
      conditions.push(
        `${filter.operator === 'eq' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM database_row_values v
         WHERE v.row_id = r.id AND v.property_id = ${propertyParameter} AND v.${column} IS NOT NULL)`
      );
      continue;
    }

    values.push(normalizedValue);
    const valueParameter = `$${values.length}${column === 'value_json' ? '::jsonb' : ''}`;
    const comparison = filter.operator === 'eq'
      ? '='
      : filter.operator === 'neq'
        ? '='
        : filter.operator === 'gt'
          ? '>'
          : '<';
    conditions.push(
      `${filter.operator === 'neq' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM database_row_values v
       WHERE v.row_id = r.id AND v.property_id = ${propertyParameter}
         AND v.${column} ${comparison} ${valueParameter})`
    );
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM database_rows r ${where}`,
    values
  );
  const total = Number.parseInt(countRows[0]?.count ?? '0', 10);

  const rowValues = [...values];
  let orderBy = 'r.updated_at DESC, r.created_at DESC';
  if (params.sort_by) {
    const property = propertiesByName.get(params.sort_by)!;
    rowValues.push(property.id);
    const direction = params.sort_direction === 'desc' ? 'DESC' : 'ASC';
    orderBy = `(SELECT v.${valueColumn(property.property_type)} FROM database_row_values v
      WHERE v.row_id = r.id AND v.property_id = $${rowValues.length} LIMIT 1)
      ${direction} NULLS LAST, r.created_at DESC`;
  }
  rowValues.push(limit, offset);
  const { rows } = await pool.query<DatabaseRow>(
    `SELECT ${ROW_SELECT}
     FROM database_rows r
     ${where}
     ORDER BY ${orderBy}
     LIMIT $${rowValues.length - 1} OFFSET $${rowValues.length}`,
    rowValues
  );
  return { rows: await hydrateRows(rows, database.properties, pool), total };
}

export async function updateRow(
  id: string,
  params: {
    revision: number;
    values?: Record<string, unknown>;
    tags?: string[];
    importance?: number;
  }
): Promise<HydratedRow | null> {
  assertRevision(params.revision);
  assertImportance(params.importance);
  if (params.values !== undefined && Object.keys(params.values).length === 0) {
    throw new Error('Row value updates must contain at least one property');
  }
  if (params.values === undefined && params.tags === undefined && params.importance === undefined) {
    throw new Error('At least one row field is required');
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: identityRows } = await client.query<{ database_id: string }>(
      'SELECT database_id FROM database_rows WHERE id = $1',
      [id]
    );
    const identity = identityRows[0];
    if (!identity) {
      await client.query('ROLLBACK');
      return null;
    }
    const database = await loadDatabaseSchema(identity.database_id, false, client, true);
    if (!database) {
      await client.query('ROLLBACK');
      return null;
    }
    await requireActiveWorkspace(database.workspace_id, client);

    const { rows: selectedRows } = await client.query<DatabaseRow & { workspace_id: string }>(
      `SELECT ${ROW_SELECT}, d.workspace_id
       FROM database_rows r
       JOIN databases d ON d.id = r.database_id
       WHERE r.id = $1 AND r.database_id = $2
         AND r.archived_at IS NULL AND d.archived_at IS NULL
       FOR UPDATE OF r`,
      [id, identity.database_id]
    );
    const selected = selectedRows[0];
    if (!selected) {
      await client.query('ROLLBACK');
      return null;
    }
    const { workspace_id: workspaceId, ...currentRow } = selected;
    if (workspaceId !== database.workspace_id) {
      throw new Error(`Row ${id} changed databases during update`);
    }
    if (currentRow.revision !== params.revision) {
      throw new Error(`Conflict: row ${id} is at revision ${currentRow.revision}, not ${params.revision}`);
    }
    const properties = database.properties;
    if (params.values !== undefined) assertRowValues(params.values, properties, 'update');

    const sets = ['revision = revision + 1', 'updated_at = NOW()'];
    const values: unknown[] = [];
    let index = 1;
    if (params.tags !== undefined) {
      sets.unshift(`tags = $${index++}`);
      values.push(params.tags);
    }
    if (params.importance !== undefined) {
      sets.unshift(`importance = $${index++}`);
      values.push(params.importance);
    }
    values.push(id, params.revision);
    const { rows } = await client.query<DatabaseRow>(
      `UPDATE database_rows
       SET ${sets.join(', ')}
       WHERE id = $${index++} AND revision = $${index} AND archived_at IS NULL
       RETURNING ${ROW_COLUMNS}`,
      values
    );
    if (!rows[0]) await assertRowRevision(id, params.revision, client);
    if (params.values !== undefined) {
      await writeRowValues(client, id, params.values, properties);
    }
    const hydrated = rows[0] ? (await hydrateRows(rows, properties, client))[0] : null;
    await client.query('COMMIT');
    return hydrated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function setRowArchived(
  id: string,
  revision: number,
  archived: boolean
): Promise<HydratedRow | null> {
  assertRevision(revision);
  const client = await getPool().connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const { rows: identityRows } = await client.query<{ database_id: string }>(
      'SELECT database_id FROM database_rows WHERE id = $1',
      [id]
    );
    const identity = identityRows[0];
    if (!identity) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return null;
    }

    // Match create/update lock ordering: database first, then row, then the
    // workspace trigger. Database archive therefore cannot overtake this write.
    const database = await loadDatabaseSchema(identity.database_id, false, client, true);
    if (!database) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return null;
    }
    await requireActiveWorkspace(database.workspace_id, client);

    const { rows } = await client.query<DatabaseRow>(
      `UPDATE database_rows
       SET archived_at = ${archived ? 'NOW()' : 'NULL'},
           revision = revision + 1,
           updated_at = NOW()
       WHERE id = $1 AND database_id = $2 AND revision = $3
         AND archived_at IS ${archived ? 'NULL' : 'NOT NULL'}
       RETURNING ${ROW_COLUMNS}`,
      [id, identity.database_id, revision]
    );
    if (!rows[0]) await assertRowArchiveTransition(id, revision, archived, client);
    const hydrated = rows[0]
      ? (await hydrateRows(rows, database.properties, client))[0]
      : null;

    await client.query('COMMIT');
    transactionOpen = false;
    return hydrated;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function archiveRow(
  id: string,
  revision: number
): Promise<HydratedRow | null> {
  return setRowArchived(id, revision, true);
}

export function restoreRow(
  id: string,
  revision: number
): Promise<HydratedRow | null> {
  return setRowArchived(id, revision, false);
}
