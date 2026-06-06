import { beforeEach, describe, expect, it, vi } from 'vitest';

const fastMcpInstances: Array<{ options: Record<string, unknown> }> = [];
const configState = vi.hoisted(() => ({
  server: {
    health_path: '/healthz',
    name: 'Horizon Layer',
    version: '1.0.0',
  },
}));
const registerCoreTools = vi.fn();

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
  config: configState,
}));

vi.mock('./tools/core.js', () => ({
  registerCoreTools,
}));

describe('createAppServer local runtime', () => {
  beforeEach(() => {
    vi.resetModules();
    fastMcpInstances.length = 0;
    registerCoreTools.mockClear();
  });

  it('boots FastMCP with the compact core toolset', async () => {
    const { createAppServer } = await import('./server.js');
    createAppServer();

    expect(fastMcpInstances[0].options).toMatchObject({
      health: {
        enabled: true,
        path: '/healthz',
      },
      name: 'Horizon Layer',
      version: '1.0.0',
    });
    expect(registerCoreTools).toHaveBeenCalledTimes(1);
  });
});
