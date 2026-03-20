import {
  canCreateWorkspaces,
  isOrganizationAdmin,
  isSystemAccess,
  requireUserAccess,
  workspaceReadPredicate,
  workspaceWritePredicate,
  type AccessContext,
} from '../access.js';
import { getPool } from '../client.js';
import { ensureLocalUser } from '../localUser.js';

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  owner_user_id: string | null;
  organization_id: string | null;
  sharing_scope: 'private' | 'explicit_members' | 'organization';
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
  access: AccessContext = { kind: 'system' }
): Promise<Workspace> {
  if (!canCreateWorkspaces(access)) {
    throw new Error('Your role does not allow creating workspaces');
  }
  const pool = getPool();
  const expiresAt = expires_in_days
    ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
    : null;
  const localOwner = access.kind === 'system' ? await ensureLocalUser() : null;
  const { rows } = await pool.query<Workspace>(
    `INSERT INTO workspaces (name, description, icon, expires_at, owner_user_id, organization_id, sharing_scope)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      name,
      description ?? null,
      icon ?? null,
      expiresAt,
      access.kind === 'user' ? access.userId : localOwner?.id ?? null,
      null,
      'private',
    ]
  );
  return rows[0];
}

export async function listWorkspaces(access: AccessContext = { kind: 'system' }): Promise<Workspace[]> {
  const pool = getPool();
  let sql = 'SELECT * FROM workspaces';
  const values: unknown[] = [];
  if (!isSystemAccess(access) && !isOrganizationAdmin(access)) {
    values.push(requireUserAccess(access).userId);
    sql += ` WHERE ${workspaceReadPredicate('workspaces', '$1')}`;
  }
  sql += ' ORDER BY created_at DESC';
  const { rows } = await pool.query<Workspace>(sql, values);
  return rows;
}

export async function getWorkspace(
  id: string,
  access: AccessContext = { kind: 'system' }
): Promise<WorkspaceWithCounts | null> {
  const pool = getPool();
  const values: unknown[] = [id];
  if (!isSystemAccess(access) && !isOrganizationAdmin(access)) {
    values.push(requireUserAccess(access).userId);
  }

  const { rows } = await pool.query<WorkspaceWithCounts>(
    `SELECT w.*,
       (SELECT COUNT(*) FROM pages WHERE workspace_id = w.id)::int AS page_count,
       (SELECT COUNT(*) FROM databases WHERE workspace_id = w.id)::int AS database_count
     FROM workspaces w
     WHERE w.id = $1${!isSystemAccess(access) && !isOrganizationAdmin(access) ? ` AND ${workspaceReadPredicate('w', '$2')}` : ''}`,
    values
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
    return current;
  }

  sets.push(`updated_at = NOW()`);
  values.push(id);
  if (params.expected_updated_at) {
    values.push(params.expected_updated_at);
  }
  if (!isSystemAccess(access) && !isOrganizationAdmin(access)) {
    values.push(requireUserAccess(access).userId);
  }

  const { rows } = await pool.query<Workspace>(
    `UPDATE workspaces
     SET ${sets.join(', ')}
     WHERE id = $${idx}${params.expected_updated_at ? ` AND updated_at = $${idx + 1}` : ''}${!isSystemAccess(access) && !isOrganizationAdmin(access) ? ` AND ${workspaceWritePredicate('workspaces', `$${idx + (params.expected_updated_at ? 2 : 1)}`)}` : ''}
     RETURNING *`,
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
  if (!isSystemAccess(access) && !isOrganizationAdmin(access)) {
    values.push(requireUserAccess(access).userId);
    sql += ` AND ${workspaceWritePredicate('workspaces', expected_updated_at ? '$3' : '$2')}`;
  }
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
  const values: unknown[] = [now];
  let sql = 'SELECT id FROM workspaces WHERE expires_at IS NOT NULL AND expires_at < $1';
  if (!isSystemAccess(access) && !isOrganizationAdmin(access)) {
    values.push(requireUserAccess(access).userId);
    sql += ` AND ${workspaceWritePredicate('workspaces', '$2')}`;
  }
  const { rows } = await pool.query<{ id: string }>(sql, values);
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
