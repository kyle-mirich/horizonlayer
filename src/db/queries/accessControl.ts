import type { AccessContext } from '../access.js';
import { getPool } from '../client.js';
import type { QueryResultRow } from 'pg';

function notFound(entity: string, id: string): Error {
  return new Error(`${entity} ${id} not found`);
}

async function selectSingleRow<T extends QueryResultRow>(
  sql: string,
  values: unknown[],
  entity: string,
  id: string
): Promise<T> {
  const pool = getPool();
  const { rows } = await pool.query<T>(sql, values);
  if (!rows[0]) {
    throw notFound(entity, id);
  }
  return rows[0];
}

export async function assertWorkspaceReadAccess(workspaceId: string, _access: AccessContext): Promise<void> {
  await selectSingleRow<{ id: string }>(
    'SELECT id FROM workspaces WHERE id = $1',
    [workspaceId],
    'Workspace',
    workspaceId
  );
}

export async function assertWorkspaceWriteAccess(workspaceId: string, _access: AccessContext): Promise<void> {
  await assertWorkspaceReadAccess(workspaceId, { kind: 'system' });
}

export async function assertSessionReadAccess(
  sessionId: string,
  _access: AccessContext
): Promise<{ workspace_id: string }> {
  return selectSingleRow<{ workspace_id: string }>(
    'SELECT workspace_id FROM sessions WHERE id = $1',
    [sessionId],
    'Session',
    sessionId
  );
}

export async function assertSessionWriteAccess(
  sessionId: string,
  _access: AccessContext
): Promise<{ workspace_id: string }> {
  return assertSessionReadAccess(sessionId, { kind: 'system' });
}

export async function assertPageReadAccess(
  pageId: string,
  _access: AccessContext
): Promise<{ workspace_id: string | null; parent_page_id: string | null; session_id: string | null }> {
  return selectSingleRow<{ workspace_id: string | null; parent_page_id: string | null; session_id: string | null }>(
    'SELECT workspace_id, parent_page_id, session_id FROM pages WHERE id = $1',
    [pageId],
    'Page',
    pageId
  );
}

export async function assertPageWriteAccess(
  pageId: string,
  _access: AccessContext
): Promise<{ workspace_id: string | null; parent_page_id: string | null; session_id: string | null }> {
  return assertPageReadAccess(pageId, { kind: 'system' });
}

export async function assertDatabaseReadAccess(
  databaseId: string,
  _access: AccessContext
): Promise<{ workspace_id: string | null; parent_page_id: string | null }> {
  return selectSingleRow<{ workspace_id: string | null; parent_page_id: string | null }>(
    'SELECT workspace_id, parent_page_id FROM databases WHERE id = $1',
    [databaseId],
    'Database',
    databaseId
  );
}

export async function assertDatabaseWriteAccess(
  databaseId: string,
  _access: AccessContext
): Promise<{ workspace_id: string | null; parent_page_id: string | null }> {
  return assertDatabaseReadAccess(databaseId, { kind: 'system' });
}

export async function assertRowReadAccess(
  rowId: string,
  _access: AccessContext
): Promise<{ database_id: string; workspace_id: string | null }> {
  return selectSingleRow<{ database_id: string; workspace_id: string | null }>(
    `SELECT r.database_id, d.workspace_id
     FROM database_rows r
     JOIN databases d ON d.id = r.database_id
     WHERE r.id = $1`,
    [rowId],
    'Row',
    rowId
  );
}

export async function assertRowWriteAccess(
  rowId: string,
  _access: AccessContext
): Promise<{ database_id: string; workspace_id: string | null }> {
  return assertRowReadAccess(rowId, { kind: 'system' });
}

export async function assertBlockReadAccess(
  blockId: string,
  _access: AccessContext
): Promise<{ page_id: string; workspace_id: string | null; session_id: string | null }> {
  return selectSingleRow<{ page_id: string; workspace_id: string | null; session_id: string | null }>(
    `SELECT b.page_id, p.workspace_id, p.session_id
     FROM blocks b
     JOIN pages p ON p.id = b.page_id
     WHERE b.id = $1`,
    [blockId],
    'Block',
    blockId
  );
}

export async function assertBlockWriteAccess(
  blockId: string,
  _access: AccessContext
): Promise<{ page_id: string; workspace_id: string | null; session_id: string | null }> {
  return assertBlockReadAccess(blockId, { kind: 'system' });
}

export async function assertLinkedItemAccess(
  itemType: string,
  itemId: string,
  access: AccessContext,
  mode: 'read' | 'write'
): Promise<void> {
  switch (itemType) {
    case 'workspace':
      await (mode === 'read'
        ? assertWorkspaceReadAccess(itemId, access)
        : assertWorkspaceWriteAccess(itemId, access));
      return;
    case 'page':
      await (mode === 'read'
        ? assertPageReadAccess(itemId, access)
        : assertPageWriteAccess(itemId, access));
      return;
    case 'database':
      await (mode === 'read'
        ? assertDatabaseReadAccess(itemId, access)
        : assertDatabaseWriteAccess(itemId, access));
      return;
    case 'row':
    case 'database_row':
      await (mode === 'read'
        ? assertRowReadAccess(itemId, access)
        : assertRowWriteAccess(itemId, access));
      return;
    case 'block':
      await (mode === 'read'
        ? assertBlockReadAccess(itemId, access)
        : assertBlockWriteAccess(itemId, access));
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
