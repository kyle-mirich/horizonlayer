import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({ query: poolQuery }),
}));

describe('scope guards', () => {
  beforeEach(() => poolQuery.mockReset());

  it.each([
    ['requireActiveWorkspace', { id: 'ws-1' }, undefined, 'FROM workspaces'],
    ['requireSession', { workspace_id: 'ws-1' }, { workspace_id: 'ws-1' }, 'FROM sessions s'],
    ['requirePage', { workspace_id: 'ws-1', parent_page_id: null, session_id: null }, { workspace_id: 'ws-1', parent_page_id: null, session_id: null }, 'FROM pages p'],
    ['requireDatabase', { workspace_id: 'ws-1', parent_page_id: null }, { workspace_id: 'ws-1', parent_page_id: null }, 'FROM databases d'],
    ['requireBlock', { page_id: 'page-1', workspace_id: 'ws-1', session_id: null }, { page_id: 'page-1', workspace_id: 'ws-1', session_id: null }, 'FROM blocks'],
  ])('returns scope metadata from %s', async (name, row, expected, sqlNeedle) => {
    poolQuery.mockResolvedValueOnce({ rows: [row] });
    const guards = await import('./scopeGuards.js');
    const guard = guards[name as keyof typeof guards] as (id: string) => Promise<unknown>;

    await expect(guard('item-1')).resolves.toEqual(expected);
    expect(String(poolQuery.mock.calls[0]?.[0])).toContain(sqlNeedle);
  });

  it('allows active sessions and rejects closed sessions with a stateful error', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ workspace_id: 'ws-1', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ workspace_id: 'ws-1', status: 'closed' }] });
    const { requireActiveSession } = await import('./scopeGuards.js');

    await expect(requireActiveSession('active-1')).resolves.toEqual({ workspace_id: 'ws-1' });
    await expect(requireActiveSession('closed-1')).rejects.toThrow(
      'Session closed-1 is closed and cannot be modified'
    );

    expect(String(poolQuery.mock.calls[0]?.[0])).toContain('SELECT s.workspace_id, s.status');
  });

  it('locks active sessions for child writes without taking the workspace row lock', async () => {
    const transactionQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ workspace_id: 'ws-1', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ workspace_id: 'ws-1', status: 'closed' }] });
    const { lockActiveSessionForChildWrite } = await import('./scopeGuards.js');

    await expect(lockActiveSessionForChildWrite('active-1', { query: transactionQuery }))
      .resolves.toEqual({ workspace_id: 'ws-1' });
    await expect(lockActiveSessionForChildWrite('closed-1', { query: transactionQuery }))
      .rejects.toThrow('Session closed-1 is closed and cannot be modified');

    const sql = String(transactionQuery.mock.calls[0]?.[0]);
    expect(sql).toContain('FOR NO KEY UPDATE OF s');
    expect(sql).not.toContain('FOR NO KEY UPDATE OF s, w');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('distinguishes archived-capable page scope from active parent-page scope', async () => {
    poolQuery
      .mockResolvedValueOnce({
        rows: [{ workspace_id: 'ws-1', parent_page_id: null, session_id: null }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const { requirePage, requireActivePage } = await import('./scopeGuards.js');

    await expect(requirePage('archived-page')).resolves.toMatchObject({ workspace_id: 'ws-1' });
    await expect(requireActivePage('archived-page')).rejects.toThrow('Page archived-page not found');

    expect(String(poolQuery.mock.calls[0]?.[0])).not.toContain('p.archived_at IS NULL');
    expect(String(poolQuery.mock.calls[1]?.[0])).toContain('p.archived_at IS NULL');
  });

  it('builds the actual page-database-block lock graph before taking locks', async () => {
    const transactionQuery = vi.fn().mockImplementation(async (sql: string) => {
      if (sql === 'SELECT page_id FROM blocks WHERE id = $1') {
        return { rows: [{ page_id: 'page-p' }] };
      }
      if (sql.includes('FROM pages p')) return { rows: [{ workspace_id: 'ws-1' }] };
      if (sql.includes('FROM databases d')) return { rows: [{ workspace_id: 'ws-1' }] };
      if (sql.includes('FROM blocks') && sql.includes('FOR SHARE')) {
        return { rows: [{ id: 'block-b' }] };
      }
      if (sql.includes('FROM workspaces')) return { rows: [{ id: 'ws-1' }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { lockActiveLinkedItemsForWrite } = await import('./scopeGuards.js');

    await expect(lockActiveLinkedItemsForWrite([
      { id: 'database-d', type: 'database' },
      { id: 'block-b', type: 'block' },
    ], { query: transactionQuery })).resolves.toEqual([
      { id: 'database-d', type: 'database', workspace_id: 'ws-1' },
      { id: 'block-b', type: 'block', workspace_id: 'ws-1' },
    ]);

    const lockSql = transactionQuery.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('FOR SHARE'));
    expect(lockSql).toHaveLength(4);
    expect(lockSql[0]).toContain('FROM pages p');
    expect(lockSql[1]).toContain('FROM databases d');
    expect(lockSql[2]).toContain('FROM blocks');
    expect(lockSql[3]).toContain('FROM workspaces');
  });

  it('requires an active workspace for scoped operations', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const { requireActiveWorkspace } = await import('./scopeGuards.js');

    await expect(requireActiveWorkspace('archived-1')).rejects.toThrow(
      'Workspace archived-1 not found'
    );
    expect(String(poolQuery.mock.calls[0]?.[0])).toContain('archived_at IS NULL');
  });

  it('scopes links through their stored workspace without endpoint reads', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ workspace_id: 'ws-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ws-1' }] });
    const { requireLink } = await import('./scopeGuards.js');

    await expect(requireLink('link-1')).resolves.toEqual({ workspace_id: 'ws-1' });

    expect(poolQuery).toHaveBeenCalledTimes(2);
    expect(String(poolQuery.mock.calls[0]?.[0])).toContain('SELECT workspace_id');
    expect(String(poolQuery.mock.calls[1]?.[0])).toContain('FROM workspaces');
  });

  it('throws a useful error when a scoped entity does not exist', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const { requireLink } = await import('./scopeGuards.js');

    await expect(requireLink('missing')).rejects.toThrow('Link missing not found');
  });
});
