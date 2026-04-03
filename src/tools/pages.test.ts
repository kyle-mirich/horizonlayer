import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServer } from '../mcp.js';

const createPageMock = vi.fn();
const getPageMock = vi.fn();
const listPagesMock = vi.fn();
const updatePageMock = vi.fn();
const appendPageBlocksMock = vi.fn();
const updatePageBlockMock = vi.fn();
const deletePageBlockMock = vi.fn();
const deletePageMock = vi.fn();

vi.mock('../db/queries/pages.js', () => ({
  appendPageBlocks: appendPageBlocksMock,
  createPage: createPageMock,
  deletePage: deletePageMock,
  deletePageBlock: deletePageBlockMock,
  getPage: getPageMock,
  listPages: listPagesMock,
  updatePage: updatePageMock,
  updatePageBlock: updatePageBlockMock,
}));

function buildTool() {
  let definition:
    | {
        execute: (params: Record<string, unknown>, context: { session?: unknown }) => Promise<{ content: Array<{ text: string }> }>;
        parameters: { safeParse: (value: unknown) => { success: boolean } };
      }
    | null = null;

  const server = {
    addTool(toolDefinition: typeof definition) {
      definition = toolDefinition;
    },
  } as unknown as AppServer;

  return import('./pages.js').then(({ registerPageTools }) => {
    registerPageTools(server);
    if (!definition) {
      throw new Error('Page tool was not registered');
    }
    return definition;
  });
}

describe('page tool', () => {
  beforeEach(() => {
    createPageMock.mockReset();
    getPageMock.mockReset();
    listPagesMock.mockReset();
    updatePageMock.mockReset();
    appendPageBlocksMock.mockReset();
    updatePageBlockMock.mockReset();
    deletePageBlockMock.mockReset();
    deletePageMock.mockReset();
  });

  it('creates shorthand content pages with session scope', async () => {
    createPageMock.mockResolvedValue({ id: 'page-1', title: 'Untitled' });
    const tool = await buildTool();

    const response = await tool.execute(
      {
        action: 'create',
        content: 'hello',
        session_id: '00000000-0000-0000-0000-0000000000ad',
        workspace_id: '00000000-0000-0000-0000-000000000001',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { result: { id: string } };
    expect(createPageMock).toHaveBeenCalledWith(expect.objectContaining({
      blocks: [{ block_type: 'text', content: 'hello' }],
      session_id: '00000000-0000-0000-0000-0000000000ad',
    }));
    expect(payload.result.id).toBe('page-1');
  });

  it('appends plain text to an existing session page', async () => {
    appendPageBlocksMock.mockResolvedValue([{ id: 'block-1' }]);
    const tool = await buildTool();

    const response = await tool.execute(
      {
        action: 'append_text',
        content: 'journal entry',
        page_id: '00000000-0000-0000-0000-000000000002',
        session_id: '00000000-0000-0000-0000-0000000000ae',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { result: Array<{ id: string }> };
    expect(appendPageBlocksMock).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000002',
      [{ block_type: 'text', content: 'journal entry' }],
      expect.any(Object),
      undefined,
      '00000000-0000-0000-0000-0000000000ae'
    );
    expect(payload.result[0]?.id).toBe('block-1');
  });

  it('passes expected_updated_at through page mutations', async () => {
    updatePageMock.mockResolvedValue({ id: 'page-1', title: 'Updated' });
    const tool = await buildTool();

    await tool.execute(
      {
        action: 'update',
        id: '00000000-0000-0000-0000-000000000001',
        title: 'Updated',
        expected_updated_at: '2026-01-01T00:00:00.000Z',
      },
      { session: undefined }
    );

    expect(updatePageMock).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      expect.objectContaining({
        expected_updated_at: '2026-01-01T00:00:00.000Z',
      }),
      expect.any(Object)
    );
  });

  it('creates a journal page when append_text does not target an existing page', async () => {
    createPageMock.mockResolvedValue({ id: 'page-2', title: 'Journal' });
    const tool = await buildTool();

    const response = await tool.execute(
      {
        action: 'append_text',
        content: 'journal entry',
        session_id: '00000000-0000-0000-0000-0000000000af',
        workspace_id: '00000000-0000-0000-0000-000000000003',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { result: { id: string } };
    expect(createPageMock).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/^Journal /),
      blocks: [{ block_type: 'text', content: 'journal entry' }],
      session_id: '00000000-0000-0000-0000-0000000000af',
      workspace_id: '00000000-0000-0000-0000-000000000003',
    }));
    expect(payload.result.id).toBe('page-2');
  });

  it('rejects removed keys and requires explicit action', async () => {
    const tool = await buildTool();
    expect(tool.parameters.safeParse({}).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'list', cursor: 'abc' }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'update', expected_updated_at: '2026-01-01T00:00:00.000Z' }).success).toBe(true);
    expect(tool.parameters.safeParse({ action: 'create', dry_run: true }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'list', op: 'list' }).success).toBe(false);
  });

  it('returns an error envelope when appending to a missing page', async () => {
    appendPageBlocksMock.mockRejectedValue(new Error('Page 00000000-0000-0000-0000-000000000002 not found'));
    const tool = await buildTool();

    const response = await tool.execute(
      {
        action: 'append_text',
        content: 'journal entry',
        page_id: '00000000-0000-0000-0000-000000000002',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { error: { message: string }; ok: boolean };
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toBe('Page 00000000-0000-0000-0000-000000000002 not found');
  });
});
