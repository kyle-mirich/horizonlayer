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
const createFastMcpAuth = vi.fn();

vi.mock('fastmcp', () => ({
  FastMCP: class FastMCP {
    public options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      fastMcpInstances.push({ options });
    }

    addTool() {}

    getApp() {
      return {
        get() {},
        use() {},
      };
    }
  },
}));

vi.mock('./config.js', () => ({
  config: {
    server: {
      allowed_hosts: [],
      name: 'Horizon Layer',
      public_url: 'http://127.0.0.1:3000',
      resource_path: '/mcp',
      transport: 'http',
      version: '1.0.0',
    },
  },
}));

vi.mock('./auth/fastmcp.js', () => ({
  createFastMcpAuth,
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
    createFastMcpAuth.mockReset();
    createFastMcpAuth.mockReturnValue(null);
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
      health: {
        path: '/healthz',
      },
      name: 'Horizon Layer',
      version: '1.0.0',
    });
    expect(fastMcpInstances[0].options).not.toHaveProperty('authenticate');
    expect(fastMcpInstances[0].options).not.toHaveProperty('oauth');
    expect(registerWorkspaceTools).toHaveBeenCalledTimes(1);
    expect(registerRunTools).toHaveBeenCalledTimes(1);
  });

  it('wires auth into FastMCP when configured', async () => {
    createFastMcpAuth.mockReturnValue({
      authenticate: vi.fn(),
      oauth: { enabled: true },
    });

    const { createAppServer } = await import('./server.js');
    createAppServer();

    expect(fastMcpInstances[0].options).toHaveProperty('authenticate');
    expect(fastMcpInstances[0].options).toHaveProperty('oauth');
  });
});
