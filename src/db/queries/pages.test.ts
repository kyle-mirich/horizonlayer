import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const clientQueryMock = vi.fn();
const releaseMock = vi.fn();
const appendBlocksMock = vi.fn();
const updateBlockMock = vi.fn();
const deleteBlockMock = vi.fn();
const getBlocksForPageMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    connect: vi.fn(async () => ({
      query: clientQueryMock,
      release: releaseMock,
    })),
    query: poolQueryMock,
  }),
}));

vi.mock('../../embeddings/index.js', () => ({
  embed: vi.fn(),
  vectorToSql: vi.fn(),
}));

vi.mock('./blocks.js', () => ({
  appendBlocks: appendBlocksMock,
  deleteBlock: deleteBlockMock,
  getBlocksForPage: getBlocksForPageMock,
  getBlocksText: vi.fn(),
  updateBlock: updateBlockMock,
}));

describe('page query concurrency', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    appendBlocksMock.mockReset();
    updateBlockMock.mockReset();
    deleteBlockMock.mockReset();
    getBlocksForPageMock.mockReset();
    getBlocksForPageMock.mockResolvedValue([]);
  });

  it('returns null when an optimistic page update loses a race to deletion', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { updatePage } = await import('./pages.js');
    await expect(updatePage('page-1', {
      tags: ['updated'],
      expected_updated_at: '2026-01-02T00:00:00.000Z',
    })).resolves.toBeNull();
  });

  it('throws a conflict when a stale delete misses an existing page', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rows: [{ updated_at: '2026-01-03T00:00:00.000Z' }],
      });

    const { deletePage } = await import('./pages.js');
    await expect(deletePage(
      'page-1',
      { kind: 'system' },
      '2026-01-02T00:00:00.000Z'
    )).rejects.toThrow('Conflict: page page-1 was modified by another agent');
  });

  it('reports not found when append blocks loses a race to page deletion', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ session_id: null }],
    }).mockResolvedValueOnce({
      rows: [],
    });

    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE pages') && sql.includes('RETURNING title')) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { appendPageBlocks } = await import('./pages.js');
    await expect(appendPageBlocks(
      'page-1',
      [{ block_type: 'text', content: 'note' }],
      { kind: 'system' },
      '2026-01-02T00:00:00.000Z'
    )).rejects.toThrow('Page page-1 not found');

    expect(releaseMock).toHaveBeenCalled();
  });

  it('returns null when block update loses a race to page deletion', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ page_id: 'page-1' }],
    }).mockResolvedValueOnce({
      rows: [],
    });

    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE pages') && sql.includes('RETURNING title')) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { updatePageBlock } = await import('./pages.js');
    await expect(updatePageBlock(
      'block-1',
      { content: 'updated' },
      { kind: 'system' },
      '2026-01-02T00:00:00.000Z'
    )).resolves.toBeNull();

    expect(releaseMock).toHaveBeenCalled();
  });

  it('touches the parent session when updating a block on a session-scoped page', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ page_id: 'page-1', session_id: 'session-1' }],
    });

    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE pages') && sql.includes('RETURNING title')) {
        return { rows: [{ title: 'Page title' }], rowCount: 1 };
      }
      if (sql.includes('UPDATE sessions')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    updateBlockMock.mockResolvedValue({
      id: 'block-1',
      page_id: 'page-1',
      block_type: 'text',
      content: 'updated',
      position: 0,
      metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    const { updatePageBlock } = await import('./pages.js');
    await updatePageBlock('block-1', { content: 'updated' });

    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE sessions'))).toBe(true);
    expect(releaseMock).toHaveBeenCalled();
  });

  it('touches the parent session when deleting a block on a session-scoped page', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ page_id: 'page-1', session_id: 'session-1' }],
    });

    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE pages') && sql.includes('RETURNING title')) {
        return { rows: [{ title: 'Page title' }], rowCount: 1 };
      }
      if (sql.includes('UPDATE sessions')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    deleteBlockMock.mockResolvedValue({ page_id: 'page-1' });

    const { deletePageBlock } = await import('./pages.js');
    await deletePageBlock('block-1');

    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE sessions'))).toBe(true);
    expect(releaseMock).toHaveBeenCalled();
  });
});
