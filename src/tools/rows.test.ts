import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServer } from '../mcp.js';

const getDatabaseMock = vi.fn();
const queryRowsMock = vi.fn();

vi.mock('../db/queries/databases.js', () => ({
  getDatabase: getDatabaseMock,
}));

vi.mock('../db/queries/rows.js', () => ({
  bulkCreateRows: vi.fn(),
  cleanupExpired: vi.fn(),
  countRows: vi.fn(),
  createRow: vi.fn(),
  deleteRow: vi.fn(),
  getRow: vi.fn(),
  getRowDatabaseId: vi.fn(),
  queryRows: queryRowsMock,
  updateRow: vi.fn(),
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

  return import('./rows.js').then(({ registerRowTools }) => {
    registerRowTools(server);
    if (!definition) {
      throw new Error('Row tool was not registered');
    }
    return definition;
  });
}

describe('row tool', () => {
  beforeEach(() => {
    getDatabaseMock.mockReset().mockResolvedValue({
      id: 'db-1',
      properties: [],
    });
    queryRowsMock.mockReset();
  });

  it('omits next_cursor on the final full page', async () => {
    queryRowsMock.mockResolvedValue({
      rows: Array.from({ length: 2 }, (_, index) => ({ id: `row-${index + 1}` })),
      total: 4,
    });

    const tool = await buildTool();
    const response = await tool.execute(
      {
        action: 'query',
        database_id: '00000000-0000-0000-0000-000000000001',
        limit: 2,
        offset: 2,
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as {
      meta: { next_cursor: string | null };
    };

    expect(payload.meta.next_cursor).toBeNull();
  });

  it('returns next_cursor when more rows remain', async () => {
    queryRowsMock.mockResolvedValue({
      rows: Array.from({ length: 2 }, (_, index) => ({ id: `row-${index + 1}` })),
      total: 5,
    });

    const tool = await buildTool();
    const response = await tool.execute(
      {
        action: 'query',
        database_id: '00000000-0000-0000-0000-000000000001',
        limit: 2,
        offset: 2,
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as {
      meta: { next_cursor: string | null };
    };

    expect(payload.meta.next_cursor).toBeTruthy();
  });
});
