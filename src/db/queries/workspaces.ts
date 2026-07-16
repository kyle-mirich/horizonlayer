import { getPool } from '../client.js';

const WORKSPACE_COLUMNS = `
  id,
  name,
  description,
  icon,
  revision,
  archived_at,
  created_at,
  updated_at
`;

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceWithCounts extends Workspace {
  page_count: number;
  database_count: number;
  session_count: number;
}

function pagination(value: number | undefined, fallback: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new Error(`Pagination value must be an integer between 0 and ${max}`);
  }
  return resolved;
}

async function assertWorkspaceRevision(id: string, revision: number): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ revision: number }>(
    'SELECT revision FROM workspaces WHERE id = $1',
    [id]
  );
  if (rows[0] && rows[0].revision !== revision) {
    throw new Error(`Conflict: workspace ${id} is at revision ${rows[0].revision}, not ${revision}`);
  }
}

export async function createWorkspace(params: {
  name: string;
  description?: string;
  icon?: string;
}): Promise<Workspace> {
  const name = params.name.trim();
  if (!name) {
    throw new Error('Workspace name cannot be empty');
  }

  const pool = getPool();
  const { rows } = await pool.query<Workspace>(
    `INSERT INTO workspaces (name, description, icon)
     VALUES ($1, $2, $3)
     RETURNING ${WORKSPACE_COLUMNS}`,
    [name, params.description?.trim() || null, params.icon?.trim() || null]
  );
  return rows[0];
}

export async function listWorkspaces(params: {
  include_archived?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<Workspace[]> {
  const pool = getPool();
  const limit = pagination(params.limit, 50, 101);
  const offset = pagination(params.offset, 0, 1_000_000);

  const { rows } = await pool.query<Workspace>(
    `SELECT ${WORKSPACE_COLUMNS}
     FROM workspaces
     WHERE ($1::boolean OR archived_at IS NULL)
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $2 OFFSET $3`,
    [params.include_archived ?? false, limit, offset]
  );
  return rows;
}

export async function getWorkspace(
  id: string,
  params: { include_archived?: boolean } = {}
): Promise<WorkspaceWithCounts | null> {
  const pool = getPool();

  const { rows } = await pool.query<WorkspaceWithCounts>(
    `SELECT ${WORKSPACE_COLUMNS},
       (SELECT COUNT(*) FROM pages WHERE workspace_id = w.id AND archived_at IS NULL)::int AS page_count,
       (SELECT COUNT(*) FROM databases WHERE workspace_id = w.id AND archived_at IS NULL)::int AS database_count,
       (SELECT COUNT(*) FROM sessions WHERE workspace_id = w.id)::int AS session_count
     FROM workspaces w
     WHERE w.id = $1
       AND ($2::boolean OR w.archived_at IS NULL)`,
    [id, params.include_archived ?? false]
  );
  return rows[0] ?? null;
}

export async function updateWorkspace(
  id: string,
  params: {
    revision: number;
    name?: string;
    description?: string | null;
    icon?: string | null;
  }
): Promise<Workspace | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  if (params.name !== undefined) {
    const name = params.name.trim();
    if (!name) throw new Error('Workspace name cannot be empty');
    sets.push(`name = $${index++}`);
    values.push(name);
  }
  if (params.description !== undefined) {
    sets.push(`description = $${index++}`);
    values.push(params.description?.trim() || null);
  }
  if (params.icon !== undefined) {
    sets.push(`icon = $${index++}`);
    values.push(params.icon?.trim() || null);
  }
  if (sets.length === 0) {
    throw new Error('At least one workspace field is required');
  }

  sets.push('revision = revision + 1', 'updated_at = NOW()');
  values.push(id, params.revision);

  const pool = getPool();
  const { rows } = await pool.query<Workspace>(
    `UPDATE workspaces
     SET ${sets.join(', ')}
     WHERE id = $${index++}
       AND revision = $${index}
       AND archived_at IS NULL
     RETURNING ${WORKSPACE_COLUMNS}`,
    values
  );
  if (!rows[0]) await assertWorkspaceRevision(id, params.revision);
  return rows[0] ?? null;
}

async function setWorkspaceArchived(
  id: string,
  revision: number,
  archived: boolean
): Promise<Workspace | null> {
  const pool = getPool();
  const { rows } = await pool.query<Workspace>(
    `UPDATE workspaces
     SET archived_at = ${archived ? 'NOW()' : 'NULL'},
         revision = revision + 1,
         updated_at = NOW()
     WHERE id = $1
       AND revision = $2
       AND archived_at IS ${archived ? 'NULL' : 'NOT NULL'}
     RETURNING ${WORKSPACE_COLUMNS}`,
    [id, revision]
  );
  if (!rows[0]) await assertWorkspaceRevision(id, revision);
  return rows[0] ?? null;
}

export function archiveWorkspace(
  id: string,
  revision: number
): Promise<Workspace | null> {
  return setWorkspaceArchived(id, revision, true);
}

export function restoreWorkspace(
  id: string,
  revision: number
): Promise<Workspace | null> {
  return setWorkspaceArchived(id, revision, false);
}
