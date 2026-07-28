import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.hoisted(() => vi.fn());

vi.mock('../client.js', () => ({
  getPool: () => ({ query: poolQuery }),
}));

import { lockActiveLinkedItemsForWrite, lockActivePageForChildWrite } from './scopeGuards.js';

describe('scope guard coverage cases', () => {
  beforeEach(() => poolQuery.mockReset());

  it('locks an active parent page through a caller-owned transaction', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ workspace_id: 'ws-1', parent_page_id: 'parent-1', session_id: 'session-1' }],
    });

    await expect(lockActivePageForChildWrite('page-1', { query })).resolves.toEqual({
      workspace_id: 'ws-1', parent_page_id: 'parent-1', session_id: 'session-1',
    });
    expect(String(query.mock.calls[0]?.[0])).toContain('FOR SHARE OF p');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('resolves, deduplicates, and locks every linked item type in the global order', async () => {
    const query = vi.fn().mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql === 'SELECT database_id FROM database_rows WHERE id = $1') {
        return { rows: [{ database_id: 'database-1' }] };
      }
      if (sql === 'SELECT page_id FROM blocks WHERE id = $1') {
        return { rows: [{ page_id: 'page-1' }] };
      }
      if (sql.includes('FROM pages p') && sql.includes('FOR SHARE OF p')) {
        return { rows: [{ workspace_id: 'workspace-1' }] };
      }
      if (sql.includes('FROM databases d') && sql.includes('FOR SHARE OF d')) {
        return { rows: [{ workspace_id: 'workspace-1' }] };
      }
      if (sql.includes('FROM database_rows') && sql.includes('FOR SHARE')) {
        expect(values).toEqual(['row-1', 'database-1']);
        return { rows: [{ id: 'row-1' }] };
      }
      if (sql.includes('FROM blocks') && sql.includes('FOR SHARE')) {
        expect(values).toEqual(['block-1', 'page-1']);
        return { rows: [{ id: 'block-1' }] };
      }
      if (sql.includes('FROM workspaces') && sql.includes('FOR SHARE')) {
        return { rows: [{ id: values?.[0] }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(lockActiveLinkedItemsForWrite([
      { id: 'workspace-1', type: 'workspace' },
      { id: 'page-1', type: 'page' },
      { id: 'database-1', type: 'database' },
      { id: 'row-1', type: 'row' },
      { id: 'block-1', type: 'block' },
      { id: 'row-1', type: 'row' },
    ], { query })).resolves.toEqual([
      { id: 'workspace-1', type: 'workspace', workspace_id: 'workspace-1' },
      { id: 'page-1', type: 'page', workspace_id: 'workspace-1' },
      { id: 'database-1', type: 'database', workspace_id: 'workspace-1' },
      { id: 'row-1', type: 'row', workspace_id: 'workspace-1' },
      { id: 'block-1', type: 'block', workspace_id: 'workspace-1' },
    ]);
    const locks = query.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes('FOR SHARE'));
    expect(locks).toHaveLength(5);
    expect(locks[0]).toContain('FROM pages p');
    expect(locks[1]).toContain('FROM databases d');
    expect(locks[2]).toContain('FROM database_rows');
    expect(locks[3]).toContain('FROM blocks');
    expect(locks[4]).toContain('FROM workspaces');
  });
});
