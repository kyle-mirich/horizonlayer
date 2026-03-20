import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    query: poolQueryMock,
  }),
}));

vi.mock('../../embeddings/index.js', () => ({
  embed: vi.fn(),
  vectorToSql: vi.fn(),
}));

vi.mock('./blocks.js', () => ({
  appendBlocks: vi.fn(),
  deleteBlock: vi.fn(),
  getBlocksForPage: vi.fn(),
  getBlocksText: vi.fn(),
  updateBlock: vi.fn(),
}));

describe('page query concurrency', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
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
});
