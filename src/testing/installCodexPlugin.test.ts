import { describe, expect, it } from 'vitest';

type InstallerModule = {
  enablePluginInConfig(source: string): string;
  removeGlobalHorizonLayerMcp(source: string): string;
  upsertMarketplaceEntry(payload: Record<string, unknown>): {
    plugins: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
};

// @ts-expect-error - installer is a plain Node.js script outside the TypeScript source root.
const installer = await import('../../scripts/install-codex-plugin.mjs') as InstallerModule;
const { enablePluginInConfig, removeGlobalHorizonLayerMcp, upsertMarketplaceEntry } = installer;

describe('install-codex-plugin helpers', () => {
  it('adds the HorizonLayer personal marketplace entry', () => {
    const payload = {
      name: 'personal',
      interface: { displayName: 'Personal' },
      plugins: [],
    };

    expect(upsertMarketplaceEntry(payload)).toEqual({
      name: 'personal',
      interface: { displayName: 'Personal' },
      plugins: [
        {
          name: 'horizonlayer',
          source: { source: 'local', path: './plugins/horizonlayer' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    });
  });

  it('replaces an existing HorizonLayer marketplace entry without touching others', () => {
    const payload = {
      name: 'personal',
      plugins: [
        { name: 'other-plugin', source: { source: 'local', path: './plugins/other-plugin' } },
        { name: 'horizonlayer', source: { source: 'local', path: './plugins/old-horizonlayer' } },
      ],
    };

    const result = upsertMarketplaceEntry(payload);

    expect(result.plugins).toHaveLength(2);
    expect(result.plugins[0].name).toBe('other-plugin');
    expect(result.plugins[1]).toMatchObject({
      name: 'horizonlayer',
      source: { source: 'local', path: './plugins/horizonlayer' },
    });
  });

  it('removes the old global HorizonLayer MCP section', () => {
    const config = [
      'model = "gpt-5.5"',
      '',
      '[mcp_servers.horizonlayer]',
      'command = "npx"',
      'args = ["-y", "--package=horizonlayer", "horizonlayer"]',
      '',
      '[notice]',
      'hide_full_access_warning = true',
      '',
    ].join('\n');

    const result = removeGlobalHorizonLayerMcp(config);

    expect(result).not.toContain('[mcp_servers.horizonlayer]');
    expect(result).not.toContain('--package=horizonlayer');
    expect(result).toContain('[notice]\nhide_full_access_warning = true');
  });

  it('enables the personal plugin exactly once', () => {
    const config = 'model = "gpt-5.5"\n';

    const once = enablePluginInConfig(config);
    const twice = enablePluginInConfig(once);

    expect(twice.match(/\[plugins\."horizonlayer@personal"\]/g)).toHaveLength(1);
    expect(twice).toContain('[plugins."horizonlayer@personal"]\nenabled = true');
  });
});
