import { getPool, type PoolClient } from '../client.js';
import { withTransaction } from '../transaction.js';
import { assertArchiveTransition } from './archiveState.js';

const BLOCK_COLUMNS = `
  id,
  page_id,
  block_type,
  content,
  position,
  metadata,
  revision,
  archived_at,
  created_at,
  updated_at
`;

export interface Block {
  id: string;
  page_id: string;
  block_type: string;
  content: string;
  position: number;
  metadata: Record<string, unknown>;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BlockInput {
  block_type: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

function pagination(name: 'limit' | 'offset', value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  const minimum = name === 'limit' ? 1 : 0;
  const maximum = name === 'limit' ? 101 : 1_000_000;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function assertRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error('revision must be a positive integer');
  }
}

async function assertBlockRevision(
  id: string,
  revision: number,
  queryable: Pick<PoolClient, 'query'> = getPool()
): Promise<void> {
  const { rows } = await queryable.query<{ revision: number }>(
    'SELECT revision FROM blocks WHERE id = $1',
    [id]
  );
  if (rows[0] && rows[0].revision !== revision) {
    throw new Error(`Conflict: block ${id} is at revision ${rows[0].revision}, not ${revision}`);
  }
}

async function assertBlockArchiveTransition(
  id: string,
  revision: number,
  archived: boolean,
  queryable: Pick<PoolClient, 'query'> = getPool()
): Promise<void> {
  const { rows } = await queryable.query<{ revision: number; archived_at: string | null }>(
    'SELECT revision, archived_at FROM blocks WHERE id = $1',
    [id]
  );
  assertArchiveTransition('block', id, revision, archived, rows[0]);
}

export async function getBlocksForPage(
  pageId: string,
  params: { include_archived?: boolean; limit?: number; offset?: number } = {}
): Promise<Block[]> {
  const limit = pagination('limit', params.limit, 50);
  const offset = pagination('offset', params.offset, 0);
  const pool = getPool();
  const { rows } = await pool.query<Block>(
    `SELECT ${BLOCK_COLUMNS}
     FROM blocks
     WHERE page_id = $1
       AND ($2::boolean OR archived_at IS NULL)
     ORDER BY position ASC, id ASC
     LIMIT $3 OFFSET $4`,
    [pageId, params.include_archived ?? false, limit, offset]
  );
  return rows;
}

export async function appendBlocks(
  pageId: string,
  blocks: BlockInput[],
  existingClient?: PoolClient
): Promise<Block[]> {
  if (blocks.length === 0) return [];

  const append = async (client: PoolClient): Promise<Block[]> => {
    // Every append locks the page first. This serializes position allocation even
    // when appendBlocks is called directly instead of through the page wrapper.
    const pageResult = await client.query<{ id: string }>(
      `SELECT id
       FROM pages
       WHERE id = $1
         AND archived_at IS NULL
       FOR UPDATE`,
      [pageId]
    );
    if (!pageResult.rows[0]) {
      throw new Error(`Page ${pageId} not found`);
    }

    // Archived blocks retain their positions and may be restored, so they must
    // participate in allocation to preserve the unique (page_id, position) key.
    const { rows: maxRows } = await client.query<{ max_pos: number | null }>(
      'SELECT MAX(position) AS max_pos FROM blocks WHERE page_id = $1',
      [pageId]
    );
    let position = (maxRows[0]?.max_pos ?? -1) + 1;

    const inserted: Block[] = [];
    for (const block of blocks) {
      const { rows } = await client.query<Block>(
        `INSERT INTO blocks (page_id, block_type, content, position, metadata)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${BLOCK_COLUMNS}`,
        [
          pageId,
          block.block_type,
          block.content ?? '',
          position,
          JSON.stringify(block.metadata ?? {}),
        ]
      );
      inserted.push(rows[0]);
      position += 1;
    }

    return inserted;
  };

  return existingClient ? append(existingClient) : withTransaction(append);
}

export async function updateBlock(
  id: string,
  params: {
    revision: number;
    content?: string;
    metadata?: Record<string, unknown>;
  },
  client?: PoolClient
): Promise<Block | null> {
  assertRevision(params.revision);

  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  if (params.content !== undefined) {
    sets.push(`content = $${index++}`);
    values.push(params.content);
  }
  if (params.metadata !== undefined) {
    sets.push(`metadata = $${index++}`);
    values.push(JSON.stringify(params.metadata));
  }
  if (sets.length === 0) {
    throw new Error('At least one block field is required');
  }

  sets.push('revision = revision + 1', 'updated_at = NOW()');
  values.push(id, params.revision);

  const queryable = client ?? getPool();
  const { rows } = await queryable.query<Block>(
    `UPDATE blocks
     SET ${sets.join(', ')}
     WHERE id = $${index++}
       AND revision = $${index}
       AND archived_at IS NULL
     RETURNING ${BLOCK_COLUMNS}`,
    values
  );
  if (!rows[0]) await assertBlockRevision(id, params.revision, queryable);
  return rows[0] ?? null;
}

async function setBlockArchived(
  id: string,
  revision: number,
  archived: boolean,
  client?: PoolClient
): Promise<Block | null> {
  assertRevision(revision);
  const queryable = client ?? getPool();
  const { rows } = await queryable.query<Block>(
    `UPDATE blocks
     SET archived_at = ${archived ? 'NOW()' : 'NULL'},
         revision = revision + 1,
         updated_at = NOW()
     WHERE id = $1
       AND revision = $2
       AND archived_at IS ${archived ? 'NULL' : 'NOT NULL'}
     RETURNING ${BLOCK_COLUMNS}`,
    [id, revision]
  );
  if (!rows[0]) await assertBlockArchiveTransition(id, revision, archived, queryable);
  return rows[0] ?? null;
}

export function archiveBlock(
  id: string,
  revision: number,
  client?: PoolClient
): Promise<Block | null> {
  return setBlockArchived(id, revision, true, client);
}

export function restoreBlock(
  id: string,
  revision: number,
  client?: PoolClient
): Promise<Block | null> {
  return setBlockArchived(id, revision, false, client);
}
