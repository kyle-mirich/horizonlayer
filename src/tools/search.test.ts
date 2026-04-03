import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServer } from '../mcp.js';

const searchMock = vi.fn();

vi.mock('../db/queries/search.js', () => ({
  search: searchMock,
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

  return import('./search.js').then(({ registerSearchTools }) => {
    registerSearchTools(server);
    if (!definition) {
      throw new Error('Search tool was not registered');
    }
    return definition;
  });
}

describe('search tool', () => {
  beforeEach(() => {
    searchMock.mockReset();
  });

  it('uses offset pagination and defaults mode to hybrid', async () => {
    searchMock.mockImplementation(async ({ limit }: { limit: number }) =>
      Array.from({ length: limit }, (_, index) => ({
        id: `${index}`,
        score: limit - index,
        snippet: `Result ${index}`,
        tags: [],
        title: `Result ${index}`,
        type: 'page' as const,
        workspace_id: null,
      }))
    );

    const tool = await buildTool();
    const response = await tool.execute(
      {
        limit: 20,
        offset: 100,
        query: 'search term',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as {
      meta: { offset: number };
      result: Array<{ id: string }>;
    };

    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 120, mode: 'hybrid' }));
    expect(payload.meta.offset).toBe(100);
    expect(payload.result).toHaveLength(20);
    expect(payload.result[0]?.id).toBe('100');
  });

  it('forces row search when database_id is provided', async () => {
    searchMock.mockResolvedValue([]);
    const tool = await buildTool();

    await tool.execute(
      {
        database_id: '00000000-0000-0000-0000-000000000001',
        query: 'search term',
        type: 'page',
      },
      { session: undefined }
    );

    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({
      content_types: ['rows'],
      database_id: '00000000-0000-0000-0000-000000000001',
    }));
  });

  it('rejects removed pagination and projection keys', async () => {
    const tool = await buildTool();
    expect(tool.parameters.safeParse({ cursor: 'abc', query: 'term' }).success).toBe(false);
    expect(tool.parameters.safeParse({ fields: ['id'], query: 'term' }).success).toBe(false);
    expect(tool.parameters.safeParse({ query: 'term', return: 'full' }).success).toBe(false);
  });
});
