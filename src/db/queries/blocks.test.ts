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

describe('block queries', () => {
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

  it('lists blocks for a page in persisted order', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'block-1',
          page_id: 'page-1',
          block_type: 'text',
          content: 'first',
          position: 0,
          metadata: {},
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const { getBlocksForPage } = await import('./blocks.js');
    await expect(getBlocksForPage('page-1')).resolves.toHaveLength(1);

    expect(poolQueryMock).toHaveBeenCalledWith(
      'SELECT * FROM blocks WHERE page_id = $1 ORDER BY position ASC',
      ['page-1']
    );
  });

  it('appends blocks in a managed transaction when no client is supplied', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ max_pos: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'block-2',
            page_id: 'page-1',
            block_type: 'text',
            content: 'second',
            position: 2,
            metadata: {},
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'block-3',
            page_id: 'page-1',
            block_type: 'code',
            content: '',
            position: 3,
            metadata: { language: 'ts' },
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { appendBlocks } = await import('./blocks.js');
    const inserted = await appendBlocks('page-1', [
      { block_type: 'text', content: 'second' },
      { block_type: 'code', metadata: { language: 'ts' } },
    ]);

    expect(inserted.map((block) => block.id)).toEqual(['block-2', 'block-3']);
    expect(clientQueryMock.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(clientQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO blocks'),
      ['page-1', 'code', '', 3, JSON.stringify({ language: 'ts' })]
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back a managed append transaction on insert failure', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ max_pos: null }] })
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { appendBlocks } = await import('./blocks.js');
    await expect(appendBlocks('page-1', [{ block_type: 'text' }])).rejects.toThrow('insert failed');

    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('uses an existing client without opening or closing a transaction', async () => {
    const existingClient = { query: vi.fn() };
    existingClient.query
      .mockResolvedValueOnce({ rows: [{ max_pos: null }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'block-1',
            page_id: 'page-1',
            block_type: 'text',
            content: '',
            position: 0,
            metadata: {},
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      });

    const { appendBlocks } = await import('./blocks.js');
    await appendBlocks('page-1', [{ block_type: 'text' }], existingClient as never);

    expect(connectMock).not.toHaveBeenCalled();
    expect(existingClient.query).not.toHaveBeenCalledWith('BEGIN');
    expect(existingClient.query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('updates and deletes individual blocks', async () => {
    poolQueryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'block-1',
            page_id: 'page-1',
            block_type: 'text',
            content: 'updated',
            position: 0,
            metadata: { tone: 'brief' },
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:01.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ page_id: 'page-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const { updateBlock, deleteBlock, deleteBlocksForPage } = await import('./blocks.js');

    await expect(updateBlock('block-1', { content: 'updated', metadata: { tone: 'brief' } })).resolves.toMatchObject({
      content: 'updated',
    });
    await expect(deleteBlock('block-1')).resolves.toEqual({ page_id: 'page-1' });
    await deleteBlocksForPage('page-1');

    expect(poolQueryMock.mock.calls[0]?.[0]).toContain('content = $1');
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual(['updated', JSON.stringify({ tone: 'brief' }), 'block-1']);
    expect(poolQueryMock).toHaveBeenCalledWith('DELETE FROM blocks WHERE page_id = $1', ['page-1']);
  });

  it('returns null for missing block mutations and extracts text content', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { updateBlock, deleteBlock, getBlocksText } = await import('./blocks.js');

    await expect(updateBlock('missing', {})).resolves.toBeNull();
    await expect(deleteBlock('missing')).resolves.toBeNull();
    expect(getBlocksText([
      { id: 'a', page_id: 'p', block_type: 'text', content: 'hello', position: 0, metadata: {}, created_at: '', updated_at: '' },
      { id: 'b', page_id: 'p', block_type: 'text', content: '', position: 1, metadata: {}, created_at: '', updated_at: '' },
      { id: 'c', page_id: 'p', block_type: 'text', content: 'world', position: 2, metadata: {}, created_at: '', updated_at: '' },
    ])).toBe('hello\nworld');
  });
});
