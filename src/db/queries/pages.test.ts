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
const requirePageMock = vi.fn();
const requireSessionMock = vi.fn();
const requireActiveSessionMock = vi.fn();
const lockActiveSessionForChildWriteMock = vi.fn();
const requireActivePageMock = vi.fn();
const lockActivePageForChildWriteMock = vi.fn();
const requireActiveWorkspaceMock = vi.fn();
const requireBlockMock = vi.fn();

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
    session_id: null,
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

describe('page persistence concurrency', () => {
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
    requirePageMock.mockReset();
    requireSessionMock.mockReset();
    requireActiveSessionMock.mockReset();
    lockActiveSessionForChildWriteMock.mockReset();
    requireActivePageMock.mockReset();
    lockActivePageForChildWriteMock.mockReset();
    requireActiveWorkspaceMock.mockReset();
    requireBlockMock.mockReset();

    connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    getBlocksForPageMock.mockResolvedValue([]);
    touchSessionMock.mockResolvedValue(undefined);
    requireActiveWorkspaceMock.mockResolvedValue(undefined);
    requireSessionMock.mockResolvedValue({ workspace_id: 'ws-1' });
    requireActiveSessionMock.mockResolvedValue({ workspace_id: 'ws-1' });
    lockActiveSessionForChildWriteMock.mockResolvedValue({ workspace_id: 'ws-1' });
    requireActivePageMock.mockResolvedValue({ workspace_id: 'ws-1', session_id: null });
    lockActivePageForChildWriteMock.mockResolvedValue({ workspace_id: 'ws-1', session_id: null });
    requirePageMock.mockResolvedValue({ workspace_id: 'ws-1', session_id: null });
    requireBlockMock.mockResolvedValue({ page_id: 'page-1', workspace_id: 'ws-1', session_id: null });
  });

  it('detects a revision race between append validation and the transaction', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ session_id: null, revision: 1 }] });
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('UPDATE pages')) return { rows: [] };
      if (sql === 'SELECT revision FROM pages WHERE id = $1') return { rows: [{ revision: 2 }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { appendPageBlocks } = await import('./pages.js');
    await expect(appendPageBlocks(
      'page-1',
      [{ block_type: 'text', content: 'Body' }],
      { revision: 1 }
    )).rejects.toThrow('Conflict: page page-1 is at revision 2, not 1');

    expect(appendBlocksMock).not.toHaveBeenCalled();
    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('reports stale and already-restored page archive transitions as conflicts', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ revision: 3 }] });

    const { archivePage, restorePage } = await import('./pages.js');
    await expect(archivePage('page-1', 2)).rejects.toThrow(
      'Conflict: page page-1 is at revision 3, not 2'
    );

    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ revision: 3, archived_at: null }] });
    await expect(restorePage('page-1', 3)).rejects.toThrow(
      'page page-1 is already restored'
    );
  });

  it('rolls back the parent page revision when a block update is stale', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ page_id: 'page-1', session_id: null }] });
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('UPDATE pages')) return { rows: [{ id: 'page-1' }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    updateBlockMock.mockRejectedValueOnce(
      new Error('Conflict: block block-1 is at revision 2, not 1')
    );

    const { updatePageBlock } = await import('./pages.js');
    await expect(updatePageBlock('block-1', { revision: 1, content: 'Stale' })).rejects.toThrow(
      'Conflict: block block-1 is at revision 2, not 1'
    );

    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(touchSessionMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back when a block disappears after mutation context is loaded', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ page_id: 'page-1', session_id: null }] });
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('UPDATE pages')) return { rows: [{ id: 'page-1' }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    archiveBlockMock.mockResolvedValueOnce(null);

    const { archivePageBlock } = await import('./pages.js');
    await expect(archivePageBlock('block-1', 1)).resolves.toBeNull();

    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(touchSessionMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('returns null without opening a transaction when the block context is missing', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });

    const { restorePageBlock } = await import('./pages.js');
    await expect(restorePageBlock('missing', 1)).resolves.toBeNull();

    expect(connectMock).not.toHaveBeenCalled();
    expect(restoreBlockMock).not.toHaveBeenCalled();
  });

  it('rolls back page creation if an initial block insert fails', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('INSERT INTO pages')) return { rows: [page()] };
      if (sql === 'COMMIT') throw new Error('creation must not commit');
      throw new Error(`Unexpected query: ${sql}`);
    });
    appendBlocksMock.mockRejectedValueOnce(new Error('block insert failed'));

    const { createPage } = await import('./pages.js');
    await expect(createPage({
      title: 'Page',
      workspace_id: 'ws-1',
      blocks: [{ block_type: 'text', content: 'Body' }],
    })).rejects.toThrow('block insert failed');

    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(touchSessionMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid mutation inputs before opening transactions', async () => {
    const { appendPageBlocks, archivePage, updatePage, updatePageBlock } = await import('./pages.js');
    await expect(updatePage('page-1', { revision: 1 })).rejects.toThrow(
      'At least one page field is required'
    );
    await expect(updatePageBlock('block-1', { revision: 1 })).rejects.toThrow(
      'At least one block field is required'
    );
    await expect(archivePage('page-1', 0)).rejects.toThrow('revision must be a positive integer');
    await expect(appendPageBlocks('page-1', [], { revision: 1 })).rejects.toThrow(
      'At least one block is required'
    );
    expect(poolQueryMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
  });
});
