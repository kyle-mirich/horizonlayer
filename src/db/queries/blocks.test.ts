import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const clientQueryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    connect: connectMock,
    query: poolQueryMock,
  }),
}));

function block(overrides: Record<string, unknown> = {}) {
  return {
    id: 'block-1',
    page_id: 'page-1',
    block_type: 'text',
    content: 'Body',
    position: 0,
    metadata: {},
    revision: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('block persistence', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockReset();
    connectMock.mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock,
    });
  });

  it('reads explicit columns in position order and excludes archived blocks by default', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [block()] });

    const { getBlocksForPage } = await import('./blocks.js');
    await expect(getBlocksForPage('page-1')).resolves.toEqual([block()]);

    const [sql, values] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('SELECT');
    expect(sql).toContain('revision');
    expect(sql).toContain('archived_at');
    expect(sql).toContain('($2::boolean OR archived_at IS NULL)');
    expect(sql).toContain('ORDER BY position ASC, id ASC');
    expect(sql).toContain('LIMIT $3 OFFSET $4');
    expect(sql).not.toContain('SELECT *');
    expect(values).toEqual(['page-1', false, 50, 0]);
  });

  it('can include archived blocks explicitly', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [block({ archived_at: '2026-01-02T00:00:00.000Z' })] });

    const { getBlocksForPage } = await import('./blocks.js');
    await getBlocksForPage('page-1', { include_archived: true });

    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual(['page-1', true, 50, 0]);
  });

  it('supports the page read lookahead and rejects invalid block pagination', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const { getBlocksForPage } = await import('./blocks.js');

    await expect(getBlocksForPage('page-1', { limit: 101, offset: 4 })).resolves.toEqual([]);
    await expect(getBlocksForPage('page-1', { limit: 102 })).rejects.toThrow(
      'limit must be an integer between 1 and 101'
    );
    await expect(getBlocksForPage('page-1', { offset: -1 })).rejects.toThrow(
      'offset must be an integer between 0 and 1000000'
    );

    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual(['page-1', false, 101, 4]);
  });

  it('serializes position allocation and appends atomically in a managed transaction', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'page-1' }] })
      .mockResolvedValueOnce({ rows: [{ max_pos: 1 }] })
      .mockResolvedValueOnce({ rows: [block({ id: 'block-2', position: 2, content: 'Second' })] })
      .mockResolvedValueOnce({ rows: [block({ id: 'block-3', position: 3, block_type: 'code', content: '' })] })
      .mockResolvedValueOnce({ rows: [] });

    const { appendBlocks } = await import('./blocks.js');
    const inserted = await appendBlocks('page-1', [
      { block_type: 'text', content: 'Second' },
      { block_type: 'code', metadata: { language: 'ts' } },
    ]);

    expect(inserted.map(({ id }) => id)).toEqual(['block-2', 'block-3']);
    expect(clientQueryMock.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('FOR UPDATE'))).toBe(true);
    expect(clientQueryMock).toHaveBeenCalledWith(
      'SELECT MAX(position) AS max_pos FROM blocks WHERE page_id = $1',
      ['page-1']
    );
    const insertSql = String(clientQueryMock.mock.calls[4]?.[0]);
    expect(insertSql).toContain('RETURNING');
    expect(insertSql).not.toContain('RETURNING *');
    expect(clientQueryMock.mock.calls[4]?.[1]).toEqual([
      'page-1',
      'code',
      '',
      3,
      JSON.stringify({ language: 'ts' }),
    ]);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases a managed append when insertion fails', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'page-1' }] })
      .mockResolvedValueOnce({ rows: [{ max_pos: null }] })
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce({ rows: [] });

    const { appendBlocks } = await import('./blocks.js');
    await expect(appendBlocks('page-1', [{ block_type: 'text' }])).rejects.toThrow('insert failed');

    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('uses a supplied client without managing its transaction', async () => {
    const existingClient = { query: vi.fn() };
    existingClient.query
      .mockResolvedValueOnce({ rows: [{ id: 'page-1' }] })
      .mockResolvedValueOnce({ rows: [{ max_pos: null }] })
      .mockResolvedValueOnce({ rows: [block()] });

    const { appendBlocks } = await import('./blocks.js');
    await appendBlocks('page-1', [{ block_type: 'text' }], existingClient as never);

    expect(connectMock).not.toHaveBeenCalled();
    expect(existingClient.query).not.toHaveBeenCalledWith('BEGIN');
    expect(existingClient.query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('does not check out a client for an empty append', async () => {
    const { appendBlocks } = await import('./blocks.js');
    await expect(appendBlocks('page-1', [])).resolves.toEqual([]);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('updates active blocks with a required revision and increments it atomically', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [block({ content: 'Updated', metadata: { tone: 'brief' }, revision: 4 })],
    });

    const { updateBlock } = await import('./blocks.js');
    await expect(updateBlock('block-1', {
      revision: 3,
      content: 'Updated',
      metadata: { tone: 'brief' },
    })).resolves.toMatchObject({ revision: 4, content: 'Updated' });

    const [sql, values] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('revision = revision + 1');
    expect(sql).toContain('AND revision = $4');
    expect(sql).toContain('AND archived_at IS NULL');
    expect(sql).not.toContain('RETURNING *');
    expect(values).toEqual(['Updated', JSON.stringify({ tone: 'brief' }), 'block-1', 3]);
  });

  it('reports a stale block revision and returns null for a missing block', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ revision: 5 }] });

    const { updateBlock } = await import('./blocks.js');
    await expect(updateBlock('block-1', { revision: 4, content: 'Stale' })).rejects.toThrow(
      'Conflict: block block-1 is at revision 5, not 4'
    );

    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(updateBlock('missing', { revision: 1, content: 'Nope' })).resolves.toBeNull();
  });

  it('archives and restores blocks without exposing hard deletion', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [block({ revision: 2, archived_at: '2026-01-02T00:00:00.000Z' })] })
      .mockResolvedValueOnce({ rows: [block({ revision: 3, archived_at: null })] });

    const blockQueries = await import('./blocks.js');
    await expect(blockQueries.archiveBlock('block-1', 1)).resolves.toMatchObject({ revision: 2 });
    await expect(blockQueries.restoreBlock('block-1', 2)).resolves.toMatchObject({ revision: 3 });

    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('archived_at = NOW()');
    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('archived_at IS NULL');
    expect(String(poolQueryMock.mock.calls[1]?.[0])).toContain('archived_at = NULL');
    expect(String(poolQueryMock.mock.calls[1]?.[0])).toContain('archived_at IS NOT NULL');
    expect(blockQueries).not.toHaveProperty('deleteBlock');
    expect(blockQueries).not.toHaveProperty('deleteBlocksForPage');
  });

  it('rejects invalid revisions and empty updates before querying', async () => {
    const { archiveBlock, updateBlock } = await import('./blocks.js');
    await expect(archiveBlock('block-1', 0)).rejects.toThrow('revision must be a positive integer');
    await expect(updateBlock('block-1', { revision: 1 })).rejects.toThrow(
      'At least one block field is required'
    );
    expect(poolQueryMock).not.toHaveBeenCalled();
  });
});
