import { beforeEach, describe, expect, it, vi } from 'vitest';

const appServerInstances: Array<{ options: Record<string, unknown> }> = [];
const configState = vi.hoisted(() => ({
  server: {
    name: 'Horizon Layer',
    version: '2.0.0',
  },
}));
const registerCoreTools = vi.fn();

vi.mock('./mcp.js', () => ({
  AppServer: class AppServer {
    public options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      appServerInstances.push({ options });
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
    appServerInstances.length = 0;
    registerCoreTools.mockClear();
  });

  it('boots the official SDK adapter with the compact core toolset', async () => {
    const { createAppServer } = await import('./server.js');
    createAppServer();

    expect(appServerInstances[0].options).toMatchObject({
      name: 'Horizon Layer',
      version: '2.0.0',
    });
    expect(appServerInstances[0].options.instructions).toContain('workspace list or create');
    expect(appServerInstances[0].options.instructions).toContain('latest revision');
    expect(registerCoreTools).toHaveBeenCalledTimes(1);
  });
});
