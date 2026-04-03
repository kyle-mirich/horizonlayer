import { isSystemAccess, type AccessContext } from '../access.js';
import { getPool } from '../client.js';
import { embed, vectorToSql } from '../../embeddings/index.js';
import { appendBlocks, deleteBlock, getBlocksForPage, getBlocksText, updateBlock, type BlockInput } from './blocks.js';
import {
  assertBlockWriteAccess,
  assertPageReadAccess,
  assertPageWriteAccess,
  assertSessionReadAccess,
  assertSessionWriteAccess,
  assertWorkspaceWriteAccess,
} from './accessControl.js';
import { touchSession } from './sessions.js';

export interface Page {
  id: string;
  workspace_id: string | null;
  session_id: string | null;
  parent_page_id: string | null;
  title: string;
  icon: string | null;
  cover_url: string | null;
  tags: string[];
  source: string | null;
  importance: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
}

export interface PageWithBlocks extends Page {
  blocks: Awaited<ReturnType<typeof getBlocksForPage>>;
}

function logEmbeddingFailure(pageId: string, error: unknown): void {
  console.error(`Failed to update page embedding for ${pageId}:`, error);
}

async function assertPageConflict(id: string, expectedUpdatedAt?: string): Promise<void> {
  if (!expectedUpdatedAt) {
    return;
  }
  const pool = getPool();
  const { rows } = await pool.query<{ updated_at: string }>(
    'SELECT updated_at FROM pages WHERE id = $1',
    [id]
  );
  if (rows[0]) {
    throw new Error(`Conflict: page ${id} was modified by another agent`);
  }
}

export async function createPage(params: {
  title: string;
  workspace_id?: string;
  session_id?: string;
  parent_page_id?: string;
  icon?: string;
  cover_url?: string;
  tags?: string[];
  source?: string;
  importance?: number;
  expires_in_days?: number;
  blocks?: BlockInput[];
  access?: AccessContext;
}): Promise<PageWithBlocks> {
  const pool = getPool();
  const access = params.access ?? { kind: 'system' as const };

  let workspaceId = params.workspace_id ?? null;
  let sessionId = params.session_id ?? null;
  if (params.parent_page_id) {
    const parent = await assertPageWriteAccess(params.parent_page_id, access);
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
    const session = await assertSessionWriteAccess(sessionId, access);
    if (workspaceId && workspaceId !== session.workspace_id) {
      throw new Error('session_id must belong to the target workspace');
    }
    workspaceId = session.workspace_id;
  } else if (workspaceId) {
    await assertWorkspaceWriteAccess(workspaceId, access);
  } else if (!isSystemAccess(access)) {
    throw new Error('workspace_id is required for authenticated page creation');
  }

  const expiresAt = params.expires_in_days
    ? new Date(Date.now() + params.expires_in_days * 86400000).toISOString()
    : null;

  const { rows } = await pool.query<Page>(
    `INSERT INTO pages (title, workspace_id, session_id, parent_page_id, icon, cover_url, tags, source, importance, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      params.title,
      workspaceId,
      sessionId,
      params.parent_page_id ?? null,
      params.icon ?? null,
      params.cover_url ?? null,
      params.tags ?? [],
      params.source ?? null,
      params.importance ?? 0.5,
      expiresAt,
    ]
  );
  const page = rows[0];

  let blocks: Awaited<ReturnType<typeof getBlocksForPage>> = [];
  if (params.blocks && params.blocks.length > 0) {
    blocks = await appendBlocks(page.id, params.blocks);
  }

  try {
    await updatePageEmbedding(page.id, page.title, blocks);
  } catch (error) {
    logEmbeddingFailure(page.id, error);
  }

  if (page.session_id) {
    await touchSession(page.session_id);
  }

  return { ...page, blocks };
}

export async function getPage(
  id: string,
  access: AccessContext = { kind: 'system' },
  session_id?: string
): Promise<PageWithBlocks | null> {
  const pool = getPool();

  if (!isSystemAccess(access)) {
    await assertPageReadAccess(id, access);
  }
  if (session_id) {
    await assertSessionReadAccess(session_id, access);
  }

  const { rows } = await pool.query<Page>(
    `UPDATE pages SET last_accessed_at = NOW()
     WHERE id = $1${session_id ? ' AND session_id = $2' : ''}
     RETURNING *`,
    session_id ? [id, session_id] : [id]
  );
  if (!rows[0]) return null;

  const blocks = await getBlocksForPage(id);
  return { ...rows[0], blocks };
}

export async function updatePage(
  id: string,
  params: {
    title?: string;
    icon?: string;
    cover_url?: string;
    tags?: string[];
    importance?: number;
    expected_updated_at?: string;
  },
  access: AccessContext = { kind: 'system' }
): Promise<Page | null> {
  const pool = getPool();

  if (!isSystemAccess(access)) {
    await assertPageWriteAccess(id, access);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.title !== undefined) {
    sets.push(`title = $${idx++}`);
    values.push(params.title);
  }
  if (params.icon !== undefined) {
    sets.push(`icon = $${idx++}`);
    values.push(params.icon);
  }
  if (params.cover_url !== undefined) {
    sets.push(`cover_url = $${idx++}`);
    values.push(params.cover_url);
  }
  if (params.tags !== undefined) {
    sets.push(`tags = $${idx++}`);
    values.push(params.tags);
  }
  if (params.importance !== undefined) {
    sets.push(`importance = $${idx++}`);
    values.push(params.importance);
  }

  if (sets.length === 0) {
    const { rows } = await pool.query<Page>('SELECT * FROM pages WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  sets.push(`updated_at = NOW()`);
  values.push(id);
  if (params.expected_updated_at) {
    values.push(params.expected_updated_at);
  }

  const { rows } = await pool.query<Page>(
    `UPDATE pages SET ${sets.join(', ')} WHERE id = $${idx}${params.expected_updated_at ? ` AND updated_at = $${idx + 1}` : ''} RETURNING *`,
    values
  );

  if (!rows[0]) {
    await assertPageConflict(id, params.expected_updated_at);
    return null;
  }

  // Re-embed if title changed
  if (params.title !== undefined) {
    const blocks = await getBlocksForPage(id);
    try {
      await updatePageEmbedding(id, rows[0].title, blocks);
    } catch (error) {
      logEmbeddingFailure(id, error);
    }
  }

  return rows[0];
}

export async function appendPageBlocks(
  pageId: string,
  blocks: BlockInput[],
  access: AccessContext = { kind: 'system' },
  expected_updated_at?: string,
  session_id?: string
): Promise<Awaited<ReturnType<typeof getBlocksForPage>>> {
  const pageAccess = !isSystemAccess(access)
    ? await assertPageWriteAccess(pageId, access)
    : (await getPool().query<{ session_id: string | null }>('SELECT session_id FROM pages WHERE id = $1', [pageId])).rows[0] ?? null;
  if (!pageAccess) {
    throw new Error(`Page ${pageId} not found`);
  }
  if (session_id) {
    await assertSessionWriteAccess(session_id, access);
    if (pageAccess.session_id !== session_id) {
      throw new Error(`Page ${pageId} is not associated with session ${session_id}`);
    }
  }
  const pool = getPool();
  const client = await pool.connect();
  let title: string | null = null;
  let finished = false;
  try {
    await client.query('BEGIN');
    const touchResult = await client.query<{ title: string }>(
      `UPDATE pages
       SET updated_at = NOW()
       WHERE id = $1${expected_updated_at ? ' AND updated_at = $2' : ''}
       RETURNING title`,
      expected_updated_at ? [pageId, expected_updated_at] : [pageId]
    );
    if (!touchResult.rows[0]) {
      await client.query('ROLLBACK');
      finished = true;
      await assertPageConflict(pageId, expected_updated_at);
      throw new Error(`Page ${pageId} not found`);
    }
    title = touchResult.rows[0].title;
    const inserted = await appendBlocks(pageId, blocks, client);
    await touchSession(pageAccess.session_id, client);
    await client.query('COMMIT');
    finished = true;

    const allBlocks = await getBlocksForPage(pageId);
    if (title) {
      try {
        await updatePageEmbedding(pageId, title, allBlocks);
      } catch (error) {
        logEmbeddingFailure(pageId, error);
      }
    }

    return inserted;
  } catch (error) {
    if (!finished) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listPages(params: {
  workspace_id?: string;
  session_id?: string;
  parent_page_id?: string;
  tags?: string[];
  min_importance?: number;
  limit?: number;
  offset?: number;
  access?: AccessContext;
}): Promise<Page[]> {
  const pool = getPool();
  const access = params.access ?? { kind: 'system' as const };

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.session_id) {
    const session = await assertSessionReadAccess(params.session_id, access);
    if (params.workspace_id && params.workspace_id !== session.workspace_id) {
      throw new Error('session_id must belong to the requested workspace');
    }
  }

  if (params.workspace_id !== undefined) {
    conditions.push(`workspace_id = $${idx++}`);
    values.push(params.workspace_id);
  }
  if (params.session_id !== undefined) {
    conditions.push(`session_id = $${idx++}`);
    values.push(params.session_id);
  }
  if (params.parent_page_id !== undefined) {
    conditions.push(`parent_page_id = $${idx++}`);
    values.push(params.parent_page_id);
  }
  if (params.tags && params.tags.length > 0) {
    conditions.push(`tags && $${idx++}`);
    values.push(params.tags);
  }
  if (params.min_importance !== undefined) {
    conditions.push(`importance >= $${idx++}`);
    values.push(params.min_importance);
  }
  void access;

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const { rows } = await pool.query<Page>(
    `SELECT * FROM pages ${where} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`,
    values
  );
  return rows;
}

export async function updatePageBlock(
  blockId: string,
  params: { content?: string; metadata?: Record<string, unknown> },
  access: AccessContext = { kind: 'system' },
  expected_updated_at?: string
): Promise<Awaited<ReturnType<typeof getBlocksForPage>>[0] | null> {
  const blockAccess = !isSystemAccess(access)
    ? await assertBlockWriteAccess(blockId, access)
    : (await getPool().query<{ page_id: string; session_id: string | null }>(
      `SELECT b.page_id, p.session_id
       FROM blocks b
       JOIN pages p ON p.id = b.page_id
       WHERE b.id = $1`,
      [blockId]
    )).rows[0] ?? null;
  const pageId = blockAccess?.page_id;
  if (!pageId) return null;
  const pool = getPool();
  const client = await pool.connect();
  let title: string | null = null;
  let finished = false;
  try {
    await client.query('BEGIN');
    const touchResult = await client.query<{ title: string }>(
      `UPDATE pages
       SET updated_at = NOW()
       WHERE id = $1${expected_updated_at ? ' AND updated_at = $2' : ''}
       RETURNING title`,
      expected_updated_at ? [pageId, expected_updated_at] : [pageId]
    );
    if (!touchResult.rows[0]) {
      await client.query('ROLLBACK');
      finished = true;
      await assertPageConflict(pageId, expected_updated_at);
      return null;
    }
    title = touchResult.rows[0].title;
    const block = await updateBlock(blockId, params, client);
    if (!block) {
      await client.query('ROLLBACK');
      finished = true;
      return null;
    }
    await touchSession(blockAccess.session_id, client);
    await client.query('COMMIT');
    finished = true;
    const allBlocks = await getBlocksForPage(pageId);
    if (title) {
      try {
        await updatePageEmbedding(pageId, title, allBlocks);
      } catch (error) {
        logEmbeddingFailure(pageId, error);
      }
    }
    return block;
  } catch (error) {
    if (!finished) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function deletePageBlock(
  blockId: string,
  access: AccessContext = { kind: 'system' },
  expected_updated_at?: string
): Promise<boolean> {
  const blockAccess = !isSystemAccess(access)
    ? await assertBlockWriteAccess(blockId, access)
    : (await getPool().query<{ page_id: string; session_id: string | null }>(
      `SELECT b.page_id, p.session_id
       FROM blocks b
       JOIN pages p ON p.id = b.page_id
       WHERE b.id = $1`,
      [blockId]
    )).rows[0] ?? null;
  const pageId = blockAccess?.page_id;
  if (!pageId) return false;
  const pool = getPool();
  const client = await pool.connect();
  let title: string | null = null;
  let finished = false;
  try {
    await client.query('BEGIN');
    const touchResult = await client.query<{ title: string }>(
      `UPDATE pages
       SET updated_at = NOW()
       WHERE id = $1${expected_updated_at ? ' AND updated_at = $2' : ''}
       RETURNING title`,
      expected_updated_at ? [pageId, expected_updated_at] : [pageId]
    );
    if (!touchResult.rows[0]) {
      await client.query('ROLLBACK');
      finished = true;
      await assertPageConflict(pageId, expected_updated_at);
      return false;
    }
    title = touchResult.rows[0].title;
    const result = await deleteBlock(blockId, client);
    if (!result) {
      await client.query('ROLLBACK');
      finished = true;
      return false;
    }
    await touchSession(blockAccess.session_id, client);
    await client.query('COMMIT');
    finished = true;
    const allBlocks = await getBlocksForPage(pageId);
    if (title) {
      try {
        await updatePageEmbedding(pageId, title, allBlocks);
      } catch (error) {
        logEmbeddingFailure(pageId, error);
      }
    }
    return true;
  } catch (error) {
    if (!finished) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function deletePage(
  id: string,
  access: AccessContext = { kind: 'system' },
  expected_updated_at?: string
): Promise<boolean> {
  if (!isSystemAccess(access)) {
    await assertPageWriteAccess(id, access);
  }
  const pool = getPool();
  const values: unknown[] = [id];
  let sql = 'DELETE FROM pages WHERE id = $1';
  if (expected_updated_at) {
    values.push(expected_updated_at);
    sql += ' AND updated_at = $2';
  }
  const { rowCount } = await pool.query(sql, values);
  if ((rowCount ?? 0) === 0) {
    await assertPageConflict(id, expected_updated_at);
  }
  return (rowCount ?? 0) > 0;
}

async function updatePageEmbedding(
  pageId: string,
  title: string,
  blocks: Awaited<ReturnType<typeof getBlocksForPage>>
): Promise<void> {
  const text = title + (blocks.length > 0 ? '\n' + getBlocksText(blocks) : '');
  const vec = await embed(text);
  const pool = getPool();
  await pool.query('UPDATE pages SET embedding = $1 WHERE id = $2', [
    vectorToSql(vec),
    pageId,
  ]);
}
