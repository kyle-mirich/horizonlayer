import { getPool, type PoolClient } from '../client.js';
import { isPropertyType, type PropertyType } from '../../domain.js';
import { withTransaction } from '../transaction.js';
import {
  lockActivePageForChildWrite,
  requireActivePage,
  requireActiveWorkspace,
  requireDatabase,
} from './scopeGuards.js';
import { assertArchiveTransition } from './archiveState.js';

const DATABASE_COLUMNS = `
  id,
  workspace_id,
  parent_page_id,
  name,
  description,
  tags,
  revision,
  archived_at,
  created_at,
  updated_at
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

export interface Database {
  id: string;
  workspace_id: string;
  parent_page_id: string | null;
  name: string;
  description: string | null;
  tags: string[];
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DatabaseProperty {
  id: string;
  database_id: string;
  name: string;
  property_type: PropertyType;
  options: PropertyOptions;
  position: number;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DatabaseWithProperties extends Database {
  properties: DatabaseProperty[];
}

export interface DatabasePropertyMutationResult {
  property: DatabaseProperty;
  database_revision: number;
}

export interface PropertyInput {
  name: string;
  property_type: PropertyType | string;
  options?: Record<string, unknown>;
}

export interface PropertyOptions {
  choices?: string[];
}

export function normalizePropertyOptions(
  propertyType: PropertyType,
  input: unknown
): PropertyOptions {
  if (input === undefined) return {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Options for ${propertyType} must be an object`);
  }

  const options = input as Record<string, unknown>;
  const keys = Object.keys(options);
  if (propertyType !== 'select' && propertyType !== 'multi_select') {
    if (keys.length > 0) {
      throw new Error(`Property type ${propertyType} does not accept options`);
    }
    return {};
  }

  if (keys.length === 0) return {};
  if (keys.length !== 1 || keys[0] !== 'choices' || !Array.isArray(options.choices)) {
    throw new Error(`Options for ${propertyType} must be exactly { choices: string[] }`);
  }
  if (options.choices.length > 100) {
    throw new Error('Property choices cannot exceed 100 items');
  }

  const choices: string[] = [];
  const normalized = new Set<string>();
  for (const choice of options.choices) {
    if (typeof choice !== 'string' || !choice.trim()) {
      throw new Error('Property choices must be non-empty strings');
    }
    const trimmed = choice.trim();
    const key = trimmed.toLocaleLowerCase();
    if (normalized.has(key)) {
      throw new Error(`Duplicate property choice: ${trimmed}`);
    }
    normalized.add(key);
    choices.push(trimmed);
  }
  return { choices };
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

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} cannot be empty`);
  return normalized;
}

function normalizeProperties(inputs: PropertyInput[] | undefined): Array<{
  name: string;
  property_type: PropertyType;
  options: PropertyOptions;
}> {
  const normalized = (inputs ?? []).map((input) => {
    const name = nonEmpty(input.name, 'Property name');
    if (!isPropertyType(input.property_type)) {
      throw new Error(`Unsupported property type: ${input.property_type}`);
    }
    return {
      name,
      property_type: input.property_type,
      options: normalizePropertyOptions(input.property_type, input.options),
    };
  });

  const names = new Set<string>();
  for (const property of normalized) {
    const key = property.name.toLocaleLowerCase();
    if (names.has(key)) {
      throw new Error(`Duplicate database property name: ${property.name}`);
    }
    names.add(key);
  }

  const titleCount = normalized.filter((property) => property.property_type === 'title').length;
  if (titleCount > 1) {
    throw new Error('A database can have only one title property');
  }
  if (titleCount === 0) {
    let name = 'Title';
    let suffix = 2;
    while (names.has(name.toLocaleLowerCase())) {
      name = `Title ${suffix}`;
      suffix += 1;
    }
    normalized.unshift({ name, property_type: 'title', options: {} });
  }
  if (normalized.length > 100) {
    throw new Error('A database can have at most 100 active properties');
  }
  return normalized;
}

async function assertDatabaseRevision(
  id: string,
  revision: number,
  queryable: Pick<PoolClient, 'query'> = getPool()
): Promise<void> {
  const { rows } = await queryable.query<{ revision: number }>(
    'SELECT revision FROM databases WHERE id = $1',
    [id]
  );
  if (rows[0] && rows[0].revision !== revision) {
    throw new Error(`Conflict: database ${id} is at revision ${rows[0].revision}, not ${revision}`);
  }
}

async function assertDatabaseArchiveTransition(
  id: string,
  revision: number,
  archived: boolean,
  queryable: Pick<PoolClient, 'query'> = getPool()
): Promise<void> {
  const { rows } = await queryable.query<{ revision: number; archived_at: string | null }>(
    'SELECT revision, archived_at FROM databases WHERE id = $1',
    [id]
  );
  assertArchiveTransition('database', id, revision, archived, rows[0]);
}

async function assertPropertyRevision(
  id: string,
  revision: number,
  queryable: Pick<PoolClient, 'query'> = getPool()
): Promise<void> {
  const { rows } = await queryable.query<{ revision: number }>(
    'SELECT revision FROM database_properties WHERE id = $1',
    [id]
  );
  if (rows[0] && rows[0].revision !== revision) {
    throw new Error(`Conflict: database property ${id} is at revision ${rows[0].revision}, not ${revision}`);
  }
}

export async function createDatabase(params: {
  workspace_id: string;
  name: string;
  properties?: PropertyInput[];
  parent_page_id?: string;
  description?: string;
  tags?: string[];
}): Promise<DatabaseWithProperties> {
  const name = nonEmpty(params.name, 'Database name');
  const properties = normalizeProperties(params.properties);

  await requireActiveWorkspace(params.workspace_id);
  if (params.parent_page_id) {
    const parent = await requireActivePage(params.parent_page_id);
    if (parent.workspace_id !== params.workspace_id) {
      throw new Error('workspace_id must match the parent page workspace');
    }
  }

  return withTransaction(async (client) => {
    if (params.parent_page_id) {
      const lockedParent = await lockActivePageForChildWrite(params.parent_page_id, client);
      if (lockedParent.workspace_id !== params.workspace_id) {
        throw new Error('workspace_id must match the parent page workspace');
      }
    }
    const { rows } = await client.query<Database>(
      `INSERT INTO databases (workspace_id, parent_page_id, name, description, tags)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${DATABASE_COLUMNS}`,
      [
        params.workspace_id,
        params.parent_page_id ?? null,
        name,
        params.description?.trim() || null,
        params.tags ?? [],
      ]
    );
    const database = rows[0];
    const createdProperties: DatabaseProperty[] = [];

    for (let position = 0; position < properties.length; position += 1) {
      const property = properties[position];
      const { rows: propertyRows } = await client.query<DatabaseProperty>(
        `INSERT INTO database_properties
           (database_id, name, property_type, options, position)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${PROPERTY_COLUMNS}`,
        [
          database.id,
          property.name,
          property.property_type,
          JSON.stringify(property.options),
          position,
        ]
      );
      createdProperties.push(propertyRows[0]);
    }

    return { ...database, properties: createdProperties };
  });
}

export async function getDatabase(
  id: string,
  params: { include_archived?: boolean } = {}
): Promise<DatabaseWithProperties | null> {
  const pool = getPool();
  const includeArchived = params.include_archived ?? false;
  const { rows } = await pool.query<Database>(
    `SELECT ${DATABASE_COLUMNS}
     FROM databases
     WHERE id = $1
       AND ($2::boolean OR archived_at IS NULL)`,
    [id, includeArchived]
  );
  const database = rows[0];
  if (!database) return null;

  await requireActiveWorkspace(database.workspace_id);
  const { rows: properties } = await pool.query<DatabaseProperty>(
    `SELECT ${PROPERTY_COLUMNS}
     FROM database_properties
     WHERE database_id = $1
       AND ($2::boolean OR archived_at IS NULL)
     ORDER BY position ASC, created_at ASC`,
    [id, includeArchived]
  );
  return { ...database, properties };
}

export async function listDatabases(params: {
  workspace_id: string;
  tags?: string[];
  include_archived?: boolean;
  limit?: number;
  offset?: number;
}): Promise<Database[]> {
  const pool = getPool();
  const limit = pagination('limit', params.limit, 50);
  const offset = pagination('offset', params.offset, 0);
  const includeArchived = params.include_archived ?? false;
  await requireActiveWorkspace(params.workspace_id);

  const { rows } = await pool.query<Database>(
    `SELECT ${DATABASE_COLUMNS}
     FROM databases
     WHERE workspace_id = $1
       AND ($2::boolean OR archived_at IS NULL)
       AND ($3::text[] IS NULL OR tags && $3::text[])
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $4 OFFSET $5`,
    [params.workspace_id, includeArchived, params.tags?.length ? params.tags : null, limit, offset]
  );
  return rows;
}

export async function updateDatabase(
  id: string,
  params: {
    revision: number;
    name?: string;
    description?: string | null;
    tags?: string[];
  }
): Promise<Database | null> {
  assertRevision(params.revision);
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  if (params.name !== undefined) {
    sets.push(`name = $${index++}`);
    values.push(nonEmpty(params.name, 'Database name'));
  }
  if (params.description !== undefined) {
    sets.push(`description = $${index++}`);
    values.push(params.description?.trim() || null);
  }
  if (params.tags !== undefined) {
    sets.push(`tags = $${index++}`);
    values.push(params.tags);
  }
  if (sets.length === 0) throw new Error('At least one database field is required');

  await requireDatabase(id);
  sets.push('revision = revision + 1', 'updated_at = NOW()');
  values.push(id, params.revision);
  const { rows } = await getPool().query<Database>(
    `UPDATE databases
     SET ${sets.join(', ')}
     WHERE id = $${index++}
       AND revision = $${index}
       AND archived_at IS NULL
     RETURNING ${DATABASE_COLUMNS}`,
    values
  );
  if (!rows[0]) await assertDatabaseRevision(id, params.revision);
  return rows[0] ?? null;
}

async function setDatabaseArchived(
  id: string,
  revision: number,
  archived: boolean
): Promise<Database | null> {
  assertRevision(revision);
  await requireDatabase(id);
  const { rows } = await getPool().query<Database>(
    `UPDATE databases
     SET archived_at = ${archived ? 'NOW()' : 'NULL'},
         revision = revision + 1,
         updated_at = NOW()
     WHERE id = $1
       AND revision = $2
       AND archived_at IS ${archived ? 'NULL' : 'NOT NULL'}
     RETURNING ${DATABASE_COLUMNS}`,
    [id, revision]
  );
  if (!rows[0]) await assertDatabaseArchiveTransition(id, revision, archived);
  return rows[0] ?? null;
}

export function archiveDatabase(
  id: string,
  revision: number
): Promise<Database | null> {
  return setDatabaseArchived(id, revision, true);
}

export function restoreDatabase(
  id: string,
  revision: number
): Promise<Database | null> {
  return setDatabaseArchived(id, revision, false);
}

export async function addDatabaseProperty(
  databaseId: string,
  params: {
    database_revision: number;
    name: string;
    property_type: PropertyType | string;
    options?: Record<string, unknown>;
  }
): Promise<DatabasePropertyMutationResult> {
  assertRevision(params.database_revision);
  const name = nonEmpty(params.name, 'Property name');
  if (!isPropertyType(params.property_type)) {
    throw new Error(`Unsupported property type: ${params.property_type}`);
  }
  const options = normalizePropertyOptions(params.property_type, params.options);
  await requireDatabase(databaseId);

  return withTransaction(async (client, transaction) => {
    const { rows: databaseRows } = await client.query<{ id: string; revision: number }>(
      `UPDATE databases
       SET revision = revision + 1, updated_at = NOW()
       WHERE id = $1 AND revision = $2 AND archived_at IS NULL
       RETURNING id, revision`,
      [databaseId, params.database_revision]
    );
    if (!databaseRows[0]) {
      await transaction.rollback();
      await assertDatabaseRevision(databaseId, params.database_revision, client);
      throw new Error(`Database ${databaseId} not found`);
    }

    const { rows: duplicates } = await client.query<{ id: string }>(
      `SELECT id
       FROM database_properties
       WHERE database_id = $1
         AND archived_at IS NULL
         AND LOWER(BTRIM(name)) = LOWER(BTRIM($2))
       LIMIT 1`,
      [databaseId, name]
    );
    if (duplicates[0]) throw new Error(`Property ${name} already exists in database ${databaseId}`);

    if (params.property_type === 'title') {
      const { rows: titleRows } = await client.query<{ id: string }>(
        `SELECT id FROM database_properties
         WHERE database_id = $1 AND property_type = 'title' AND archived_at IS NULL
         LIMIT 1`,
        [databaseId]
      );
      if (titleRows[0]) throw new Error('A database can have only one title property');
    }

    const { rows: countRows } = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM database_properties
       WHERE database_id = $1 AND archived_at IS NULL`,
      [databaseId]
    );
    if ((countRows[0]?.count ?? 0) >= 100) {
      throw new Error('A database can have at most 100 active properties');
    }

    const { rows: maxRows } = await client.query<{ max_position: number | null }>(
      'SELECT MAX(position) AS max_position FROM database_properties WHERE database_id = $1',
      [databaseId]
    );
    const position = (maxRows[0]?.max_position ?? -1) + 1;
    const { rows } = await client.query<DatabaseProperty>(
      `INSERT INTO database_properties
         (database_id, name, property_type, options, position)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PROPERTY_COLUMNS}`,
      [databaseId, name, params.property_type, JSON.stringify(options), position]
    );
    return { property: rows[0], database_revision: databaseRows[0].revision };
  });
}

interface LockedProperty {
  id: string;
  database_id: string;
  name: string;
  property_type: PropertyType;
  position: number;
  revision: number;
  archived_at: string | null;
}

interface LockedParentDatabase {
  id: string;
  archived_at: string | null;
  workspace_archived_at: string | null;
}

async function lockParentDatabaseForProperty(
  client: PoolClient,
  propertyId: string
): Promise<string | null> {
  const { rows } = await client.query<LockedParentDatabase>(
    `SELECT d.id, d.archived_at, w.archived_at AS workspace_archived_at
     FROM database_properties p
     JOIN databases d ON d.id = p.database_id
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE p.id = $1
     FOR UPDATE OF d`,
    [propertyId]
  );
  const database = rows[0];
  if (!database) return null;
  if (database.archived_at || database.workspace_archived_at) {
    throw new Error(`Database ${database.id} not found`);
  }
  return database.id;
}

async function lockProperty(client: PoolClient, id: string): Promise<LockedProperty | null> {
  const { rows } = await client.query<LockedProperty>(
    `SELECT id, database_id, name, property_type, position, revision, archived_at
     FROM database_properties
     WHERE id = $1
     FOR UPDATE`,
    [id]
  );
  return rows[0] ?? null;
}

async function bumpParentDatabaseRevision(client: PoolClient, databaseId: string): Promise<number> {
  const { rows } = await client.query<{ revision: number }>(
    `UPDATE databases
     SET revision = revision + 1, updated_at = NOW()
     WHERE id = $1 AND archived_at IS NULL
     RETURNING revision`,
    [databaseId]
  );
  if (!rows[0]) throw new Error(`Database ${databaseId} not found`);
  return rows[0].revision;
}

export async function updateDatabaseProperty(
  propertyId: string,
  params: {
    revision: number;
    name?: string;
    options?: Record<string, unknown>;
  }
): Promise<DatabasePropertyMutationResult | null> {
  assertRevision(params.revision);
  if (Object.prototype.hasOwnProperty.call(params, 'property_type')) {
    throw new Error('A database property type cannot be changed');
  }
  if (params.name === undefined && params.options === undefined) {
    throw new Error('At least one property field is required');
  }

  return withTransaction(async (client, transaction) => {
    const databaseId = await lockParentDatabaseForProperty(client, propertyId);
    if (!databaseId) {
      await transaction.rollback();
      return null;
    }
    const property = await lockProperty(client, propertyId);
    if (!property) {
      await transaction.rollback();
      return null;
    }
    if (property.database_id !== databaseId) {
      throw new Error(`Database property ${propertyId} changed databases during update`);
    }
    if (property.revision !== params.revision) {
      throw new Error(`Conflict: database property ${propertyId} is at revision ${property.revision}, not ${params.revision}`);
    }
    if (property.archived_at) {
      await transaction.rollback();
      return null;
    }

    const nextName = params.name === undefined ? property.name : nonEmpty(params.name, 'Property name');
    const nextOptions = params.options === undefined
      ? undefined
      : normalizePropertyOptions(property.property_type, params.options);
    const { rows: duplicateRows } = await client.query<{ id: string }>(
      `SELECT id FROM database_properties
       WHERE database_id = $1 AND id <> $2 AND archived_at IS NULL
         AND LOWER(BTRIM(name)) = LOWER(BTRIM($3))
       LIMIT 1`,
      [property.database_id, propertyId, nextName]
    );
    if (duplicateRows[0]) {
      throw new Error(`Property ${nextName} already exists in database ${property.database_id}`);
    }

    if (nextOptions?.choices !== undefined) {
      const invalidValuesSql = property.property_type === 'select'
        ? `SELECT EXISTS (
             SELECT 1 FROM database_row_values
             WHERE property_id = $1 AND value_text IS NOT NULL
               AND NOT (value_text = ANY($2::text[]))
           ) AS invalid`
        : `SELECT EXISTS (
             SELECT 1
             FROM database_row_values v
             WHERE v.property_id = $1 AND v.value_json IS NOT NULL
               AND (
                 jsonb_typeof(v.value_json) <> 'array'
                 OR EXISTS (
                   SELECT 1
                   FROM jsonb_array_elements_text(
                     CASE WHEN jsonb_typeof(v.value_json) = 'array'
                       THEN v.value_json ELSE '[]'::jsonb END
                   ) AS selected(value)
                   WHERE NOT (selected.value = ANY($2::text[]))
                 )
               )
           ) AS invalid`;
      const { rows: invalidRows } = await client.query<{ invalid: boolean }>(
        invalidValuesSql,
        [propertyId, nextOptions.choices]
      );
      if (invalidRows[0]?.invalid) {
        throw new Error('Updated choices would invalidate existing row values');
      }
    }

    const { rows } = await client.query<DatabaseProperty>(
      `UPDATE database_properties
       SET name = $1,
           options = COALESCE($2::jsonb, options),
           revision = revision + 1,
           updated_at = NOW()
       WHERE id = $3 AND revision = $4 AND archived_at IS NULL
       RETURNING ${PROPERTY_COLUMNS}`,
      [
        nextName,
        nextOptions === undefined ? null : JSON.stringify(nextOptions),
        propertyId,
        params.revision,
      ]
    );
    if (!rows[0]) await assertPropertyRevision(propertyId, params.revision, client);
    const databaseRevision = rows[0]
      ? await bumpParentDatabaseRevision(client, property.database_id)
      : null;
    return rows[0] && databaseRevision !== null
      ? { property: rows[0], database_revision: databaseRevision }
      : null;
  });
}

async function setPropertyArchived(
  propertyId: string,
  revision: number,
  archived: boolean
): Promise<DatabasePropertyMutationResult | null> {
  assertRevision(revision);
  return withTransaction(async (client, transaction) => {
    const databaseId = await lockParentDatabaseForProperty(client, propertyId);
    if (!databaseId) {
      await transaction.rollback();
      return null;
    }
    const property = await lockProperty(client, propertyId);
    if (!property) {
      await transaction.rollback();
      return null;
    }
    if (property.database_id !== databaseId) {
      throw new Error(`Database property ${propertyId} changed databases during update`);
    }
    if (property.revision !== revision) {
      throw new Error(`Conflict: database property ${propertyId} is at revision ${property.revision}, not ${revision}`);
    }
    assertArchiveTransition('database property', propertyId, revision, archived, property);
    if (archived && property.property_type === 'title') {
      throw new Error('The title property cannot be archived');
    }
    if (archived) {
      const { rows: valueRows } = await client.query<{ has_values: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM database_row_values
          WHERE property_id = $1
            AND (value_text IS NOT NULL OR value_number IS NOT NULL
              OR value_date IS NOT NULL OR value_bool IS NOT NULL
              OR value_json IS NOT NULL)
        ) AS has_values`,
        [propertyId]
      );
      if (valueRows[0]?.has_values) {
        throw new Error(`Database property ${propertyId} still has row values and cannot be archived`);
      }
    }

    if (!archived) {
      const { rows: countRows } = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM database_properties
         WHERE database_id = $1 AND archived_at IS NULL`,
        [property.database_id]
      );
      if ((countRows[0]?.count ?? 0) >= 100) {
        throw new Error('A database can have at most 100 active properties');
      }
      const { rows: conflicts } = await client.query<{ id: string }>(
        `SELECT id FROM database_properties
         WHERE database_id = $1 AND id <> $2 AND archived_at IS NULL
           AND (LOWER(BTRIM(name)) = LOWER(BTRIM($3)) OR position = $4
             OR ($5 = 'title' AND property_type = 'title'))
         LIMIT 1`,
        [property.database_id, propertyId, property.name, property.position, property.property_type]
      );
      if (conflicts[0]) throw new Error('Property cannot be restored because an active property conflicts');
    }

    const { rows } = await client.query<DatabaseProperty>(
      `UPDATE database_properties
       SET archived_at = ${archived ? 'NOW()' : 'NULL'},
           revision = revision + 1,
           updated_at = NOW()
       WHERE id = $1 AND revision = $2
         AND archived_at IS ${archived ? 'NULL' : 'NOT NULL'}
       RETURNING ${PROPERTY_COLUMNS}`,
      [propertyId, revision]
    );
    if (!rows[0]) await assertPropertyRevision(propertyId, revision, client);
    const databaseRevision = rows[0]
      ? await bumpParentDatabaseRevision(client, property.database_id)
      : null;
    return rows[0] && databaseRevision !== null
      ? { property: rows[0], database_revision: databaseRevision }
      : null;
  });
}

export function archiveDatabaseProperty(
  id: string,
  revision: number
): Promise<DatabasePropertyMutationResult | null> {
  return setPropertyArchived(id, revision, true);
}

export function restoreDatabaseProperty(
  id: string,
  revision: number
): Promise<DatabasePropertyMutationResult | null> {
  return setPropertyArchived(id, revision, false);
}
