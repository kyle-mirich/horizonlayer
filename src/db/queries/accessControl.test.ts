import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    query: poolQueryMock,
  }),
}));

describe('access control query guards', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
  });

  it.each([
    ['workspace', 'assertWorkspaceReadAccess', { id: 'ws-1' }, undefined],
    ['session', 'assertSessionReadAccess', { workspace_id: 'ws-1' }, { workspace_id: 'ws-1' }],
    ['page', 'assertPageReadAccess', { workspace_id: 'ws-1', parent_page_id: null, session_id: null }, { workspace_id: 'ws-1', parent_page_id: null, session_id: null }],
    ['database', 'assertDatabaseReadAccess', { workspace_id: 'ws-1', parent_page_id: null }, { workspace_id: 'ws-1', parent_page_id: null }],
    ['row', 'assertRowReadAccess', { database_id: 'db-1', workspace_id: 'ws-1' }, { database_id: 'db-1', workspace_id: 'ws-1' }],
    ['block', 'assertBlockReadAccess', { page_id: 'page-1', workspace_id: 'ws-1', session_id: null }, { page_id: 'page-1', workspace_id: 'ws-1', session_id: null }],
  ])('returns metadata for %s read checks', async (_label, fnName, row, expected) => {
    poolQueryMock.mockResolvedValueOnce({ rows: [row] });
    const accessControl = await import('./accessControl.js');
    const check = accessControl[fnName as keyof typeof accessControl] as (
      id: string,
      access: { kind: 'system' }
    ) => Promise<unknown>;

    await expect(check('item-1', { kind: 'system' })).resolves.toEqual(expected);
  });

  it.each([
    ['assertWorkspaceReadAccess', 'Workspace missing not found'],
    ['assertSessionReadAccess', 'Session missing not found'],
    ['assertPageReadAccess', 'Page missing not found'],
    ['assertDatabaseReadAccess', 'Database missing not found'],
    ['assertRowReadAccess', 'Row missing not found'],
    ['assertBlockReadAccess', 'Block missing not found'],
  ])('throws useful not-found errors from %s', async (fnName, message) => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    const accessControl = await import('./accessControl.js');
    const check = accessControl[fnName as keyof typeof accessControl] as (
      id: string,
      access: { kind: 'system' }
    ) => Promise<unknown>;

    await expect(check('missing', { kind: 'system' })).rejects.toThrow(message);
  });

  it.each([
    ['workspace', 'assertWorkspaceWriteAccess', { id: 'ws-1' }, undefined, 'SELECT id FROM workspaces WHERE id = $1'],
    ['session', 'assertSessionWriteAccess', { workspace_id: 'ws-1' }, { workspace_id: 'ws-1' }, 'SELECT workspace_id FROM sessions WHERE id = $1'],
    ['page', 'assertPageWriteAccess', { workspace_id: 'ws-1', parent_page_id: null, session_id: null }, { workspace_id: 'ws-1', parent_page_id: null, session_id: null }, 'SELECT workspace_id, parent_page_id, session_id FROM pages WHERE id = $1'],
    ['database', 'assertDatabaseWriteAccess', { workspace_id: 'ws-1', parent_page_id: null }, { workspace_id: 'ws-1', parent_page_id: null }, 'SELECT workspace_id, parent_page_id FROM databases WHERE id = $1'],
    ['row', 'assertRowWriteAccess', { database_id: 'db-1', workspace_id: 'ws-1' }, { database_id: 'db-1', workspace_id: 'ws-1' }, 'FROM database_rows r'],
    ['block', 'assertBlockWriteAccess', { page_id: 'page-1', workspace_id: 'ws-1', session_id: null }, { page_id: 'page-1', workspace_id: 'ws-1', session_id: null }, 'FROM blocks b'],
  ])('returns metadata for %s write checks', async (_label, fnName, row, expected, sqlNeedle) => {
    poolQueryMock.mockResolvedValueOnce({ rows: [row] });
    const accessControl = await import('./accessControl.js');
    const check = accessControl[fnName as keyof typeof accessControl] as (
      id: string,
      access: { kind: 'system' }
    ) => Promise<unknown>;

    await expect(check('item-1', { kind: 'system' })).resolves.toEqual(expected);
    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain(sqlNeedle);
  });

  it.each([
    ['workspace', 'SELECT id FROM workspaces WHERE id = $1'],
    ['page', 'SELECT workspace_id, parent_page_id, session_id FROM pages WHERE id = $1'],
    ['database', 'SELECT workspace_id, parent_page_id FROM databases WHERE id = $1'],
    ['row', 'FROM database_rows r'],
    ['database_row', 'FROM database_rows r'],
    ['block', 'FROM blocks b'],
  ])('dispatches linked item access checks for %s items', async (itemType, sqlNeedle) => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ id: 'ws-1', workspace_id: 'ws-1', parent_page_id: null, session_id: null, database_id: 'db-1', page_id: 'page-1' }],
    });

    const { assertLinkedItemAccess } = await import('./accessControl.js');
    await assertLinkedItemAccess(itemType, 'item-1', { kind: 'system' }, 'read');

    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain(sqlNeedle);
  });

  it('rejects unsupported linked item types', async () => {
    const { assertLinkedItemAccess } = await import('./accessControl.js');
    await expect(assertLinkedItemAccess('unknown', 'item-1', { kind: 'system' }, 'read')).rejects.toThrow(
      'Unsupported linked item type: unknown'
    );
  });

  it('checks both endpoints before allowing link access', async () => {
    poolQueryMock
      .mockResolvedValueOnce({
        rows: [{ from_type: 'workspace', from_id: 'ws-1', to_type: 'page', to_id: 'page-1' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'ws-1' }] })
      .mockResolvedValueOnce({ rows: [{ workspace_id: 'ws-1', parent_page_id: null, session_id: null }] });

    const { assertLinkAccess } = await import('./accessControl.js');
    await assertLinkAccess('link-1', { kind: 'system' }, 'read');

    expect(poolQueryMock).toHaveBeenCalledTimes(3);
  });

  it('uses write-mode endpoint checks before allowing link writes', async () => {
    poolQueryMock
      .mockResolvedValueOnce({
        rows: [{ from_type: 'database_row', from_id: 'row-1', to_type: 'block', to_id: 'block-1' }],
      })
      .mockResolvedValueOnce({ rows: [{ database_id: 'db-1', workspace_id: 'ws-1' }] })
      .mockResolvedValueOnce({ rows: [{ page_id: 'page-1', workspace_id: 'ws-1', session_id: 'session-1' }] });

    const { assertLinkAccess } = await import('./accessControl.js');
    await assertLinkAccess('link-1', { kind: 'system' }, 'write');

    expect(String(poolQueryMock.mock.calls[1]?.[0])).toContain('FROM database_rows r');
    expect(String(poolQueryMock.mock.calls[2]?.[0])).toContain('FROM blocks b');
  });

  it('does not check the second link endpoint when the first endpoint is missing', async () => {
    poolQueryMock
      .mockResolvedValueOnce({
        rows: [{ from_type: 'workspace', from_id: 'missing-ws', to_type: 'page', to_id: 'page-1' }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const { assertLinkAccess } = await import('./accessControl.js');
    await expect(assertLinkAccess('link-1', { kind: 'system' }, 'write')).rejects.toThrow(
      'Workspace missing-ws not found'
    );

    expect(poolQueryMock).toHaveBeenCalledTimes(2);
  });

  it('throws when a link does not exist', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });

    const { assertLinkAccess } = await import('./accessControl.js');
    await expect(assertLinkAccess('missing', { kind: 'system' }, 'write')).rejects.toThrow('Link missing not found');
  });
});
