import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  connect: vi.fn(),
  lockActiveLinkedItemsForWrite: vi.fn(),
  poolQuery: vi.fn(),
  release: vi.fn(),
  requireActiveWorkspace: vi.fn(),
  requireLink: vi.fn(),
}));

vi.mock('../client.js', () => ({
  getPool: () => ({ connect: mocks.connect, query: mocks.poolQuery }),
}));

vi.mock('./scopeGuards.js', () => ({
  lockActiveLinkedItemsForWrite: mocks.lockActiveLinkedItemsForWrite,
  requireActiveWorkspace: mocks.requireActiveWorkspace,
  requireLink: mocks.requireLink,
}));

import { archiveLink, createLink, listLinks, restoreLink } from './links.js';

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    workspace_id: 'ws-1',
    from_type: 'page',
    from_id: 'page-1',
    to_type: 'row',
    to_id: 'row-1',
    link_type: 'related',
    revision: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('link query coverage cases', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
    mocks.lockActiveLinkedItemsForWrite.mockResolvedValue([
      { id: 'page-1', type: 'page', workspace_id: 'ws-1' },
      { id: 'row-1', type: 'row', workspace_id: 'ws-1' },
    ]);
    mocks.requireActiveWorkspace.mockResolvedValue(undefined);
    mocks.requireLink.mockResolvedValue({ workspace_id: 'ws-1' });
  });

  it('rolls back create when a locked endpoint belongs to another workspace', async () => {
    mocks.lockActiveLinkedItemsForWrite.mockResolvedValueOnce([
      { id: 'page-1', type: 'page', workspace_id: 'other' },
    ]);
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(createLink({
      workspace_id: 'ws-1', from_type: 'page', from_id: 'page-1', to_type: 'row', to_id: 'row-1',
    })).rejects.toThrow('page page-1 belongs to workspace other, not ws-1');
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('validates list pagination and applies directional endpoint predicates', async () => {
    await expect(listLinks({ workspace_id: 'ws-1', limit: 102 })).rejects.toThrow('between 0 and 101');
    await expect(listLinks({ workspace_id: 'ws-1', link_type: '  ' })).rejects.toThrow('link_type cannot be empty');
    await expect(listLinks({ workspace_id: 'ws-1', direction: 'from' })).rejects.toThrow('direction requires item_type');
    await expect(listLinks({ workspace_id: 'ws-1', direction: 'sideways' as never })).rejects.toThrow('direction must be');

    mocks.poolQuery.mockResolvedValue({ rows: [link()] });
    await listLinks({ workspace_id: 'ws-1', item_type: 'page', item_id: 'page-1', direction: 'from' });
    await listLinks({ workspace_id: 'ws-1', item_type: 'row', item_id: 'row-1', direction: 'to' });
    await listLinks({ workspace_id: 'ws-1' });
    const sql = mocks.poolQuery.mock.calls.map(([statement]) => String(statement));
    expect(sql[0]).toContain('from_type = $3 AND from_id = $4');
    expect(sql[1]).toContain('to_type = $3 AND to_id = $4');
    expect(sql[2]).not.toContain('from_type =');
  });

  it('reports state conflicts for archive misses while preserving a missing-link null result', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE links')) return { rows: [] };
      if (sql.includes('SELECT revision, archived_at')) return { rows: [{ revision: 1, archived_at: '2026-01-02' }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveLink('link-1', 1)).rejects.toThrow('link link-1 is already archived');

    mocks.poolQuery.mockReset();
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE links') || sql.includes('SELECT revision, archived_at')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveLink('gone', 1)).resolves.toBeNull();
  });

  it('returns null for a missing restore lock and rolls back active links that cannot be restored', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM links') && sql.includes('FOR UPDATE')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(restoreLink('gone', 1)).resolves.toBeNull();
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');

    mocks.clientQuery.mockReset();
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM links') && sql.includes('FOR UPDATE')) return { rows: [link()] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(restoreLink('link-1', 1)).rejects.toThrow('link link-1 is already restored');
  });
});
