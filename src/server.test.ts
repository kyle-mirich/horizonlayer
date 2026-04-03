import { beforeEach, describe, expect, it, vi } from 'vitest';

const fastMcpInstances: Array<{ options: Record<string, unknown> }> = [];
const registerWorkspaceTools = vi.fn();
const registerPageTools = vi.fn();
const registerDatabaseTools = vi.fn();
const registerRowTools = vi.fn();
const registerSearchTools = vi.fn();
const registerLinkTools = vi.fn();
const registerTaskTools = vi.fn();
const registerRunTools = vi.fn();

vi.mock('fastmcp', () => ({
  FastMCP: class FastMCP {
    public options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      fastMcpInstances.push({ options });
    }

    addTool() {}
  },
}));

vi.mock('./config.js', () => ({
  config: {
    server: {
      name: 'Horizon Layer',
      version: '1.0.0',
    },
  },
}));

vi.mock('./tools/workspaces.js', () => ({
  registerWorkspaceTools,
}));

vi.mock('./tools/pages.js', () => ({
  registerPageTools,
}));

vi.mock('./tools/databases.js', () => ({
  registerDatabaseTools,
}));

vi.mock('./tools/rows.js', () => ({
  registerRowTools,
}));

vi.mock('./tools/search.js', () => ({
  registerSearchTools,
}));

vi.mock('./tools/links.js', () => ({
  registerLinkTools,
}));

vi.mock('./tools/tasks.js', () => ({
  registerTaskTools,
}));

vi.mock('./tools/runs.js', () => ({
  registerRunTools,
}));

describe('createAppServer local runtime', () => {
  beforeEach(() => {
    fastMcpInstances.length = 0;
    registerWorkspaceTools.mockClear();
    registerPageTools.mockClear();
    registerDatabaseTools.mockClear();
    registerRowTools.mockClear();
    registerSearchTools.mockClear();
    registerLinkTools.mockClear();
    registerTaskTools.mockClear();
    registerRunTools.mockClear();
  });

  it('boots FastMCP without hosted auth wiring', async () => {
    const { createAppServer } = await import('./server.js');
    createAppServer();

    expect(fastMcpInstances[0].options).toMatchObject({
      name: 'Horizon Layer',
      version: '1.0.0',
    });
    expect(registerWorkspaceTools).toHaveBeenCalledTimes(1);
    expect(registerRunTools).toHaveBeenCalledTimes(1);
  });
});
