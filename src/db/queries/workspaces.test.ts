import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    query: poolQueryMock,
  }),
}));

function buildWorkspace() {
  return {
    id: 'ws-1',
    name: 'Workspace',
    description: null,
    icon: null,
    expires_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  };
}

describe('workspace query concurrency', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
  });

  it('returns null when a workspace disappears after the optimistic read', async () => {
    poolQueryMock
      .mockResolvedValueOnce({
        rows: [{ ...buildWorkspace(), page_count: 0, database_count: 0 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { updateWorkspace } = await import('./workspaces.js');
    await expect(updateWorkspace('ws-1', {
      name: 'Renamed',
      expected_updated_at: '2026-01-02T00:00:00.000Z',
    })).resolves.toBeNull();
  });

  it('throws a conflict when a stale delete misses an existing workspace', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rows: [{ updated_at: '2026-01-03T00:00:00.000Z' }],
      });

    const { deleteWorkspace } = await import('./workspaces.js');
    await expect(deleteWorkspace(
      'ws-1',
      { kind: 'system' },
      '2026-01-02T00:00:00.000Z'
    )).rejects.toThrow('Conflict: workspace ws-1 was modified by another agent');
  });
});
