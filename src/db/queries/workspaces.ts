import type { AccessContext } from '../access.js';
import { getPool } from '../client.js';

const WORKSPACE_COLUMNS = `
  id,
  name,
  description,
  icon,
  expires_at,
  created_at,
  updated_at
`;

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceWithCounts extends Workspace {
  page_count: number;
  database_count: number;
}

async function assertWorkspaceConflict(id: string, expectedUpdatedAt?: string): Promise<void> {
  if (!expectedUpdatedAt) {
    return;
  }
  const pool = getPool();
  const { rows } = await pool.query<{ updated_at: string }>(
    'SELECT updated_at FROM workspaces WHERE id = $1',
    [id]
  );
  if (rows[0]) {
    throw new Error(`Conflict: workspace ${id} was modified by another agent`);
  }
}

export async function createWorkspace(
  name: string,
  description?: string,
  icon?: string,
  expires_in_days?: number,
  _access: AccessContext = { kind: 'system' }
): Promise<Workspace> {
  const pool = getPool();
  const expiresAt = expires_in_days
    ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
    : null;
  const { rows } = await pool.query<Workspace>(
    `INSERT INTO workspaces (name, description, icon, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING ${WORKSPACE_COLUMNS}`,
    [
      name,
      description ?? null,
      icon ?? null,
      expiresAt,
    ]
  );
  return rows[0];
}

export async function listWorkspaces(access: AccessContext = { kind: 'system' }): Promise<Workspace[]> {
  const pool = getPool();
  void access;
  const { rows } = await pool.query<Workspace>(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces ORDER BY created_at DESC`);
  return rows;
}

export async function getWorkspace(
  id: string,
  access: AccessContext = { kind: 'system' }
): Promise<WorkspaceWithCounts | null> {
  const pool = getPool();
  void access;

  const { rows } = await pool.query<WorkspaceWithCounts>(
    `SELECT ${WORKSPACE_COLUMNS},
       (SELECT COUNT(*) FROM pages WHERE workspace_id = w.id)::int AS page_count,
       (SELECT COUNT(*) FROM databases WHERE workspace_id = w.id)::int AS database_count
     FROM workspaces w
     WHERE w.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function updateWorkspace(
  id: string,
  params: {
    name?: string;
    description?: string;
    icon?: string;
    expires_in_days?: number;
    expected_updated_at?: string;
  },
  access: AccessContext = { kind: 'system' }
): Promise<Workspace | null> {
  const pool = getPool();
  const current = await getWorkspace(id, access);
  if (!current) {
    return null;
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.name !== undefined) { sets.push(`name = $${idx++}`); values.push(params.name); }
  if (params.description !== undefined) { sets.push(`description = $${idx++}`); values.push(params.description); }
  if (params.icon !== undefined) { sets.push(`icon = $${idx++}`); values.push(params.icon); }
  if (params.expires_in_days !== undefined) {
    sets.push(`expires_at = $${idx++}`);
    values.push(new Date(Date.now() + params.expires_in_days * 86400000).toISOString());
  }

  if (sets.length === 0) {
    return {
      id: current.id,
      name: current.name,
      description: current.description,
      icon: current.icon,
      expires_at: current.expires_at,
      created_at: current.created_at,
      updated_at: current.updated_at,
    };
  }

  sets.push(`updated_at = NOW()`);
  values.push(id);
  if (params.expected_updated_at) {
    values.push(params.expected_updated_at);
  }
  void access;

  const { rows } = await pool.query<Workspace>(
    `UPDATE workspaces
     SET ${sets.join(', ')}
     WHERE id = $${idx}${params.expected_updated_at ? ` AND updated_at = $${idx + 1}` : ''}
     RETURNING ${WORKSPACE_COLUMNS}`,
    values
  );
  if (!rows[0]) {
    await assertWorkspaceConflict(id, params.expected_updated_at);
  }
  return rows[0] ?? null;
}

export async function deleteWorkspace(
  id: string,
  access: AccessContext = { kind: 'system' },
  expected_updated_at?: string
): Promise<boolean> {
  const pool = getPool();
  const values: unknown[] = [id];
  let sql = 'DELETE FROM workspaces WHERE id = $1';
  if (expected_updated_at) {
    values.push(expected_updated_at);
    sql += ' AND updated_at = $2';
  }
  void access;
  const { rowCount } = await pool.query(sql, values);
  if ((rowCount ?? 0) === 0) {
    await assertWorkspaceConflict(id, expected_updated_at);
  }
  return (rowCount ?? 0) > 0;
}

export async function cleanupExpiredWorkspaces(
  access: AccessContext = { kind: 'system' }
): Promise<{ workspaces_deleted: number }> {
  const pool = getPool();
  const now = new Date().toISOString();
  void access;
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM workspaces WHERE expires_at IS NOT NULL AND expires_at < $1',
    [now]
  );
  const workspaceIds = rows.map((row) => row.id);
  if (workspaceIds.length === 0) {
    return { workspaces_deleted: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM links
       WHERE (from_type = 'workspace' AND from_id = ANY($1))
          OR (to_type = 'workspace' AND to_id = ANY($1))
          OR (from_type = 'page' AND from_id IN (SELECT id FROM pages WHERE workspace_id = ANY($1)))
          OR (to_type = 'page' AND to_id IN (SELECT id FROM pages WHERE workspace_id = ANY($1)))
          OR (from_type = 'database' AND from_id IN (SELECT id FROM databases WHERE workspace_id = ANY($1)))
          OR (to_type = 'database' AND to_id IN (SELECT id FROM databases WHERE workspace_id = ANY($1)))
          OR (from_type IN ('row', 'database_row') AND from_id IN (
                SELECT r.id
                FROM database_rows r
                JOIN databases d ON d.id = r.database_id
                WHERE d.workspace_id = ANY($1)
              ))
          OR (to_type IN ('row', 'database_row') AND to_id IN (
                SELECT r.id
                FROM database_rows r
                JOIN databases d ON d.id = r.database_id
                WHERE d.workspace_id = ANY($1)
              ))
          OR (from_type = 'block' AND from_id IN (
                SELECT b.id
                FROM blocks b
                JOIN pages p ON p.id = b.page_id
                WHERE p.workspace_id = ANY($1)
              ))
          OR (to_type = 'block' AND to_id IN (
                SELECT b.id
                FROM blocks b
                JOIN pages p ON p.id = b.page_id
                WHERE p.workspace_id = ANY($1)
              ))`,
      [workspaceIds]
    );
    await client.query('DELETE FROM pages WHERE workspace_id = ANY($1)', [workspaceIds]);
    await client.query('DELETE FROM databases WHERE workspace_id = ANY($1)', [workspaceIds]);
    const { rowCount } = await client.query('DELETE FROM workspaces WHERE id = ANY($1)', [workspaceIds]);
    await client.query('COMMIT');
    return { workspaces_deleted: rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
