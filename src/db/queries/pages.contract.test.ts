import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const clientQueryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn();
const appendBlocksMock = vi.fn();
const deleteBlockMock = vi.fn();
const getBlocksForPageMock = vi.fn();
const getBlocksTextMock = vi.fn();
const updateBlockMock = vi.fn();
const embedMock = vi.fn();
const vectorToSqlMock = vi.fn();
const touchSessionMock = vi.fn();
const assertBlockWriteAccessMock = vi.fn();
const assertPageReadAccessMock = vi.fn();
const assertPageWriteAccessMock = vi.fn();
const assertSessionReadAccessMock = vi.fn();
const assertSessionWriteAccessMock = vi.fn();
const assertWorkspaceWriteAccessMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    connect: connectMock,
    query: poolQueryMock,
  }),
}));

vi.mock('./blocks.js', () => ({
  appendBlocks: appendBlocksMock,
  deleteBlock: deleteBlockMock,
  getBlocksForPage: getBlocksForPageMock,
  getBlocksText: getBlocksTextMock,
  updateBlock: updateBlockMock,
}));

vi.mock('../../embeddings/index.js', () => ({
  embed: embedMock,
  vectorToSql: vectorToSqlMock,
}));

vi.mock('./sessions.js', () => ({
  touchSession: touchSessionMock,
}));

vi.mock('./accessControl.js', () => ({
  assertBlockWriteAccess: assertBlockWriteAccessMock,
  assertPageReadAccess: assertPageReadAccessMock,
  assertPageWriteAccess: assertPageWriteAccessMock,
  assertSessionReadAccess: assertSessionReadAccessMock,
  assertSessionWriteAccess: assertSessionWriteAccessMock,
  assertWorkspaceWriteAccess: assertWorkspaceWriteAccessMock,
}));

function page(overrides: Record<string, unknown> = {}) {
  return {
    id: 'page-1',
    workspace_id: 'ws-1',
    session_id: 'session-1',
    parent_page_id: null,
    title: 'Page',
    icon: null,
    cover_url: null,
    tags: [],
    source: null,
    importance: 0.5,
    expires_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_accessed_at: '2026-01-01T00:00:00.000Z',
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('page query contracts', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockReset();
    appendBlocksMock.mockReset();
    deleteBlockMock.mockReset();
    getBlocksForPageMock.mockReset();
    getBlocksTextMock.mockReset();
    updateBlockMock.mockReset();
    embedMock.mockReset();
    vectorToSqlMock.mockReset();
    touchSessionMock.mockReset();
    assertBlockWriteAccessMock.mockReset();
    assertPageReadAccessMock.mockReset();
    assertPageWriteAccessMock.mockReset();
    assertSessionReadAccessMock.mockReset();
    assertSessionWriteAccessMock.mockReset();
    assertWorkspaceWriteAccessMock.mockReset();
    connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    appendBlocksMock.mockResolvedValue([block()]);
    deleteBlockMock.mockResolvedValue({ page_id: 'page-1' });
    getBlocksForPageMock.mockResolvedValue([block()]);
    getBlocksTextMock.mockReturnValue('Body');
    updateBlockMock.mockResolvedValue(block({ content: 'Updated' }));
    embedMock.mockResolvedValue([0.1, 0.2]);
    vectorToSqlMock.mockReturnValue('[0.1,0.2]');
    assertBlockWriteAccessMock.mockResolvedValue({ page_id: 'page-1', session_id: 'session-1' });
    assertPageReadAccessMock.mockResolvedValue({ workspace_id: 'ws-1', parent_page_id: null, session_id: 'session-1' });
    assertPageWriteAccessMock.mockResolvedValue({ workspace_id: 'ws-1', parent_page_id: null, session_id: 'session-1' });
    assertSessionReadAccessMock.mockResolvedValue({ workspace_id: 'ws-1' });
    assertSessionWriteAccessMock.mockResolvedValue({ workspace_id: 'ws-1' });
    assertWorkspaceWriteAccessMock.mockResolvedValue(undefined);
  });

  it('creates pages with parent/session inheritance, blocks, session touch, and embedding update', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [page()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    poolQueryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const { createPage } = await import('./pages.js');
    const created = await createPage({
      title: 'Page',
      parent_page_id: 'parent-1',
      blocks: [{ block_type: 'text', content: 'Body' }],
      expires_in_days: 1,
    });

    expect(created.blocks).toHaveLength(1);
    expect(assertPageWriteAccessMock).toHaveBeenCalledWith('parent-1', { kind: 'system' });
    expect(appendBlocksMock).toHaveBeenCalledWith('page-1', [{ block_type: 'text', content: 'Body' }], expect.any(Object));
    expect(touchSessionMock).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(embedMock).toHaveBeenCalledWith('Page\nBody');
  });

  it('rejects invalid parent and session workspace combinations before inserting', async () => {
    assertPageWriteAccessMock.mockResolvedValueOnce({ workspace_id: null, session_id: null });
    const { createPage } = await import('./pages.js');

    await expect(createPage({ title: 'Page', parent_page_id: 'parent-1' })).rejects.toThrow(
      'Parent page parent-1 is not associated with a workspace'
    );

    assertPageWriteAccessMock.mockResolvedValueOnce({ workspace_id: 'ws-1', session_id: 'session-2' });
    await expect(createPage({
      title: 'Page',
      parent_page_id: 'parent-1',
      workspace_id: 'ws-2',
    })).rejects.toThrow('workspace_id must match the parent page workspace');

    assertSessionWriteAccessMock.mockResolvedValueOnce({ workspace_id: 'ws-2' });
    await expect(createPage({
      title: 'Page',
      workspace_id: 'ws-1',
      session_id: 'session-1',
    })).rejects.toThrow('session_id must belong to the target workspace');
  });

  it('gets, lists, updates, and deletes pages with access checks and filters', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [page()] })
      .mockResolvedValueOnce({ rows: [page({ title: 'Updated' })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [page(), page({ id: 'page-2' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const { deletePage, getPage, listPages, updatePage } = await import('./pages.js');
    await expect(getPage('page-1', { kind: 'user', workspaceIds: ['ws-1'] } as never, 'session-1')).resolves.toMatchObject({
      id: 'page-1',
      blocks: [{ id: 'block-1' }],
    });
    await expect(updatePage('page-1', { title: 'Updated', icon: 'icon', cover_url: 'https://example.com', tags: ['tag'], importance: 0.9 })).resolves.toMatchObject({
      title: 'Updated',
    });
    await expect(listPages({
      workspace_id: 'ws-1',
      session_id: 'session-1',
      parent_page_id: 'parent-1',
      tags: ['tag'],
      min_importance: 0.5,
      limit: 5,
      offset: 2,
    })).resolves.toHaveLength(2);
    await expect(deletePage('page-1', { kind: 'system' }, '2026-01-01T00:00:00.000Z')).resolves.toBe(true);
  });

  it('appends, updates, and deletes page blocks transactionally', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ session_id: 'session-1' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ page_id: 'page-1', session_id: 'session-1' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ page_id: 'page-1', session_id: 'session-1' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ title: 'Page' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ title: 'Page' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ title: 'Page' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { appendPageBlocks, deletePageBlock, updatePageBlock } = await import('./pages.js');

    await expect(appendPageBlocks('page-1', [{ block_type: 'text', content: 'More' }], { kind: 'system' }, undefined, 'session-1')).resolves.toHaveLength(1);
    await expect(updatePageBlock('block-1', { content: 'Updated' })).resolves.toMatchObject({ content: 'Updated' });
    await expect(deletePageBlock('block-1')).resolves.toBe(true);

    expect(clientQueryMock.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(3);
  });

  it('returns not-found results and detects stale block mutations', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ page_id: 'page-1', session_id: 'session-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { appendPageBlocks, updatePageBlock, deletePageBlock } = await import('./pages.js');

    await expect(appendPageBlocks('missing', [{ block_type: 'text' }])).rejects.toThrow('Page missing not found');
    await expect(updatePageBlock('missing', {})).resolves.toBeNull();
    await expect(deletePageBlock('block-1', { kind: 'system' }, '2026-01-01T00:00:00.000Z')).resolves.toBe(false);
  });
});
