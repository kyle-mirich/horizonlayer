import { getPool, type PoolClient } from '../client.js';
import {
  appendBlocks,
  archiveBlock as archiveStoredBlock,
  getBlocksForPage,
  restoreBlock as restoreStoredBlock,
  updateBlock,
  type Block,
  type BlockInput,
} from './blocks.js';
import {
  lockActiveSessionForChildWrite,
  lockActivePageForChildWrite,
  requireActiveSession,
  requireActivePage,
  requireActiveWorkspace,
  requireBlock,
  requirePage,
  requireSession,
} from './scopeGuards.js';
import { touchSession } from './sessions.js';

const PAGE_COLUMNS = `
  id,
  workspace_id,
  session_id,
  parent_page_id,
  title,
  tags,
  importance,
  revision,
  archived_at,
  created_at,
  updated_at
`;

export interface Page {
  id: string;
  workspace_id: string;
  session_id: string | null;
  parent_page_id: string | null;
  title: string;
  tags: string[];
  importance: number;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PageWithBlocks extends Page {
  blocks: Block[];
}

export interface PaginationPage {
  has_more: boolean;
  limit: number;
  next_offset: number | null;
  offset: number;
}

export interface PageWithPaginatedBlocks extends PageWithBlocks {
  blocks_page: PaginationPage;
}

export interface AppendedPageBlocks {
  blocks: Block[];
  page_revision: number;
}

export interface PageBlockMutation {
  block: Block;
  page_revision: number;
}

const DEFAULT_BLOCK_LIMIT = 50;

function assertRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error('revision must be a positive integer');
  }
}

function boundedInteger(name: string, value: number | undefined, fallback: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
  return resolved;
}

function blockLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_BLOCK_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('block_limit must be an integer between 1 and 100');
  }
  return limit;
}

function paginateBlocks(records: Block[], limit: number, offset: number): {
  blocks: Block[];
  blocks_page: PaginationPage;
} {
  const hasMore = records.length > limit;
  return {
    blocks: hasMore ? records.slice(0, limit) : records,
    blocks_page: {
      has_more: hasMore,
      limit,
      next_offset: hasMore ? offset + limit : null,
      offset,
    },
  };
}

async function assertPageRevision(
  id: string,
  revision: number,
  queryable: Pick<PoolClient, 'query'> = getPool()
): Promise<void> {
  const { rows } = await queryable.query<{ revision: number }>(
    'SELECT revision FROM pages WHERE id = $1',
    [id]
  );
  if (rows[0] && rows[0].revision !== revision) {
    throw new Error(`Conflict: page ${id} is at revision ${rows[0].revision}, not ${revision}`);
  }
}

export async function createPage(params: {
  title: string;
  workspace_id?: string;
  session_id?: string;
  parent_page_id?: string;
  tags?: string[];
  importance?: number;
  blocks?: BlockInput[];
}): Promise<PageWithBlocks> {
  let workspaceId = params.workspace_id ?? null;
  let sessionId = params.session_id ?? null;

  // Resolve and validate the full ownership chain before checking out a client.
  // Validation failures therefore cannot leak a pooled connection.
  if (params.parent_page_id) {
    const parent = await requireActivePage(params.parent_page_id);
    if (!parent.workspace_id) {
      throw new Error(`Parent page ${params.parent_page_id} is not associated with a workspace`);
    }
    if (workspaceId && workspaceId !== parent.workspace_id) {
      throw new Error('workspace_id must match the parent page workspace');
    }
    if (sessionId && parent.session_id && sessionId !== parent.session_id) {
      throw new Error('session_id must match the parent page session');
    }
    workspaceId = parent.workspace_id;
    sessionId = sessionId ?? parent.session_id ?? null;
  }

  if (sessionId) {
    const session = await requireActiveSession(sessionId);
    if (workspaceId && workspaceId !== session.workspace_id) {
      throw new Error('session_id must belong to the target workspace');
    }
    workspaceId = session.workspace_id;
  } else if (workspaceId) {
    await requireActiveWorkspace(workspaceId);
  }

  if (!workspaceId) {
    throw new Error('workspace_id is required for page creation');
  }

  const pool = getPool();
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    if (params.parent_page_id) {
      const lockedParent = await lockActivePageForChildWrite(params.parent_page_id, client);
      if (lockedParent.workspace_id !== workspaceId) {
        throw new Error('workspace_id must match the parent page workspace');
      }
    }

    if (sessionId) {
      const lockedSession = await lockActiveSessionForChildWrite(sessionId, client);
      if (lockedSession.workspace_id !== workspaceId) {
        throw new Error('session_id must belong to the target workspace');
      }
    }

    const { rows } = await client.query<Page>(
      `INSERT INTO pages (
         title,
         workspace_id,
         session_id,
         parent_page_id,
         tags,
         importance
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${PAGE_COLUMNS}`,
      [
        params.title,
        workspaceId,
        sessionId,
        params.parent_page_id ?? null,
        params.tags ?? [],
        params.importance ?? 0.5,
      ]
    );
    const page = rows[0];
    if (!page) throw new Error('Page creation failed');

    const blocks = params.blocks?.length
      ? await appendBlocks(page.id, params.blocks, client)
      : [];
    await touchSession(page.session_id, client);

    await client.query('COMMIT');
    transactionOpen = false;
    return { ...page, blocks };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getPage(
  id: string,
  params: {
    session_id?: string;
    include_archived?: boolean;
    block_limit?: number;
    block_offset?: number;
  } = {}
): Promise<PageWithPaginatedBlocks | null> {
  const limit = blockLimit(params.block_limit);
  const offset = boundedInteger('block_offset', params.block_offset, 0, 1_000_000);
  await requirePage(id);
  if (params.session_id) await requireSession(params.session_id);

  const values: unknown[] = [id, params.include_archived ?? false];
  const sessionCondition = params.session_id ? ' AND session_id = $3' : '';
  if (params.session_id) values.push(params.session_id);

  const pool = getPool();
  const { rows } = await pool.query<Page>(
    `SELECT ${PAGE_COLUMNS}
     FROM pages
     WHERE id = $1
       AND ($2::boolean OR archived_at IS NULL)${sessionCondition}`,
    values
  );
  if (!rows[0]) return null;

  const blockRecords = await getBlocksForPage(id, {
    include_archived: params.include_archived,
    limit: limit + 1,
    offset,
  });
  return { ...rows[0], ...paginateBlocks(blockRecords, limit, offset) };
}

export async function updatePage(
  id: string,
  params: {
    revision: number;
    title?: string;
    tags?: string[];
    importance?: number;
  }
): Promise<Page | null> {
  assertRevision(params.revision);
  await requirePage(id);

  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  if (params.title !== undefined) {
    sets.push(`title = $${index++}`);
    values.push(params.title);
  }
  if (params.tags !== undefined) {
    sets.push(`tags = $${index++}`);
    values.push(params.tags);
  }
  if (params.importance !== undefined) {
    sets.push(`importance = $${index++}`);
    values.push(params.importance);
  }
  if (sets.length === 0) {
    throw new Error('At least one page field is required');
  }

  sets.push('revision = revision + 1', 'updated_at = NOW()');
  values.push(id, params.revision);

  const pool = getPool();
  const { rows } = await pool.query<Page>(
    `UPDATE pages
     SET ${sets.join(', ')}
     WHERE id = $${index++}
       AND revision = $${index}
       AND archived_at IS NULL
     RETURNING ${PAGE_COLUMNS}`,
    values
  );
  if (!rows[0]) await assertPageRevision(id, params.revision);
  return rows[0] ?? null;
}

export async function appendPageBlocks(
  pageId: string,
  blocks: BlockInput[],
  params: {
    revision: number;
    session_id?: string;
  }
): Promise<AppendedPageBlocks> {
  assertRevision(params.revision);
  if (blocks.length === 0) throw new Error('At least one block is required');

  await requirePage(pageId);

  const pool = getPool();
  const pageResult = await pool.query<{ session_id: string | null; revision: number }>(
    `SELECT session_id, revision
     FROM pages
     WHERE id = $1
       AND archived_at IS NULL`,
    [pageId]
  );
  const page = pageResult.rows[0];
  if (!page) throw new Error(`Page ${pageId} not found`);
  if (page.revision !== params.revision) {
    throw new Error(`Conflict: page ${pageId} is at revision ${page.revision}, not ${params.revision}`);
  }

  if (params.session_id) {
    await requireActiveSession(params.session_id);
    if (page.session_id !== params.session_id) {
      throw new Error(`Page ${pageId} is not associated with session ${params.session_id}`);
    }
  }

  // All validation above intentionally happens before client checkout.
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const touchResult = await client.query<{ revision: number }>(
      `UPDATE pages
       SET revision = revision + 1,
           updated_at = NOW()
       WHERE id = $1
         AND revision = $2
         AND archived_at IS NULL
       RETURNING revision`,
      [pageId, params.revision]
    );
    if (!touchResult.rows[0]) {
      await assertPageRevision(pageId, params.revision, client);
      throw new Error(`Page ${pageId} not found`);
    }

    const inserted = await appendBlocks(pageId, blocks, client);
    await touchSession(page.session_id, client);
    await client.query('COMMIT');
    transactionOpen = false;
    return {
      blocks: inserted,
      page_revision: touchResult.rows[0].revision,
    };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listPages(params: {
  workspace_id: string;
  session_id?: string;
  parent_page_id?: string;
  tags?: string[];
  min_importance?: number;
  include_archived?: boolean;
  limit?: number;
  offset?: number;
}): Promise<Page[]> {
  if (!params.workspace_id) {
    throw new Error('workspace_id is required for page listing');
  }
  await requireActiveWorkspace(params.workspace_id);

  if (params.session_id) {
    const session = await requireSession(params.session_id);
    if (session.workspace_id !== params.workspace_id) {
      throw new Error('session_id must belong to the requested workspace');
    }
  }
  if (params.parent_page_id) {
    const parent = await requirePage(params.parent_page_id);
    if (parent.workspace_id !== params.workspace_id) {
      throw new Error('parent_page_id must belong to the requested workspace');
    }
  }

  const conditions = ['workspace_id = $1'];
  const values: unknown[] = [params.workspace_id];
  let index = 2;
  if (!params.include_archived) conditions.push('archived_at IS NULL');
  if (params.session_id !== undefined) {
    conditions.push(`session_id = $${index++}`);
    values.push(params.session_id);
  }
  if (params.parent_page_id !== undefined) {
    conditions.push(`parent_page_id = $${index++}`);
    values.push(params.parent_page_id);
  }
  if (params.tags?.length) {
    conditions.push(`tags && $${index++}`);
    values.push(params.tags);
  }
  if (params.min_importance !== undefined) {
    conditions.push(`importance >= $${index++}`);
    values.push(params.min_importance);
  }

  const limit = boundedInteger('limit', params.limit, 50, 101);
  const offset = boundedInteger('offset', params.offset, 0, 1_000_000);
  values.push(limit, offset);

  const pool = getPool();
  const { rows } = await pool.query<Page>(
    `SELECT ${PAGE_COLUMNS}
     FROM pages
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC, id DESC
     LIMIT $${index++} OFFSET $${index}`,
    values
  );
  return rows;
}

interface BlockMutationContext {
  page_id: string;
  session_id: string | null;
}

async function getBlockMutationContext(blockId: string): Promise<BlockMutationContext | null> {
  await requireBlock(blockId);

  const pool = getPool();
  const { rows } = await pool.query<BlockMutationContext>(
    `SELECT b.page_id, p.session_id
     FROM blocks b
     JOIN pages p ON p.id = b.page_id
     WHERE b.id = $1
       AND p.archived_at IS NULL`,
    [blockId]
  );
  return rows[0] ?? null;
}

async function mutatePageBlock(
  blockId: string,
  mutation: (client: PoolClient) => Promise<Block | null>
): Promise<PageBlockMutation | null> {
  const context = await getBlockMutationContext(blockId);
  if (!context) return null;

  const pool = getPool();
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const pageResult = await client.query<{ revision: number }>(
      `UPDATE pages
       SET revision = revision + 1,
           updated_at = NOW()
       WHERE id = $1
         AND archived_at IS NULL
       RETURNING revision`,
      [context.page_id]
    );
    if (!pageResult.rows[0]) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return null;
    }

    const block = await mutation(client);
    if (!block) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return null;
    }

    await touchSession(context.session_id, client);
    await client.query('COMMIT');
    transactionOpen = false;
    return {
      block,
      page_revision: pageResult.rows[0].revision,
    };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updatePageBlock(
  blockId: string,
  params: {
    revision: number;
    content?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<PageBlockMutation | null> {
  assertRevision(params.revision);
  if (params.content === undefined && params.metadata === undefined) {
    throw new Error('At least one block field is required');
  }
  return mutatePageBlock(
    blockId,
    (client) => updateBlock(blockId, params, client)
  );
}

export function archivePageBlock(
  blockId: string,
  revision: number
): Promise<PageBlockMutation | null> {
  assertRevision(revision);
  return mutatePageBlock(
    blockId,
    (client) => archiveStoredBlock(blockId, revision, client)
  );
}

export function restorePageBlock(
  blockId: string,
  revision: number
): Promise<PageBlockMutation | null> {
  assertRevision(revision);
  return mutatePageBlock(
    blockId,
    (client) => restoreStoredBlock(blockId, revision, client)
  );
}

async function setPageArchived(
  id: string,
  revision: number,
  archived: boolean
): Promise<Page | null> {
  assertRevision(revision);
  await requirePage(id);

  const pool = getPool();
  const { rows } = await pool.query<Page>(
    `UPDATE pages
     SET archived_at = ${archived ? 'NOW()' : 'NULL'},
         revision = revision + 1,
         updated_at = NOW()
     WHERE id = $1
       AND revision = $2
       AND archived_at IS ${archived ? 'NULL' : 'NOT NULL'}
     RETURNING ${PAGE_COLUMNS}`,
    [id, revision]
  );
  if (!rows[0]) await assertPageRevision(id, revision);
  return rows[0] ?? null;
}

export function archivePage(
  id: string,
  revision: number
): Promise<Page | null> {
  return setPageArchived(id, revision, true);
}

export function restorePage(
  id: string,
  revision: number
): Promise<Page | null> {
  return setPageArchived(id, revision, false);
}
