import { getPool, type PoolClient } from '../client.js';

export interface Block {
  id: string;
  page_id: string;
  block_type: string;
  content: string;
  position: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BlockInput {
  block_type: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export async function getBlocksForPage(pageId: string): Promise<Block[]> {
  const pool = getPool();
  const { rows } = await pool.query<Block>(
    'SELECT * FROM blocks WHERE page_id = $1 ORDER BY position ASC',
    [pageId]
  );
  return rows;
}

export async function appendBlocks(
  pageId: string,
  blocks: BlockInput[],
  existingClient?: PoolClient
): Promise<Block[]> {
  const pool = getPool();
  const client = existingClient ?? await pool.connect();
  const managesTransaction = !existingClient;

  try {
    if (managesTransaction) {
      await client.query('BEGIN');
    }

    // Get current max position
    const { rows: maxRows } = await client.query<{ max_pos: number | null }>(
      'SELECT MAX(position) AS max_pos FROM blocks WHERE page_id = $1',
      [pageId]
    );
    let pos = (maxRows[0].max_pos ?? -1) + 1;

    const inserted: Block[] = [];
    for (const block of blocks) {
      const { rows } = await client.query<Block>(
        `INSERT INTO blocks (page_id, block_type, content, position, metadata)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          pageId,
          block.block_type,
          block.content ?? '',
          pos,
          JSON.stringify(block.metadata ?? {}),
        ]
      );
      inserted.push(rows[0]);
      pos++;
    }

    if (managesTransaction) {
      await client.query('COMMIT');
    }
    return inserted;
  } catch (err) {
    if (managesTransaction) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    if (managesTransaction) {
      client.release();
    }
  }
}

export async function updateBlock(
  id: string,
  params: { content?: string; metadata?: Record<string, unknown> },
  client?: PoolClient
): Promise<Block | null> {
  const queryable = client ?? getPool();

  const sets: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let idx = 1;

  if (params.content !== undefined) { sets.push(`content = $${idx++}`); values.push(params.content); }
  if (params.metadata !== undefined) { sets.push(`metadata = $${idx++}`); values.push(JSON.stringify(params.metadata)); }

  values.push(id);
  const { rows } = await queryable.query<Block>(
    `UPDATE blocks SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0] ?? null;
}

export async function deleteBlock(id: string, client?: PoolClient): Promise<{ page_id: string } | null> {
  const queryable = client ?? getPool();
  const { rows } = await queryable.query<{ page_id: string }>(
    'DELETE FROM blocks WHERE id = $1 RETURNING page_id',
    [id]
  );
  return rows[0] ?? null;
}

export async function deleteBlocksForPage(pageId: string): Promise<void> {
  const pool = getPool();
  await pool.query('DELETE FROM blocks WHERE page_id = $1', [pageId]);
}

export function getBlocksText(blocks: Block[]): string {
  return blocks
    .filter((b) => b.content)
    .map((b) => b.content)
    .join('\n');
}
