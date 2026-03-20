import { isOrganizationAdmin, isSystemAccess, requireUserAccess, workspaceAccessPredicate, type AccessContext } from '../access.js';
import { getPool } from '../client.js';
import {
  assertDatabaseReadAccess,
  assertDatabaseWriteAccess,
  assertPageWriteAccess,
  assertWorkspaceWriteAccess,
} from './accessControl.js';

export interface Database {
  id: string;
  workspace_id: string | null;
  parent_page_id: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  tags: string[];
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface DatabaseProperty {
  id: string;
  database_id: string;
  name: string;
  property_type: string;
  options: Record<string, unknown>;
  position: number;
  is_required: boolean;
  created_at: string;
}

export interface DatabaseWithProperties extends Database {
  properties: DatabaseProperty[];
}

export interface PropertyInput {
  name: string;
  type: string;
  options?: Record<string, unknown>;
  is_required?: boolean;
}

async function assertDatabaseConflict(id: string, expectedUpdatedAt?: string): Promise<void> {
  if (!expectedUpdatedAt) {
    return;
  }
  const pool = getPool();
  const { rows } = await pool.query<{ updated_at: string }>(
    'SELECT updated_at FROM databases WHERE id = $1',
    [id]
  );
  if (rows[0]) {
    throw new Error(`Conflict: database ${id} was modified by another agent`);
  }
}

export async function createDatabase(params: {
  name: string;
  properties: PropertyInput[];
  workspace_id?: string;
  parent_page_id?: string;
  description?: string;
  icon?: string;
  tags?: string[];
  source?: string;
  access?: AccessContext;
}): Promise<DatabaseWithProperties> {
  const pool = getPool();
  const client = await pool.connect();
  const access = params.access ?? { kind: 'system' as const };

  let workspaceId = params.workspace_id ?? null;
  if (params.parent_page_id) {
    const parent = await assertPageWriteAccess(params.parent_page_id, access);
    if (!parent.workspace_id) {
      throw new Error(`Parent page ${params.parent_page_id} is not associated with a workspace`);
    }
    if (workspaceId && workspaceId !== parent.workspace_id) {
      throw new Error('workspace_id must match the parent page workspace');
    }
    workspaceId = parent.workspace_id;
  } else if (workspaceId) {
    await assertWorkspaceWriteAccess(workspaceId, access);
  } else if (!isSystemAccess(access)) {
    throw new Error('workspace_id is required for authenticated database creation');
  }

  try {
    await client.query('BEGIN');

    const { rows } = await client.query<Database>(
      `INSERT INTO databases (name, workspace_id, parent_page_id, description, icon, tags, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        params.name,
        workspaceId,
        params.parent_page_id ?? null,
        params.description ?? null,
        params.icon ?? null,
        params.tags ?? [],
        params.source ?? null,
      ]
    );
    const db = rows[0];

    const properties: DatabaseProperty[] = [];
    for (let i = 0; i < params.properties.length; i++) {
      const prop = params.properties[i];
      const { rows: propRows } = await client.query<DatabaseProperty>(
        `INSERT INTO database_properties (database_id, name, property_type, options, position, is_required)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          db.id,
          prop.name,
          prop.type,
          JSON.stringify(prop.options ?? {}),
          i,
          prop.is_required ?? false,
        ]
      );
      properties.push(propRows[0]);
    }

    await client.query('COMMIT');
    return { ...db, properties };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getDatabase(
  id: string,
  access: AccessContext = { kind: 'system' }
): Promise<DatabaseWithProperties | null> {
  const pool = getPool();
  if (!isSystemAccess(access)) {
    await assertDatabaseReadAccess(id, access);
  }

  const { rows: dbRows } = await pool.query<Database>('SELECT * FROM databases WHERE id = $1', [id]);
  if (!dbRows[0]) return null;

  const { rows: propRows } = await pool.query<DatabaseProperty>(
    'SELECT * FROM database_properties WHERE database_id = $1 ORDER BY position ASC',
    [id]
  );

  return { ...dbRows[0], properties: propRows };
}

export async function listDatabases(params: {
  workspace_id?: string;
  tags?: string[];
  access?: AccessContext;
}): Promise<DatabaseWithProperties[]> {
  const pool = getPool();
  const access = params.access ?? { kind: 'system' as const };

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.workspace_id) {
    conditions.push(`d.workspace_id = $${idx++}`);
    values.push(params.workspace_id);
  }
  if (params.tags && params.tags.length > 0) {
    conditions.push(`d.tags && $${idx++}`);
    values.push(params.tags);
  }
  if (!isSystemAccess(access) && !isOrganizationAdmin(access)) {
    conditions.push('d.workspace_id IS NOT NULL');
    values.push(requireUserAccess(access).userId);
    conditions.push(workspaceAccessPredicate('d.workspace_id', `$${idx++}`, 'read'));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows: dbRows } = await pool.query<Database>(
    `SELECT * FROM databases d ${where} ORDER BY d.created_at DESC`,
    values
  );

  if (dbRows.length === 0) return [];

  const dbIds = dbRows.map((d) => d.id);
  const { rows: propRows } = await pool.query<DatabaseProperty>(
    `SELECT * FROM database_properties WHERE database_id = ANY($1) ORDER BY position ASC`,
    [dbIds]
  );

  return dbRows.map((db) => ({
    ...db,
    properties: propRows.filter((p) => p.database_id === db.id),
  }));
}

export async function updateDatabase(
  id: string,
  params: { name?: string; description?: string; icon?: string; tags?: string[]; expected_updated_at?: string },
  access: AccessContext = { kind: 'system' }
): Promise<Database | null> {
  const pool = getPool();

  if (!isSystemAccess(access)) {
    await assertDatabaseWriteAccess(id, access);
  }

  const sets: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let idx = 1;

  if (params.name !== undefined) { sets.push(`name = $${idx++}`); values.push(params.name); }
  if (params.description !== undefined) { sets.push(`description = $${idx++}`); values.push(params.description); }
  if (params.icon !== undefined) { sets.push(`icon = $${idx++}`); values.push(params.icon); }
  if (params.tags !== undefined) { sets.push(`tags = $${idx++}`); values.push(params.tags); }

  values.push(id);
  if (params.expected_updated_at) {
    values.push(params.expected_updated_at);
  }
  const { rows } = await pool.query<Database>(
    `UPDATE databases SET ${sets.join(', ')} WHERE id = $${idx}${params.expected_updated_at ? ` AND updated_at = $${idx + 1}` : ''} RETURNING *`,
    values
  );
  if (!rows[0]) {
    await assertDatabaseConflict(id, params.expected_updated_at);
  }
  return rows[0] ?? null;
}

export async function deleteDatabase(
  id: string,
  access: AccessContext = { kind: 'system' },
  expected_updated_at?: string
): Promise<boolean> {
  if (!isSystemAccess(access)) {
    await assertDatabaseWriteAccess(id, access);
  }
  const pool = getPool();
  const values: unknown[] = [id];
  let sql = 'DELETE FROM databases WHERE id = $1';
  if (expected_updated_at) {
    values.push(expected_updated_at);
    sql += ' AND updated_at = $2';
  }
  const { rowCount } = await pool.query(sql, values);
  if ((rowCount ?? 0) === 0) {
    await assertDatabaseConflict(id, expected_updated_at);
  }
  return (rowCount ?? 0) > 0;
}

export async function addDatabaseProperty(
  databaseId: string,
  params: {
    name: string;
    type: string;
    options?: Record<string, unknown>;
    is_required?: boolean;
    expected_updated_at?: string;
  },
  access: AccessContext = { kind: 'system' }
): Promise<DatabaseProperty> {
  const pool = getPool();
  if (!isSystemAccess(access)) {
    await assertDatabaseWriteAccess(databaseId, access);
  }

  const touchResult = params.expected_updated_at
    ? await pool.query<{ id: string }>(
      `UPDATE databases
       SET updated_at = NOW()
       WHERE id = $1 AND updated_at = $2
       RETURNING id`,
      [databaseId, params.expected_updated_at]
    )
    : await pool.query<{ id: string }>(
      `UPDATE databases
       SET updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [databaseId]
    );

  if (!touchResult.rows[0]) {
    await assertDatabaseConflict(databaseId, params.expected_updated_at);
    throw new Error(`Database ${databaseId} not found`);
  }

  // Get current max position
  const { rows: maxRows } = await pool.query<{ max_pos: number | null }>(
    'SELECT MAX(position) AS max_pos FROM database_properties WHERE database_id = $1',
    [databaseId]
  );
  const pos = (maxRows[0].max_pos ?? -1) + 1;

  const { rows } = await pool.query<DatabaseProperty>(
    `INSERT INTO database_properties (database_id, name, property_type, options, position, is_required)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      databaseId,
      params.name,
      params.type,
      JSON.stringify(params.options ?? {}),
      pos,
      params.is_required ?? false,
    ]
  );
  return rows[0];
}
