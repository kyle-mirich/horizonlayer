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

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    name: 'Workspace',
    description: null,
    icon: null,
    expires_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('workspace query contracts', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockReset();
    connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
  });

  it('creates, lists, and fetches workspaces with counts', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [workspace({ expires_at: 'future' })] })
      .mockResolvedValueOnce({ rows: [workspace(), workspace({ id: 'ws-2' })] })
      .mockResolvedValueOnce({ rows: [workspace({ page_count: 1, database_count: 2 })] });

    const { createWorkspace, getWorkspace, listWorkspaces } = await import('./workspaces.js');

    await expect(createWorkspace('Workspace', 'Desc', 'icon', 3)).resolves.toMatchObject({ expires_at: 'future' });
    await expect(listWorkspaces()).resolves.toHaveLength(2);
    await expect(getWorkspace('ws-1')).resolves.toMatchObject({ page_count: 1, database_count: 2 });
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual(['Workspace', 'Desc', 'icon', expect.any(String)]);
  });

  it('updates workspaces, returns current values for no-op updates, and detects stale writes', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [workspace()] })
      .mockResolvedValueOnce({ rows: [workspace({ name: 'Updated' })] })
      .mockResolvedValueOnce({ rows: [workspace()] })
      .mockResolvedValueOnce({ rows: [workspace()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ updated_at: '2026-01-01T00:00:00.000Z' }] });

    const { updateWorkspace } = await import('./workspaces.js');

    await expect(updateWorkspace('ws-1', { name: 'Updated', description: 'Desc', icon: 'icon', expires_in_days: 1 })).resolves.toMatchObject({
      name: 'Updated',
    });
    await expect(updateWorkspace('ws-1', {})).resolves.toMatchObject({ id: 'ws-1', name: 'Workspace' });
    await expect(updateWorkspace('ws-1', { name: 'Stale', expected_updated_at: '2026-01-01T00:00:00.000Z' })).rejects.toThrow(
      'Conflict: workspace ws-1 was modified by another agent'
    );
  });

  it('deletes workspaces with optional optimistic concurrency', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { deleteWorkspace } = await import('./workspaces.js');

    await expect(deleteWorkspace('ws-1', { kind: 'system' }, '2026-01-01T00:00:00.000Z')).resolves.toBe(true);
    await expect(deleteWorkspace('missing', { kind: 'system' }, '2026-01-01T00:00:00.000Z')).resolves.toBe(false);
    expect(poolQueryMock.mock.calls[0]?.[0]).toBe('DELETE FROM workspaces WHERE id = $1 AND updated_at = $2');
  });

  it('cleans up expired workspaces in a transaction and rolls back on failure', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'ws-1' }, { id: 'ws-2' }] });

    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { cleanupExpiredWorkspaces } = await import('./workspaces.js');

    await expect(cleanupExpiredWorkspaces()).resolves.toEqual({ workspaces_deleted: 0 });
    await expect(cleanupExpiredWorkspaces()).resolves.toEqual({ workspaces_deleted: 2 });
    expect(clientQueryMock.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(clientQueryMock.mock.calls[1]?.[0]).toContain('DELETE FROM links');
    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('COMMIT');

    poolQueryMock.mockResolvedValueOnce({ rows: [{ id: 'ws-3' }] });
    clientQueryMock.mockReset();
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(new Error('delete failed'))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(cleanupExpiredWorkspaces()).rejects.toThrow('delete failed');
    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(releaseMock).toHaveBeenCalledTimes(2);
  });
});
