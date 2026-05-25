import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServer } from '../mcp.js';

const listLinksMock = vi.fn();

vi.mock('../db/queries/links.js', () => ({
  createLink: vi.fn(),
  deleteLink: vi.fn(),
  listLinks: listLinksMock,
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

  return import('./links.js').then(({ registerLinkTools }) => {
    registerLinkTools(server);
    if (!definition) {
      throw new Error('Link tool was not registered');
    }
    return definition;
  });
}

describe('link tool', () => {
  beforeEach(() => {
    listLinksMock.mockReset();
  });

  it('returns an error envelope when link queries throw', async () => {
    listLinksMock.mockRejectedValue(new Error('link query failed'));
    const tool = await buildTool();

    const response = await tool.execute(
      {
        action: 'list',
        item_id: '00000000-0000-0000-0000-000000000001',
        item_type: 'page',
      },
      { session: undefined }
    );
    const payload = JSON.parse(response.content[0].text) as { ok: boolean; error: { message: string } };

    expect(response.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toBe('link query failed');
  });
});
