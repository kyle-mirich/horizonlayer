import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  lockActiveLinkedItemsForWrite: vi.fn(),
  requireLink: vi.fn(),
  requireActiveWorkspace: vi.fn(),
}));

vi.mock('../client.js', () => ({
  getPool: () => ({ query: mocks.poolQuery, connect: mocks.connect }),
}));

vi.mock('./scopeGuards.js', () => ({
  lockActiveLinkedItemsForWrite: mocks.lockActiveLinkedItemsForWrite,
  requireActiveWorkspace: mocks.requireActiveWorkspace,
  requireLink: mocks.requireLink,
}));

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    workspace_id: 'ws-1',
    from_type: 'page',
    from_id: 'page-1',
    to_type: 'row',
    to_id: 'row-1',
    link_type: 'supports',
    revision: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('link persistence contracts', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.requireLink.mockResolvedValue({ workspace_id: 'ws-1' });
    mocks.requireActiveWorkspace.mockResolvedValue(undefined);
    mocks.lockActiveLinkedItemsForWrite.mockImplementation(async (items: Array<{
      id: string;
      type: string;
    }>) => items.map((item) => ({ ...item, workspace_id: 'ws-1' })));
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  });

  it('creates only active endpoints using canonical locks independent of caller direction', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('INSERT INTO links')) return { rows: [link()] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { createLink } = await import('./links.js');

    await expect(createLink({
      workspace_id: 'ws-1',
      from_type: 'row',
      from_id: 'row-1',
      to_type: 'page',
      to_id: 'page-1',
      link_type: ' supports ',
    })).resolves.toMatchObject({ id: 'link-1', workspace_id: 'ws-1' });

    expect(mocks.requireActiveWorkspace).toHaveBeenCalledOnce();
    expect(mocks.lockActiveLinkedItemsForWrite).toHaveBeenCalledWith(
      [
        { id: 'row-1', type: 'row' },
        { id: 'page-1', type: 'page' },
      ],
      expect.objectContaining({ query: mocks.clientQuery })
    );
    const insert = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO links'));
    expect(insert?.[1]).toEqual([
      'ws-1', 'row', 'row-1', 'page', 'page-1', 'supports',
    ]);
    expect(String(insert?.[0])).not.toContain('RETURNING *');
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('rejects unsupported item types before issuing access or persistence queries', async () => {
    const { createLink } = await import('./links.js');

    await expect(createLink({
      workspace_id: 'ws-1',
      from_type: 'unsupported',
      from_id: 'row-1',
      to_type: 'page',
      to_id: 'page-1',
    })).rejects.toThrow('Unsupported linked item type: unsupported');
    expect(mocks.requireActiveWorkspace).not.toHaveBeenCalled();
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('lists directly by workspace with paired endpoint filters and pagination', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [link()] });
    const { listLinks } = await import('./links.js');

    await expect(listLinks({
      workspace_id: 'ws-1',
      item_type: 'row',
      item_id: 'row-1',
      direction: 'both',
      link_type: 'supports',
      limit: 101,
      offset: 30,
    })).resolves.toHaveLength(1);

    const [sql, values] = mocks.poolQuery.mock.calls[0] ?? [];
    expect(String(sql)).toContain('workspace_id = $2');
    expect(String(sql)).toContain('from_type');
    expect(String(sql)).toContain('to_type');
    expect(String(sql)).toContain('LIMIT $6 OFFSET $7');
    expect(values).toEqual([false, 'ws-1', 'supports', 'row', 'row-1', 101, 30]);
    expect(mocks.requireActiveWorkspace).toHaveBeenCalledOnce();
  });

  it('requires item_type and item_id together', async () => {
    const { listLinks } = await import('./links.js');

    await expect(listLinks({ workspace_id: 'ws-1', item_type: 'row' })).rejects.toThrow(
      'item_type and item_id must be supplied together'
    );
    await expect(listLinks({ workspace_id: 'ws-1', item_id: 'row-1' })).rejects.toThrow(
      'item_type and item_id must be supplied together'
    );
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('archives links with optimistic revisions while keeping relationship fields immutable', async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [link({ revision: 2, archived_at: '2026-01-02T00:00:00.000Z' })],
    });
    const { archiveLink } = await import('./links.js');

    await expect(archiveLink('link-1', 1)).resolves.toMatchObject({ revision: 2 });

    const [sql, values] = mocks.poolQuery.mock.calls[0] ?? [];
    expect(String(sql)).toContain('revision = revision + 1');
    expect(String(sql)).toContain('AND revision = $3');
    expect(String(sql)).not.toMatch(/from_type\s*=|to_type\s*=|link_type\s*=/);
    expect(values).toEqual(['link-1', 'ws-1', 1]);
  });

  it('reports stale link revisions', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM links') && sql.includes('FOR UPDATE')) {
        return { rows: [link({ revision: 5, archived_at: '2026-01-02T00:00:00.000Z' })] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { restoreLink } = await import('./links.js');

    await expect(restoreLink('link-1', 2)).rejects.toThrow(
      'link link-1 is at revision 5, not 2'
    );
    expect(mocks.lockActiveLinkedItemsForWrite).not.toHaveBeenCalled();
    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('restores only after locking both immutable endpoints active', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('FROM links') && sql.includes('FOR UPDATE')) {
        return { rows: [link({ revision: 2, archived_at: '2026-01-02T00:00:00.000Z' })] };
      }
      if (sql.includes('UPDATE links')) return { rows: [link({ revision: 3 })] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { restoreLink } = await import('./links.js');

    await expect(restoreLink('link-1', 2)).resolves.toMatchObject({ revision: 3 });

    expect(mocks.lockActiveLinkedItemsForWrite).toHaveBeenCalledWith(
      [
        { id: 'page-1', type: 'page' },
        { id: 'row-1', type: 'row' },
      ],
      expect.objectContaining({ query: mocks.clientQuery })
    );
    const statements = mocks.clientQuery.mock.calls.map(([sql]) => String(sql));
    expect(statements.findIndex((sql) => sql.includes('FOR UPDATE'))).toBeLessThan(
      statements.findIndex((sql) => sql.includes('UPDATE links'))
    );
  });
});
