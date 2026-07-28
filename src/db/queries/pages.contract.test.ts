import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const clientQueryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn();
const appendBlocksMock = vi.fn();
const archiveBlockMock = vi.fn();
const getBlocksForPageMock = vi.fn();
const restoreBlockMock = vi.fn();
const updateBlockMock = vi.fn();
const touchSessionMock = vi.fn();
const requireBlockMock = vi.fn();
const requirePageMock = vi.fn();
const requireSessionMock = vi.fn();
const requireActiveSessionMock = vi.fn();
const lockActiveSessionForChildWriteMock = vi.fn();
const requireActivePageMock = vi.fn();
const lockActivePageForChildWriteMock = vi.fn();
const requireActiveWorkspaceMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    connect: connectMock,
    query: poolQueryMock,
  }),
}));

vi.mock('./blocks.js', () => ({
  appendBlocks: appendBlocksMock,
  archiveBlock: archiveBlockMock,
  getBlocksForPage: getBlocksForPageMock,
  restoreBlock: restoreBlockMock,
  updateBlock: updateBlockMock,
}));

vi.mock('./sessions.js', () => ({
  touchSession: touchSessionMock,
}));

vi.mock('./scopeGuards.js', () => ({
  lockActivePageForChildWrite: lockActivePageForChildWriteMock,
  lockActiveSessionForChildWrite: lockActiveSessionForChildWriteMock,
  requireActivePage: requireActivePageMock,
  requireActiveSession: requireActiveSessionMock,
  requireActiveWorkspace: requireActiveWorkspaceMock,
  requireBlock: requireBlockMock,
  requirePage: requirePageMock,
  requireSession: requireSessionMock,
}));

function page(overrides: Record<string, unknown> = {}) {
  return {
    id: 'page-1',
    workspace_id: 'ws-1',
    session_id: 'session-1',
    parent_page_id: null,
    title: 'Page',
    tags: [],
    importance: 0.5,
    revision: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function block(overrides: Record<string, unknown> = {}) {
  return {
    id: 'block-1',
    page_id: 'page-1',
    block_type: 'text',
    content: 'Body',
    position: 0,
    metadata: {},
    revision: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('page persistence contract', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockReset();
    appendBlocksMock.mockReset();
    archiveBlockMock.mockReset();
    getBlocksForPageMock.mockReset();
    restoreBlockMock.mockReset();
    updateBlockMock.mockReset();
    touchSessionMock.mockReset();
    requireBlockMock.mockReset();
    requirePageMock.mockReset();
    requireSessionMock.mockReset();
    requireActiveSessionMock.mockReset();
    lockActiveSessionForChildWriteMock.mockReset();
    requireActivePageMock.mockReset();
    lockActivePageForChildWriteMock.mockReset();
    requireActiveWorkspaceMock.mockReset();

    connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    appendBlocksMock.mockResolvedValue([block()]);
    archiveBlockMock.mockResolvedValue(block({ revision: 2, archived_at: '2026-01-02T00:00:00.000Z' }));
    getBlocksForPageMock.mockResolvedValue([block()]);
    restoreBlockMock.mockResolvedValue(block({ revision: 3, archived_at: null }));
    updateBlockMock.mockResolvedValue(block({ content: 'Updated', revision: 2 }));
    touchSessionMock.mockResolvedValue(undefined);
    requireBlockMock.mockResolvedValue({
      page_id: 'page-1',
      workspace_id: 'ws-1',
      session_id: 'session-1',
    });
    requirePageMock.mockResolvedValue({
      workspace_id: 'ws-1',
      parent_page_id: null,
      session_id: 'session-1',
    });
    requireSessionMock.mockResolvedValue({ workspace_id: 'ws-1' });
    requireActiveSessionMock.mockResolvedValue({ workspace_id: 'ws-1' });
    lockActiveSessionForChildWriteMock.mockResolvedValue({ workspace_id: 'ws-1' });
    requireActivePageMock.mockResolvedValue({
      workspace_id: 'ws-1',
      parent_page_id: null,
      session_id: 'session-1',
    });
    lockActivePageForChildWriteMock.mockResolvedValue({
      workspace_id: 'ws-1',
      parent_page_id: null,
      session_id: 'session-1',
    });
    requireActiveWorkspaceMock.mockResolvedValue(undefined);
  });

  it('creates a workspace-scoped page with initial blocks and session touch in one transaction', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('INSERT INTO pages')) return { rows: [page()] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { createPage } = await import('./pages.js');
    const created = await createPage({
      title: 'Page',
      parent_page_id: 'parent-1',
      blocks: [{ block_type: 'text', content: 'Body' }],
    });

    expect(created).toMatchObject({ revision: 1, blocks: [{ id: 'block-1' }] });
    expect(requireActivePageMock).toHaveBeenCalledWith('parent-1');
    expect(lockActivePageForChildWriteMock).toHaveBeenCalledWith(
      'parent-1',
      expect.objectContaining({ query: clientQueryMock })
    );
    expect(requireActiveSessionMock).toHaveBeenCalledWith('session-1');
    expect(lockActiveSessionForChildWriteMock).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ query: clientQueryMock })
    );
    expect(lockActivePageForChildWriteMock.mock.invocationCallOrder[0]).toBeLessThan(
      lockActiveSessionForChildWriteMock.mock.invocationCallOrder[0]
    );
    const insertIndex = clientQueryMock.mock.calls.findIndex(([sql]) =>
      String(sql).includes('INSERT INTO pages')
    );
    expect(lockActiveSessionForChildWriteMock.mock.invocationCallOrder[0]).toBeLessThan(
      clientQueryMock.mock.invocationCallOrder[insertIndex]
    );
    expect(requireActivePageMock.mock.invocationCallOrder[0]).toBeLessThan(
      connectMock.mock.invocationCallOrder[0]
    );
    expect(appendBlocksMock).toHaveBeenCalledWith(
      'page-1',
      [{ block_type: 'text', content: 'Body' }],
      expect.any(Object)
    );
    expect(touchSessionMock).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(clientQueryMock.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('COMMIT');

    const insertSql = String(clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO pages'))?.[0]);
    expect(insertSql).toContain('RETURNING');
    expect(insertSql).not.toContain('RETURNING *');
    expect(insertSql).toContain('workspace_id');
    expect(insertSql).toContain('importance');
  });

  it('finishes ownership validation before checking out a client', async () => {
    requireActivePageMock.mockResolvedValueOnce({
      workspace_id: null,
      parent_page_id: null,
      session_id: null,
    });
    const { createPage } = await import('./pages.js');

    await expect(createPage({ title: 'Page', parent_page_id: 'parent-1' })).rejects.toThrow(
      'Parent page parent-1 is not associated with a workspace'
    );
    await expect(createPage({ title: 'Page' })).rejects.toThrow(
      'workspace_id is required for page creation'
    );

    requireActiveSessionMock.mockResolvedValueOnce({ workspace_id: 'ws-2' });
    await expect(createPage({
      title: 'Page',
      workspace_id: 'ws-1',
      session_id: 'session-1',
    })).rejects.toThrow('session_id must belong to the target workspace');

    requireActiveSessionMock.mockRejectedValueOnce(
      new Error('Session session-closed is closed and cannot be modified')
    );
    await expect(createPage({
      title: 'Page',
      workspace_id: 'ws-1',
      session_id: 'session-closed',
    })).rejects.toThrow('Session session-closed is closed and cannot be modified');

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('uses a plain explicit SELECT for reads and hides archived pages by default', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [page()] });

    const { getPage } = await import('./pages.js');
    await expect(getPage('page-1', { session_id: 'session-1' })).resolves.toMatchObject({
      id: 'page-1',
      blocks: [{ id: 'block-1' }],
      blocks_page: { has_more: false, limit: 50, next_offset: null, offset: 0 },
    });

    const [sql, values] = poolQueryMock.mock.calls[0];
    expect(String(sql).trimStart()).toMatch(/^SELECT/);
    expect(sql).toContain('($2::boolean OR archived_at IS NULL)');
    expect(sql).toContain('session_id = $3');
    expect(sql).not.toContain('SELECT *');
    expect(sql).not.toContain('UPDATE pages');
    expect(values).toEqual(['page-1', false, 'session-1']);
    expect(requirePageMock).toHaveBeenCalledWith('page-1');
    expect(requireSessionMock).toHaveBeenCalledWith('session-1');
    expect(getBlocksForPageMock).toHaveBeenCalledWith('page-1', {
      include_archived: undefined,
      limit: 51,
      offset: 0,
    });
  });

  it('allows archived pages to be fetched only when explicitly requested', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [page({ revision: 2, archived_at: '2026-01-02T00:00:00.000Z' })],
    });

    const { getPage } = await import('./pages.js');
    await expect(getPage('page-1', { include_archived: true })).resolves.toMatchObject({
      archived_at: '2026-01-02T00:00:00.000Z',
    });
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual(['page-1', true]);
    expect(getBlocksForPageMock).toHaveBeenCalledWith('page-1', expect.objectContaining({
      include_archived: true,
    }));
  });

  it('returns honest bounded block pagination and validates page block bounds', async () => {
    poolQueryMock.mockResolvedValue({ rows: [page()] });
    getBlocksForPageMock.mockResolvedValueOnce([
      block({ id: 'block-1', position: 0 }),
      block({ id: 'block-2', position: 1 }),
      block({ id: 'block-3', position: 2 }),
    ]);
    const { getPage } = await import('./pages.js');

    await expect(getPage('page-1', { block_limit: 2, block_offset: 4 })).resolves.toMatchObject({
      blocks: [{ id: 'block-1' }, { id: 'block-2' }],
      blocks_page: { has_more: true, limit: 2, next_offset: 6, offset: 4 },
    });
    expect(getBlocksForPageMock).toHaveBeenCalledWith('page-1', expect.objectContaining({
      limit: 3,
      offset: 4,
    }));

    poolQueryMock.mockClear();
    await expect(getPage('page-1', { block_limit: 101 })).rejects.toThrow(
      'block_limit must be an integer between 1 and 100'
    );
    await expect(getPage('page-1', { block_offset: -1 })).rejects.toThrow(
      'block_offset must be an integer between 0 and 1000000'
    );
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('requires a revision and increments it atomically for page updates', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [page({ title: 'Updated', revision: 4 })] });

    const { updatePage } = await import('./pages.js');
    await expect(updatePage('page-1', {
      revision: 3,
      title: 'Updated',
      tags: ['durable'],
    })).resolves.toMatchObject({ title: 'Updated', revision: 4 });

    const [sql, values] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('revision = revision + 1');
    expect(sql).toContain('AND revision = $4');
    expect(sql).toContain('AND archived_at IS NULL');
    expect(sql).not.toContain('RETURNING *');
    expect(sql).toContain('SET title = $1, tags = $2');
    expect(values).toEqual(['Updated', ['durable'], 'page-1', 3]);
    expect(requirePageMock).toHaveBeenCalledWith('page-1');
  });

  it('distinguishes stale page revisions from missing pages', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ revision: 7 }] });

    const { updatePage } = await import('./pages.js');
    await expect(updatePage('page-1', { revision: 6, tags: ['stale'] })).rejects.toThrow(
      'Conflict: page page-1 is at revision 7, not 6'
    );

    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(updatePage('missing', { revision: 1, tags: ['lost'] })).resolves.toBeNull();
  });

  it('lists only within a validated workspace with bounded parameterized pagination', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [page()] });

    const { listPages } = await import('./pages.js');
    await expect(listPages({
      workspace_id: 'ws-1',
      session_id: 'session-1',
      parent_page_id: 'parent-1',
      tags: ['durable'],
      min_importance: 0.6,
      limit: 5,
      offset: 2,
    })).resolves.toHaveLength(1);

    expect(requireActiveWorkspaceMock).toHaveBeenCalledWith('ws-1');
    expect(requirePageMock).toHaveBeenCalledWith('parent-1');
    const [sql, values] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('workspace_id = $1');
    expect(sql).toContain('archived_at IS NULL');
    expect(sql).toContain('LIMIT $6 OFFSET $7');
    expect(sql).not.toContain('SELECT *');
    expect(values).toEqual(['ws-1', 'session-1', 'parent-1', ['durable'], 0.6, 5, 2]);

    poolQueryMock.mockClear();
    await expect(listPages({ workspace_id: 'ws-1', limit: 102 })).rejects.toThrow(
      'limit must be an integer between 0 and 101'
    );
    expect(poolQueryMock).not.toHaveBeenCalled();
    await expect(listPages({ workspace_id: '' })).rejects.toThrow(
      'workspace_id is required for page listing'
    );
  });

  it('rejects cross-workspace session and parent filters before querying pages', async () => {
    const { listPages } = await import('./pages.js');
    requireSessionMock.mockResolvedValueOnce({ workspace_id: 'ws-2' });
    await expect(listPages({ workspace_id: 'ws-1', session_id: 'session-1' })).rejects.toThrow(
      'session_id must belong to the requested workspace'
    );

    requirePageMock.mockResolvedValueOnce({ workspace_id: 'ws-2' });
    await expect(listPages({ workspace_id: 'ws-1', parent_page_id: 'page-2' })).rejects.toThrow(
      'parent_page_id must belong to the requested workspace'
    );
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('appends blocks against a checked page revision in one transaction', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ session_id: 'session-1', revision: 3 }] });
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('UPDATE pages')) return { rows: [{ revision: 4 }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { appendPageBlocks } = await import('./pages.js');
    await expect(appendPageBlocks(
      'page-1',
      [{ block_type: 'text', content: 'More' }],
      { revision: 3, session_id: 'session-1' }
    )).resolves.toEqual({ blocks: [block()], page_revision: 4 });

    expect(requirePageMock).toHaveBeenCalledWith('page-1');
    expect(requireActiveSessionMock).toHaveBeenCalledWith('session-1');
    const pageUpdate = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE pages'));
    expect(String(pageUpdate?.[0])).toContain('revision = revision + 1');
    expect(pageUpdate?.[1]).toEqual(['page-1', 3]);
    expect(appendBlocksMock).toHaveBeenCalledWith(
      'page-1',
      [{ block_type: 'text', content: 'More' }],
      expect.any(Object)
    );
    expect(touchSessionMock).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('rejects stale or cross-session appends before checking out a client', async () => {
    const { appendPageBlocks } = await import('./pages.js');
    poolQueryMock.mockResolvedValueOnce({ rows: [{ session_id: 'session-1', revision: 2 }] });
    await expect(appendPageBlocks(
      'page-1',
      [{ block_type: 'text' }],
      { revision: 1 }
    )).rejects.toThrow('Conflict: page page-1 is at revision 2, not 1');

    poolQueryMock.mockResolvedValueOnce({ rows: [{ session_id: 'session-2', revision: 2 }] });
    await expect(appendPageBlocks(
      'page-1',
      [{ block_type: 'text' }],
      { revision: 2, session_id: 'session-1' }
    )).rejects.toThrow('Page page-1 is not associated with session session-1');

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('updates, archives, and restores blocks while touching their parent page and session', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ page_id: 'page-1', session_id: 'session-1' }] });
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('UPDATE pages')) return { rows: [{ revision: 2 }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { archivePageBlock, restorePageBlock, updatePageBlock } = await import('./pages.js');
    await expect(updatePageBlock('block-1', { revision: 1, content: 'Updated' })).resolves.toMatchObject({
      block: { revision: 2 },
      page_revision: 2,
    });
    await expect(archivePageBlock('block-1', 1)).resolves.toMatchObject({
      block: { archived_at: expect.any(String) },
      page_revision: 2,
    });
    await expect(restorePageBlock('block-1', 2)).resolves.toMatchObject({
      block: { archived_at: null },
      page_revision: 2,
    });

    expect(updateBlockMock).toHaveBeenCalledWith(
      'block-1',
      { revision: 1, content: 'Updated' },
      expect.any(Object)
    );
    expect(archiveBlockMock).toHaveBeenCalledWith('block-1', 1, expect.any(Object));
    expect(restoreBlockMock).toHaveBeenCalledWith('block-1', 2, expect.any(Object));
    expect(requireBlockMock).toHaveBeenCalledTimes(3);
    expect(requireBlockMock).toHaveBeenCalledWith('block-1');
    expect(touchSessionMock).toHaveBeenCalledTimes(3);
    expect(clientQueryMock.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(3);
  });

  it('archives and restores pages as revision-checked entities with no public hard delete', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [page({ revision: 2, archived_at: '2026-01-02T00:00:00.000Z' })] })
      .mockResolvedValueOnce({ rows: [page({ revision: 3, archived_at: null })] });

    const pageQueries = await import('./pages.js');
    await expect(pageQueries.archivePage('page-1', 1)).resolves.toMatchObject({ revision: 2 });
    await expect(pageQueries.restorePage('page-1', 2)).resolves.toMatchObject({ revision: 3 });

    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('archived_at = NOW()');
    expect(String(poolQueryMock.mock.calls[1]?.[0])).toContain('archived_at = NULL');
    expect(requirePageMock).toHaveBeenCalledTimes(2);
    expect(requirePageMock).toHaveBeenCalledWith('page-1');
    expect(pageQueries).not.toHaveProperty('deletePage');
    expect(pageQueries).not.toHaveProperty('deletePageBlock');
  });
});
