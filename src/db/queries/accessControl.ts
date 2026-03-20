import {
  canCreateWorkspaces,
  isOrganizationAdmin,
  isSystemAccess,
  requireUserAccess,
  workspaceAccessPredicate,
  workspaceReadPredicate,
  workspaceWritePredicate,
  type AccessContext,
} from '../access.js';
import { getPool } from '../client.js';

function notFound(entity: string, id: string): Error {
  return new Error(`${entity} ${id} not found`);
}

export function assertCanCreateWorkspace(access: AccessContext): void {
  if (!canCreateWorkspaces(access)) {
    throw new Error('Your role does not allow creating workspaces');
  }
}

export function assertOrganizationAdmin(access: AccessContext): void {
  if (isSystemAccess(access)) return;
  if (!isOrganizationAdmin(access)) {
    throw new Error('Organization admin privileges are required');
  }
}

async function assertWorkspaceAccessInternal(
  workspaceId: string,
  access: AccessContext,
  mode: 'read' | 'write'
): Promise<void> {
  const pool = getPool();

  if (isSystemAccess(access) || isOrganizationAdmin(access)) {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM workspaces WHERE id = $1',
      [workspaceId]
    );
    if (!rows[0]) throw notFound('Workspace', workspaceId);
    return;
  }

  const user = requireUserAccess(access);
  const predicate = mode === 'read'
    ? workspaceReadPredicate('w', '$2')
    : workspaceWritePredicate('w', '$2');
  const { rows } = await pool.query<{ id: string }>(
    `SELECT w.id
     FROM workspaces w
     WHERE w.id = $1
       AND ${predicate}`,
    [workspaceId, user.userId]
  );
  if (!rows[0]) throw notFound('Workspace', workspaceId);
}

export async function assertWorkspaceReadAccess(workspaceId: string, access: AccessContext): Promise<void> {
  return assertWorkspaceAccessInternal(workspaceId, access, 'read');
}

export async function assertWorkspaceWriteAccess(workspaceId: string, access: AccessContext): Promise<void> {
  return assertWorkspaceAccessInternal(workspaceId, access, 'write');
}

async function assertSessionAccessInternal(
  sessionId: string,
  access: AccessContext,
  mode: 'read' | 'write'
): Promise<{ workspace_id: string }> {
  const pool = getPool();
  const values: unknown[] = [sessionId];
  let sql = 'SELECT s.workspace_id FROM sessions s WHERE s.id = $1';

  if (!isSystemAccess(access) && !isOrganizationAdmin(access)) {
    const user = requireUserAccess(access);
    values.push(user.userId);
    sql += ` AND ${workspaceAccessPredicate('s.workspace_id', '$2', mode)}`;
  }

  const { rows } = await pool.query<{ workspace_id: string }>(sql, values);
  if (!rows[0]) throw notFound('Session', sessionId);
  return rows[0];
}

export async function assertSessionReadAccess(
  sessionId: string,
  access: AccessContext
): Promise<{ workspace_id: string }> {
  return assertSessionAccessInternal(sessionId, access, 'read');
}

export async function assertSessionWriteAccess(
  sessionId: string,
  access: AccessContext
): Promise<{ workspace_id: string }> {
  return assertSessionAccessInternal(sessionId, access, 'write');
}

async function assertPageAccessInternal(
  pageId: string,
  access: AccessContext,
  mode: 'read' | 'write'
): Promise<{ workspace_id: string | null; parent_page_id: string | null; session_id: string | null }> {
  const pool = getPool();
  const values: unknown[] = [pageId];
  let sql = `SELECT p.workspace_id, p.parent_page_id, p.session_id FROM pages p WHERE p.id = $1`;

  if (!isSystemAccess(access) && !isOrganizationAdmin(access)) {
    const user = requireUserAccess(access);
    values.push(user.userId);
    sql += ` AND p.workspace_id IS NOT NULL AND ${workspaceAccessPredicate('p.workspace_id', '$2', mode)}`;
  }

  const { rows } = await pool.query<{ workspace_id: string | null; parent_page_id: string | null; session_id: string | null }>(sql, values);
  if (!rows[0]) throw notFound('Page', pageId);
  return rows[0];
}

export async function assertPageReadAccess(
  pageId: string,
  access: AccessContext
): Promise<{ workspace_id: string | null; parent_page_id: string | null; session_id: string | null }> {
  return assertPageAccessInternal(pageId, access, 'read');
}

export async function assertPageWriteAccess(
  pageId: string,
  access: AccessContext
): Promise<{ workspace_id: string | null; parent_page_id: string | null; session_id: string | null }> {
  return assertPageAccessInternal(pageId, access, 'write');
}

async function assertDatabaseAccessInternal(
  databaseId: string,
  access: AccessContext,
  mode: 'read' | 'write'
): Promise<{ workspace_id: string | null; parent_page_id: string | null }> {
  const pool = getPool();
  const values: unknown[] = [databaseId];
  let sql = `SELECT d.workspace_id, d.parent_page_id FROM databases d WHERE d.id = $1`;

  if (!isSystemAccess(access) && !isOrganizationAdmin(access)) {
    const user = requireUserAccess(access);
    values.push(user.userId);
    sql += ` AND d.workspace_id IS NOT NULL AND ${workspaceAccessPredicate('d.workspace_id', '$2', mode)}`;
  }

  const { rows } = await pool.query<{ workspace_id: string | null; parent_page_id: string | null }>(sql, values);
  if (!rows[0]) throw notFound('Database', databaseId);
  return rows[0];
}

export async function assertDatabaseReadAccess(
  databaseId: string,
  access: AccessContext
): Promise<{ workspace_id: string | null; parent_page_id: string | null }> {
  return assertDatabaseAccessInternal(databaseId, access, 'read');
}

export async function assertDatabaseWriteAccess(
  databaseId: string,
  access: AccessContext
): Promise<{ workspace_id: string | null; parent_page_id: string | null }> {
  return assertDatabaseAccessInternal(databaseId, access, 'write');
}

async function assertRowAccessInternal(
  rowId: string,
  access: AccessContext,
  mode: 'read' | 'write'
): Promise<{ database_id: string; workspace_id: string | null }> {
  const pool = getPool();
  const values: unknown[] = [rowId];
  let sql = `SELECT r.database_id, d.workspace_id
             FROM database_rows r
             JOIN databases d ON d.id = r.database_id
             WHERE r.id = $1`;

  if (!isSystemAccess(access) && !isOrganizationAdmin(access)) {
    const user = requireUserAccess(access);
    values.push(user.userId);
    sql += ` AND d.workspace_id IS NOT NULL AND ${workspaceAccessPredicate('d.workspace_id', '$2', mode)}`;
  }

  const { rows } = await pool.query<{ database_id: string; workspace_id: string | null }>(sql, values);
  if (!rows[0]) throw notFound('Row', rowId);
  return rows[0];
}

export async function assertRowReadAccess(
  rowId: string,
  access: AccessContext
): Promise<{ database_id: string; workspace_id: string | null }> {
  return assertRowAccessInternal(rowId, access, 'read');
}

export async function assertRowWriteAccess(
  rowId: string,
  access: AccessContext
): Promise<{ database_id: string; workspace_id: string | null }> {
  return assertRowAccessInternal(rowId, access, 'write');
}

async function assertBlockAccessInternal(
  blockId: string,
  access: AccessContext,
  mode: 'read' | 'write'
): Promise<{ page_id: string; workspace_id: string | null; session_id: string | null }> {
  const pool = getPool();
  const values: unknown[] = [blockId];
  let sql = `SELECT b.page_id, p.workspace_id, p.session_id
             FROM blocks b
             JOIN pages p ON p.id = b.page_id
             WHERE b.id = $1`;

  if (!isSystemAccess(access) && !isOrganizationAdmin(access)) {
    const user = requireUserAccess(access);
    values.push(user.userId);
    sql += ` AND p.workspace_id IS NOT NULL AND ${workspaceAccessPredicate('p.workspace_id', '$2', mode)}`;
  }

  const { rows } = await pool.query<{ page_id: string; workspace_id: string | null; session_id: string | null }>(sql, values);
  if (!rows[0]) throw notFound('Block', blockId);
  return rows[0];
}

export async function assertBlockReadAccess(
  blockId: string,
  access: AccessContext
): Promise<{ page_id: string; workspace_id: string | null; session_id: string | null }> {
  return assertBlockAccessInternal(blockId, access, 'read');
}

export async function assertBlockWriteAccess(
  blockId: string,
  access: AccessContext
): Promise<{ page_id: string; workspace_id: string | null; session_id: string | null }> {
  return assertBlockAccessInternal(blockId, access, 'write');
}

export async function assertLinkedItemAccess(
  itemType: string,
  itemId: string,
  access: AccessContext,
  mode: 'read' | 'write'
): Promise<void> {
  switch (itemType) {
    case 'workspace':
      await assertWorkspaceAccessInternal(itemId, access, mode);
      return;
    case 'page':
      await assertPageAccessInternal(itemId, access, mode);
      return;
    case 'database':
      await assertDatabaseAccessInternal(itemId, access, mode);
      return;
    case 'row':
    case 'database_row':
      await assertRowAccessInternal(itemId, access, mode);
      return;
    case 'block':
      await assertBlockAccessInternal(itemId, access, mode);
      return;
    default:
      throw new Error(`Unsupported linked item type: ${itemType}`);
  }
}

export async function assertLinkAccess(
  linkId: string,
  access: AccessContext,
  mode: 'read' | 'write'
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{
    from_type: string;
    from_id: string;
    to_type: string;
    to_id: string;
  }>(
    `SELECT from_type, from_id, to_type, to_id
     FROM links
     WHERE id = $1`,
    [linkId]
  );
  const row = rows[0];
  if (!row) throw new Error(`Link ${linkId} not found`);

  await assertLinkedItemAccess(row.from_type, row.from_id, access, mode);
  await assertLinkedItemAccess(row.to_type, row.to_id, access, mode);
}
