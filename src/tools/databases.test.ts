import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServer } from '../mcp.js';

const createDatabaseMock = vi.fn();

vi.mock('../db/queries/databases.js', () => ({
  addDatabaseProperty: vi.fn(),
  createDatabase: createDatabaseMock,
  deleteDatabase: vi.fn(),
  getDatabase: vi.fn(),
  listDatabases: vi.fn(),
  updateDatabase: vi.fn(),
}));

function buildTool() {
  let definition:
    | {
        execute: (params: Record<string, unknown>, context: { session?: unknown }) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
      }
    | null = null;

  const server = {
    addTool(toolDefinition: typeof definition) {
      definition = toolDefinition;
    },
  } as unknown as AppServer;

  return import('./databases.js').then(({ registerDatabaseTools }) => {
    registerDatabaseTools(server);
    if (!definition) {
      throw new Error('Database tool was not registered');
    }
    return definition;
  });
}

describe('database tool', () => {
  beforeEach(() => {
    createDatabaseMock.mockReset();
  });

  it('returns an error envelope when database queries throw', async () => {
    createDatabaseMock.mockRejectedValue(new Error('duplicate property name'));
    const tool = await buildTool();

    const response = await tool.execute(
      {
        action: 'create',
        name: 'Projects',
        properties: [{ name: 'Title', type: 'title' }],
      },
      { session: undefined }
    );
    const payload = JSON.parse(response.content[0].text) as { ok: boolean; error: { message: string } };

    expect(response.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toBe('duplicate property name');
  });
});
