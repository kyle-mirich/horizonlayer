import type { QueryResultRow } from 'pg';

import type { LinkItemType } from '../../domain.js';
import { getPool, type PoolClient } from '../client.js';

type Queryable = Pick<PoolClient, 'query'>;

function notFound(entity: string, id: string): Error {
  return new Error(`${entity} ${id} not found`);
}

async function selectSingleRow<T extends QueryResultRow>(
  sql: string,
  values: unknown[],
  entity: string,
  id: string,
  queryable: Queryable = getPool()
): Promise<T> {
  const { rows } = await queryable.query<T>(sql, values);
  if (!rows[0]) {
    throw notFound(entity, id);
  }
  return rows[0];
}

export async function requireActiveWorkspace(
  workspaceId: string,
  queryable?: Queryable
): Promise<void> {
  await selectSingleRow<{ id: string }>(
    'SELECT id FROM workspaces WHERE id = $1 AND archived_at IS NULL',
    [workspaceId],
    'Workspace',
    workspaceId,
    queryable
  );
}

export async function requireSession(
  sessionId: string,
  queryable?: Queryable
): Promise<{ workspace_id: string }> {
  return selectSingleRow<{ workspace_id: string }>(
    `SELECT s.workspace_id
     FROM sessions s
     JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.id = $1 AND w.archived_at IS NULL`,
    [sessionId],
    'Session',
    sessionId,
    queryable
  );
}

export async function requireActiveSession(
  sessionId: string,
  queryable?: Queryable
): Promise<{ workspace_id: string }> {
  const session = await selectSingleRow<{ workspace_id: string; status: string }>(
    `SELECT s.workspace_id, s.status
     FROM sessions s
     JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.id = $1 AND w.archived_at IS NULL`,
    [sessionId],
    'Session',
    sessionId,
    queryable
  );
  if (session.status !== 'active') {
    throw new Error(`Session ${sessionId} is closed and cannot be modified`);
  }
  return { workspace_id: session.workspace_id };
}

/**
 * Hold the session row while creating a session-scoped child record.
 *
 * The row lock is deliberately acquired before the child insert takes the
 * workspace lock in its trigger. Session close follows the same
 * session-then-workspace order, so the two operations serialize without a
 * lock-order inversion.
 */
export async function lockActiveSessionForChildWrite(
  sessionId: string,
  queryable: Queryable
): Promise<{ workspace_id: string }> {
  const session = await selectSingleRow<{ workspace_id: string; status: string }>(
    `SELECT s.workspace_id, s.status
     FROM sessions s
     JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.id = $1 AND w.archived_at IS NULL
     FOR NO KEY UPDATE OF s`,
    [sessionId],
    'Session',
    sessionId,
    queryable
  );
  if (session.status !== 'active') {
    throw new Error(`Session ${sessionId} is closed and cannot be modified`);
  }
  return { workspace_id: session.workspace_id };
}

/**
 * Resolve a page inside an active workspace. The page itself may be archived;
 * callers use this form for reads, archive-state transitions, and diagnostics.
 */
export async function requirePage(
  pageId: string,
  queryable?: Queryable
): Promise<{ workspace_id: string; parent_page_id: string | null; session_id: string | null }> {
  return selectSingleRow<{ workspace_id: string; parent_page_id: string | null; session_id: string | null }>(
    `SELECT p.workspace_id, p.parent_page_id, p.session_id
     FROM pages p
     JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.id = $1 AND w.archived_at IS NULL`,
    [pageId],
    'Page',
    pageId,
    queryable
  );
}

export async function requireActivePage(
  pageId: string,
  queryable?: Queryable
): Promise<{ workspace_id: string; parent_page_id: string | null; session_id: string | null }> {
  return selectSingleRow<{
    workspace_id: string;
    parent_page_id: string | null;
    session_id: string | null;
  }>(
    `SELECT p.workspace_id, p.parent_page_id, p.session_id
     FROM pages p
     JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.id = $1
       AND p.archived_at IS NULL
       AND w.archived_at IS NULL`,
    [pageId],
    'Page',
    pageId,
    queryable
  );
}

export async function lockActivePageForChildWrite(
  pageId: string,
  queryable: Queryable
): Promise<{ workspace_id: string; parent_page_id: string | null; session_id: string | null }> {
  return selectSingleRow<{
    workspace_id: string;
    parent_page_id: string | null;
    session_id: string | null;
  }>(
    `SELECT p.workspace_id, p.parent_page_id, p.session_id
     FROM pages p
     JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.id = $1
       AND p.archived_at IS NULL
       AND w.archived_at IS NULL
     FOR SHARE OF p`,
    [pageId],
    'Page',
    pageId,
    queryable
  );
}

export async function requireDatabase(
  databaseId: string,
  queryable?: Queryable
): Promise<{ workspace_id: string; parent_page_id: string | null }> {
  return selectSingleRow<{ workspace_id: string; parent_page_id: string | null }>(
    `SELECT d.workspace_id, d.parent_page_id
     FROM databases d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.id = $1 AND w.archived_at IS NULL`,
    [databaseId],
    'Database',
    databaseId,
    queryable
  );
}

export async function requireBlock(
  blockId: string,
  queryable?: Queryable
): Promise<{ page_id: string; workspace_id: string; session_id: string | null }> {
  return selectSingleRow<{ page_id: string; workspace_id: string; session_id: string | null }>(
    `SELECT b.page_id, p.workspace_id, p.session_id
     FROM blocks b
     JOIN pages p ON p.id = b.page_id
     JOIN workspaces w ON w.id = p.workspace_id
     WHERE b.id = $1 AND w.archived_at IS NULL`,
    [blockId],
    'Block',
    blockId,
    queryable
  );
}

export interface LinkedItemReference {
  id: string;
  type: LinkItemType;
}

interface ResolvedLinkedItem extends LinkedItemReference {
  database_id?: string;
  page_id?: string;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Resolve both endpoint dependency graphs before taking locks, then lock the
 * actual rows in one global order: pages, databases, rows, blocks, workspaces.
 * This prevents a block's parent page or a row's parent database from being
 * discovered after a later-ranked endpoint lock has already been acquired.
 */
export async function lockActiveLinkedItemsForWrite(
  items: LinkedItemReference[],
  queryable: Queryable
): Promise<Array<LinkedItemReference & { workspace_id: string | null }>> {
  const uniqueItems = [...new Map(items.map((item) => [
    `${item.type}:${item.id}`,
    item,
  ])).values()];
  const resolved: ResolvedLinkedItem[] = [];

  for (const item of uniqueItems) {
    if (item.type === 'row') {
      const row = await selectSingleRow<{ database_id: string }>(
        'SELECT database_id FROM database_rows WHERE id = $1',
        [item.id],
        'Row',
        item.id,
        queryable
      );
      resolved.push({ ...item, database_id: row.database_id });
    } else if (item.type === 'block') {
      const block = await selectSingleRow<{ page_id: string }>(
        'SELECT page_id FROM blocks WHERE id = $1',
        [item.id],
        'Block',
        item.id,
        queryable
      );
      resolved.push({ ...item, page_id: block.page_id });
    } else {
      resolved.push(item);
    }
  }

  const pageIds = sortedUnique(resolved.flatMap((item) =>
    item.type === 'page' ? [item.id] : item.page_id ? [item.page_id] : []
  ));
  const databaseIds = sortedUnique(resolved.flatMap((item) =>
    item.type === 'database' ? [item.id] : item.database_id ? [item.database_id] : []
  ));
  const rowIds = sortedUnique(resolved.filter((item) => item.type === 'row').map((item) => item.id));
  const blockIds = sortedUnique(resolved.filter((item) => item.type === 'block').map((item) => item.id));
  const projectIds = sortedUnique(
    resolved.filter((item) => item.type === 'issue_project').map((item) => item.id)
  );
  const issueIds = sortedUnique(
    resolved.filter((item) => item.type === 'issue').map((item) => item.id)
  );
  const workspaceIds = new Set(
    resolved.filter((item) => item.type === 'workspace').map((item) => item.id)
  );
  const pageWorkspaces = new Map<string, string>();
  const databaseWorkspaces = new Map<string, string>();

  for (const pageId of pageIds) {
    const page = await selectSingleRow<{ workspace_id: string }>(
      `SELECT p.workspace_id
       FROM pages p
       WHERE p.id = $1 AND p.archived_at IS NULL
       FOR SHARE OF p`,
      [pageId],
      'Page',
      pageId,
      queryable
    );
    pageWorkspaces.set(pageId, page.workspace_id);
    workspaceIds.add(page.workspace_id);
  }

  for (const databaseId of databaseIds) {
    const database = await selectSingleRow<{ workspace_id: string }>(
      `SELECT d.workspace_id
       FROM databases d
       WHERE d.id = $1 AND d.archived_at IS NULL
       FOR SHARE OF d`,
      [databaseId],
      'Database',
      databaseId,
      queryable
    );
    databaseWorkspaces.set(databaseId, database.workspace_id);
    workspaceIds.add(database.workspace_id);
  }

  for (const rowId of rowIds) {
    const item = resolved.find((candidate) => candidate.type === 'row' && candidate.id === rowId)!;
    await selectSingleRow<{ id: string }>(
      `SELECT id
       FROM database_rows
       WHERE id = $1 AND database_id = $2 AND archived_at IS NULL
       FOR SHARE`,
      [rowId, item.database_id],
      'Row',
      rowId,
      queryable
    );
  }

  for (const blockId of blockIds) {
    const item = resolved.find((candidate) => candidate.type === 'block' && candidate.id === blockId)!;
    await selectSingleRow<{ id: string }>(
      `SELECT id
       FROM blocks
       WHERE id = $1 AND page_id = $2 AND archived_at IS NULL
       FOR SHARE`,
      [blockId, item.page_id],
      'Block',
      blockId,
      queryable
    );
  }

  for (const projectId of projectIds) {
    await selectSingleRow<{ id: string }>(
      `SELECT id FROM issue_projects
       WHERE id = $1 AND archived_at IS NULL
       FOR SHARE`,
      [projectId],
      'Issue Project',
      projectId,
      queryable
    );
  }

  for (const issueId of issueIds) {
    await selectSingleRow<{ id: string }>(
      `SELECT candidate.id
       FROM issues candidate
       JOIN issue_projects project ON project.id = candidate.project_id
       WHERE candidate.id = $1
         AND candidate.archived_at IS NULL
         AND project.archived_at IS NULL
       FOR SHARE OF candidate, project`,
      [issueId],
      'Issue',
      issueId,
      queryable
    );
  }

  for (const workspaceId of sortedUnique(workspaceIds)) {
    await selectSingleRow<{ id: string }>(
      `SELECT id
       FROM workspaces
       WHERE id = $1 AND archived_at IS NULL
       FOR SHARE`,
      [workspaceId],
      'Workspace',
      workspaceId,
      queryable
    );
  }

  return resolved.map((item) => {
    const workspaceId = item.type === 'workspace'
      ? item.id
      : item.type === 'page'
        ? pageWorkspaces.get(item.id)
        : item.type === 'block'
          ? pageWorkspaces.get(item.page_id!)
          : item.type === 'database'
            ? databaseWorkspaces.get(item.id)
            : databaseWorkspaces.get(item.database_id!);
    if (!workspaceId && item.type !== 'issue' && item.type !== 'issue_project') {
      throw new Error(`Cannot resolve workspace for ${item.type} ${item.id}`);
    }
    return { id: item.id, type: item.type, workspace_id: workspaceId ?? null };
  });
}

export async function requireLink(
  linkId: string,
  queryable?: Queryable
): Promise<{ workspace_id: string | null }> {
  const row = await selectSingleRow<{ workspace_id: string | null }>(
    `SELECT workspace_id
     FROM links
     WHERE id = $1`,
    [linkId],
    'Link',
    linkId,
    queryable
  );
  if (row.workspace_id) await requireActiveWorkspace(row.workspace_id, queryable);
  return row;
}
