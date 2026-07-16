import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({ query: poolQueryMock }),
}));

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    name: 'Workspace',
    description: null,
    icon: null,
    revision: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('workspace queries', () => {
  beforeEach(() => poolQueryMock.mockReset());

  it('creates, lists, and gets active workspaces', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [workspace()] })
      .mockResolvedValueOnce({ rows: [workspace()] })
      .mockResolvedValueOnce({ rows: [workspace({ page_count: 2, database_count: 1, session_count: 3 })] });

    const { createWorkspace, getWorkspace, listWorkspaces } = await import('./workspaces.js');
    await expect(createWorkspace({ name: ' Workspace ', description: ' Desc ' })).resolves.toMatchObject({ id: 'ws-1' });
    await expect(listWorkspaces({ limit: 10, offset: 5 })).resolves.toHaveLength(1);
    await expect(getWorkspace('ws-1')).resolves.toMatchObject({ page_count: 2, session_count: 3 });

    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual(['Workspace', 'Desc', null]);
    expect(poolQueryMock.mock.calls[1]?.[1]).toEqual([false, 10, 5]);
    expect(poolQueryMock.mock.calls[2]?.[1]).toEqual(['ws-1', false]);
  });

  it('requires a non-empty name and bounded pagination', async () => {
    const { createWorkspace, listWorkspaces } = await import('./workspaces.js');
    await expect(createWorkspace({ name: '   ' })).rejects.toThrow('cannot be empty');
    await expect(listWorkspaces({ limit: 102 })).rejects.toThrow('between 0 and 101');
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('updates with a revision and reports stale conflicts', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [workspace({ name: 'Renamed', revision: 2 })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ revision: 3 }] });

    const { updateWorkspace } = await import('./workspaces.js');
    await expect(updateWorkspace('ws-1', { revision: 1, name: ' Renamed ' })).resolves.toMatchObject({
      name: 'Renamed',
      revision: 2,
    });
    await expect(updateWorkspace('ws-1', { revision: 2, icon: 'x' })).rejects.toThrow(
      'Conflict: workspace ws-1 is at revision 3, not 2'
    );
  });

  it('returns null when a revision-checked target no longer exists', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { updateWorkspace } = await import('./workspaces.js');
    await expect(updateWorkspace('missing', { revision: 1, name: 'Renamed' })).resolves.toBeNull();
  });

  it('archives and restores with revision checks', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [workspace({ revision: 2, archived_at: 'now' })] })
      .mockResolvedValueOnce({ rows: [workspace({ revision: 3, archived_at: null })] });

    const { archiveWorkspace, restoreWorkspace } = await import('./workspaces.js');
    await expect(archiveWorkspace('ws-1', 1)).resolves.toMatchObject({ archived_at: 'now', revision: 2 });
    await expect(restoreWorkspace('ws-1', 2)).resolves.toMatchObject({ archived_at: null, revision: 3 });
  });
});
