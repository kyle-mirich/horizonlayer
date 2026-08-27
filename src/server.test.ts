import { beforeEach, describe, expect, it, vi } from 'vitest';

const appServerInstances: Array<{ options: Record<string, unknown> }> = [];
const configState = vi.hoisted(() => ({
  server: {
    name: 'Horizon Layer',
    version: '0.1.1',
  },
}));
const registerCoreTools = vi.fn();
const registerModuleTools = vi.fn();

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

vi.mock('./tools/modules.js', () => ({
  MODULES: ['knowledge', 'issues'],
  registerModuleTools,
}));

describe('createAppServer local runtime', () => {
  beforeEach(() => {
    vi.resetModules();
    appServerInstances.length = 0;
    registerCoreTools.mockClear();
    registerModuleTools.mockClear();
  });

  it('boots the official SDK adapter with the compact module toolset', async () => {
    const { createAppServer } = await import('./server.js');
    createAppServer();

    expect(appServerInstances[0].options).toMatchObject({
      name: 'Horizon Layer',
      version: '0.1.1',
    });
    expect(appServerInstances[0].options.instructions).toContain('Knowledge workspaces');
    expect(appServerInstances[0].options.instructions).toContain('latest revision');
    expect(registerModuleTools).toHaveBeenCalledWith(expect.anything(), ['knowledge', 'issues']);
    expect(registerCoreTools).not.toHaveBeenCalled();
  });

  it('keeps the v2 catalog behind explicit legacy mode', async () => {
    const { createAppServer } = await import('./server.js');
    createAppServer({ catalogMode: 'legacy' });
    expect(registerCoreTools).toHaveBeenCalledTimes(1);
    expect(registerModuleTools).not.toHaveBeenCalled();
  });

  it('parses module selection without allowing unknown modules', async () => {
    const { parseSelectedModules } = await import('./server.js');
    expect(parseSelectedModules('knowledge')).toEqual(['knowledge']);
    expect(parseSelectedModules('issues')).toEqual(['issues']);
    expect(parseSelectedModules('both')).toEqual(['knowledge', 'issues']);
    expect(() => parseSelectedModules('issues,unknown')).toThrow('HORIZONLAYER_MODULES');
  });
});
