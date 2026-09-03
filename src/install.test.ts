import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAgentPlugins, adaptMcpServersForPlatform, parseInstallTarget } from './install.js';

const pluginSource = fileURLToPath(new URL('../plugins/horizonlayer/', import.meta.url));
const marketplaceSource = fileURLToPath(new URL('../', import.meta.url));
const temporaryHomes: string[] = [];
const spawnSyncMock = vi.mocked(spawnSync);

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'horizonlayer-install-'));
  temporaryHomes.push(path);
  return path;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

function claudeMarketplaceTarget(home: string): string {
  return join(home, '.claude', 'horizonlayer-marketplace');
}

function codexPluginTarget(home: string): string {
  return join(home, 'plugins', 'horizonlayer');
}

afterEach(async () => {
  spawnSyncMock.mockReset();
  await Promise.all(temporaryHomes.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

beforeEach(() => {
  spawnSyncMock.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
});

describe('plugin installer', () => {
  it('parses the default and explicit install targets', () => {
    expect(parseInstallTarget(undefined)).toBe('all');
    expect(parseInstallTarget('all')).toBe('all');
    expect(parseInstallTarget('codex')).toBe('codex');
    expect(parseInstallTarget('claude')).toBe('claude');
    expect(() => parseInstallTarget('other')).toThrow('Unknown install target: other');
  });

  it('registers and installs the Claude Code plugin at user scope', async () => {
    const home = await temporaryHome();
    const runCommand = vi.fn();
    const results = await installAgentPlugins('claude', {
      homeDirectory: home,
      marketplaceSource,
      pluginSource,
      runCommand,
    });
    const target = claudeMarketplaceTarget(home);

    expect(results).toEqual([{ host: 'Claude Code', path: target }]);
    expect(runCommand).toHaveBeenNthCalledWith(1, 'claude', [
      'plugin', 'marketplace', 'add', target,
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(2, 'claude', [
      'plugin', 'install', 'horizonlayer@horizonlayer', '--scope', 'user',
    ]);
    await expect(readFile(join(target, '.claude-plugin', 'marketplace.json'), 'utf8'))
      .resolves.toContain('"name": "horizonlayer"');
    await expect(readFile(join(target, '.horizonlayer-managed-marketplace.json'), 'utf8'))
      .resolves.toContain('"kind":"claude-marketplace"');
    await expect(readFile(join(target, 'plugins', 'horizonlayer', '.mcp.json'), 'utf8'))
      .resolves.toContain('horizonlayer@0.1.1');
  });

  it('does not overwrite an unmanaged Claude marketplace target', async () => {
    const home = await temporaryHome();
    const target = claudeMarketplaceTarget(home);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'manual-marketplace.txt'), 'keep this marketplace', 'utf8');
    const runCommand = vi.fn();

    await expect(installAgentPlugins('claude', {
      homeDirectory: home,
      marketplaceSource,
      pluginSource,
      runCommand,
    })).rejects.toThrow('already exists and is not managed by HorizonLayer');

    await expect(readFile(join(target, 'manual-marketplace.txt'), 'utf8'))
      .resolves.toBe('keep this marketplace');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['marketplace registration', 'marketplace'],
    ['plugin installation', 'install'],
  ])('restores a managed Claude marketplace if %s fails', async (_label, failureCommand) => {
    const home = await temporaryHome();
    const target = claudeMarketplaceTarget(home);
    await installAgentPlugins('claude', {
      homeDirectory: home,
      marketplaceSource,
      pluginSource,
      runCommand: vi.fn(),
    });
    await writeFile(join(target, 'previous-marketplace.txt'), 'preserve me', 'utf8');
    const runCommand = vi.fn((_: string, args: string[]) => {
      if (args[1] === failureCommand) throw new Error('Claude Code registration failed');
    });

    await expect(installAgentPlugins('claude', {
      homeDirectory: home,
      marketplaceSource,
      pluginSource,
      runCommand,
    })).rejects.toThrow('Claude Code registration failed');

    await expect(readFile(join(target, 'previous-marketplace.txt'), 'utf8'))
      .resolves.toBe('preserve me');
    await expect(readFile(join(target, '.horizonlayer-managed-marketplace.json'), 'utf8'))
      .resolves.toContain('"kind":"claude-marketplace"');
  });

  it('rejects a non-directory Claude marketplace target without invoking the client', async () => {
    const home = await temporaryHome();
    const target = claudeMarketplaceTarget(home);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'not a directory', 'utf8');
    const runCommand = vi.fn();

    await expect(installAgentPlugins('claude', {
      homeDirectory: home,
      marketplaceSource,
      pluginSource,
      runCommand,
    })).rejects.toThrow('must be a regular directory');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('keeps a newly staged Claude marketplace after client installation fails so a retry is safe', async () => {
    const home = await temporaryHome();
    const target = claudeMarketplaceTarget(home);
    const runCommand = vi.fn((_: string, args: string[]) => {
      if (args[1] === 'install') throw new Error('Claude Code registration failed');
    });

    await expect(installAgentPlugins('claude', {
      homeDirectory: home,
      marketplaceSource,
      pluginSource,
      runCommand,
    })).rejects.toThrow('Claude Code registration failed');

    await expect(readFile(join(target, '.horizonlayer-managed-marketplace.json'), 'utf8'))
      .resolves.toContain('"kind":"claude-marketplace"');
  });

  it('registers and enables the Codex plugin in the personal marketplace', async () => {
    const home = await temporaryHome();
    const runCommand = vi.fn();
    const results = await installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand,
    });
    const target = codexPluginTarget(home);
    const marketplace = await readJson(join(home, '.agents', 'plugins', 'marketplace.json'));

    expect(results).toEqual([{ host: 'Codex', path: target }]);
    expect(marketplace).toMatchObject({
      name: 'personal',
      interface: { displayName: 'Personal' },
      plugins: [{
        name: 'horizonlayer',
        source: { source: 'local', path: './plugins/horizonlayer' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      }],
    });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      'codex',
      ['plugin', 'add', 'horizonlayer@personal']
    );
    await expect(readFile(join(target, '.horizonlayer-managed-plugin.json'), 'utf8'))
      .resolves.toContain('"kind":"codex-plugin"');
  });

  it('installs only the bundled skills selected for the project modules', async () => {
    const home = await temporaryHome();
    await installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand: vi.fn(),
      skills: ['issues'],
    });
    const installedSkills = await readdir(join(codexPluginTarget(home), 'skills'));
    expect(installedSkills).toContain('issues');
    expect(installedSkills).not.toContain('knowledge');
    expect(installedSkills).toEqual(expect.arrayContaining([
      'code-review',
      'codebase-design',
      'diagnosing-bugs',
      'domain-modeling',
      'grill-me',
      'grill-with-docs',
      'grilling',
      'implement',
      'improve-codebase-architecture',
      'prototype',
      'research',
      'resolving-merge-conflicts',
      'tdd',
      'to-spec',
      'to-tickets',
      'triage',
      'using-horizonlayer',
      'wayfinder',
    ]));
  });

  it('does not overwrite an unmanaged Codex plugin target', async () => {
    const home = await temporaryHome();
    const target = codexPluginTarget(home);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'manual-plugin.txt'), 'keep this plugin', 'utf8');
    const runCommand = vi.fn();

    await expect(installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand,
    })).rejects.toThrow('already exists and is not managed by HorizonLayer');

    await expect(readFile(join(target, 'manual-plugin.txt'), 'utf8')).resolves.toBe('keep this plugin');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects a non-directory Codex plugin target without invoking the client', async () => {
    const home = await temporaryHome();
    const target = codexPluginTarget(home);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'not a directory', 'utf8');
    const runCommand = vi.fn();

    await expect(installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand,
    })).rejects.toThrow('must be a regular directory');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('restores an existing managed Codex plugin if client registration fails', async () => {
    const home = await temporaryHome();
    const target = codexPluginTarget(home);
    await installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand: vi.fn(),
    });
    await writeFile(join(target, 'previous-plugin.txt'), 'preserve me', 'utf8');

    await expect(installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand: vi.fn(() => {
        throw new Error('Codex registration failed');
      }),
    })).rejects.toThrow('Codex registration failed');

    await expect(readFile(join(target, 'previous-plugin.txt'), 'utf8')).resolves.toBe('preserve me');
    await expect(readFile(join(target, '.horizonlayer-managed-plugin.json'), 'utf8'))
      .resolves.toContain('"kind":"codex-plugin"');
  });

  it('keeps a newly staged Codex plugin after client registration fails so a retry is safe', async () => {
    const home = await temporaryHome();
    const target = codexPluginTarget(home);

    await expect(installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand: vi.fn(() => {
        throw new Error('Codex registration failed');
      }),
    })).rejects.toThrow('Codex registration failed');

    await expect(readFile(join(target, '.horizonlayer-managed-plugin.json'), 'utf8'))
      .resolves.toContain('"kind":"codex-plugin"');
  });

  it('updates idempotently while preserving unrelated marketplace content', async () => {
    const home = await temporaryHome();
    const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
    await mkdir(dirname(marketplacePath), { recursive: true });
    await writeFile(marketplacePath, JSON.stringify({
      name: 'my-agents',
      interface: { displayName: 'My Agents', extra: true },
      custom: 'preserved',
      plugins: [
        { name: 'other-plugin', source: { source: 'local', path: './plugins/other' } },
        {
          name: 'horizonlayer',
          source: { source: 'local', path: './plugins/horizonlayer' },
          category: 'Old',
        },
      ],
    }), 'utf8');
    const runCommand = vi.fn();

    await installAgentPlugins('codex', { homeDirectory: home, pluginSource, runCommand });
    await installAgentPlugins('codex', { homeDirectory: home, pluginSource, runCommand });
    const marketplace = await readJson(marketplacePath);
    const plugins = marketplace.plugins as Array<{ name: string }>;

    expect(marketplace).toMatchObject({
      name: 'my-agents',
      interface: { displayName: 'My Agents', extra: true },
      custom: 'preserved',
    });
    expect(plugins.map((plugin) => plugin.name)).toEqual(['other-plugin', 'horizonlayer']);
    expect(runCommand).toHaveBeenLastCalledWith(
      'codex',
      ['plugin', 'add', 'horizonlayer@my-agents']
    );
  });

  it('does not overwrite a conflicting Codex marketplace source', async () => {
    const home = await temporaryHome();
    const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
    await mkdir(dirname(marketplacePath), { recursive: true });
    await writeFile(marketplacePath, JSON.stringify({
      name: 'personal',
      interface: { displayName: 'Personal' },
      plugins: [{
        name: 'horizonlayer',
        source: { source: 'git', url: 'https://example.com/horizonlayer.git' },
      }],
    }), 'utf8');
    const existingPluginPath = join(home, 'plugins', 'horizonlayer');
    await mkdir(existingPluginPath, { recursive: true });
    await writeFile(join(existingPluginPath, '.mcp.json'), 'do-not-replace', 'utf8');
    const before = await readFile(marketplacePath, 'utf8');
    const runCommand = vi.fn();

    await expect(installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand,
    })).rejects.toThrow('already defines HorizonLayer from another source');
    await expect(readFile(marketplacePath, 'utf8')).resolves.toBe(before);
    await expect(readFile(join(existingPluginPath, '.mcp.json'), 'utf8'))
      .resolves.toBe('do-not-replace');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('does not invoke Claude Code when the bundled plugin or marketplace is missing', async () => {
    const home = await temporaryHome();
    const runCommand = vi.fn();

    await expect(installAgentPlugins('claude', {
      homeDirectory: home,
      pluginSource: join(home, 'missing-plugin'),
      runCommand,
    })).rejects.toThrow('Bundled HorizonLayer plugin is missing');
    expect(runCommand).not.toHaveBeenCalled();

    await expect(installAgentPlugins('claude', {
      homeDirectory: home,
      marketplaceSource: join(home, 'missing-marketplace'),
      pluginSource,
      runCommand,
    })).rejects.toThrow('Bundled HorizonLayer Claude marketplace is missing');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects malformed Codex marketplaces before writing', async () => {
    const home = await temporaryHome();
    const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
    await mkdir(dirname(marketplacePath), { recursive: true });
    await writeFile(marketplacePath, '{invalid json}', 'utf8');
    await expect(installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand: vi.fn(),
    })).rejects.toThrow('Cannot read Codex personal marketplace');

    await writeFile(marketplacePath, JSON.stringify([]), 'utf8');
    await expect(installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand: vi.fn(),
    })).rejects.toThrow('root must be a JSON object');
  });

  it('validates required marketplace fields and conflicting local plugin paths', async () => {
    const home = await temporaryHome();
    const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
    await mkdir(dirname(marketplacePath), { recursive: true });

    await writeFile(marketplacePath, JSON.stringify({ plugins: [] }), 'utf8');
    await expect(installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand: vi.fn(),
    })).rejects.toThrow('must have a non-empty name');

    await writeFile(marketplacePath, JSON.stringify({ name: 'personal', plugins: {} }), 'utf8');
    await expect(installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand: vi.fn(),
    })).rejects.toThrow('must have a plugins array');

    await writeFile(marketplacePath, JSON.stringify({
      name: 'personal',
      plugins: [{ name: 'horizonlayer', source: { source: 'local', path: './other' } }],
    }), 'utf8');
    await expect(installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource,
      runCommand: vi.fn(),
    })).rejects.toThrow('already defines HorizonLayer from another source');
  });

  it('uses the default client runners and gives actionable runner failures', async () => {
    const successHome = await temporaryHome();
    await installAgentPlugins('codex', { homeDirectory: successHome, pluginSource });
    expect(spawnSyncMock).toHaveBeenCalledWith('codex', ['plugin', 'add', 'horizonlayer@personal'], {
      stdio: 'inherit',
    });

    const claudeHome = await temporaryHome();
    const claudeTarget = claudeMarketplaceTarget(claudeHome);
    await installAgentPlugins('claude', {
      homeDirectory: claudeHome,
      marketplaceSource,
      pluginSource,
    });
    expect(spawnSyncMock).toHaveBeenCalledWith('claude', [
      'plugin', 'marketplace', 'add', claudeTarget,
    ], { stdio: 'inherit' });
    expect(spawnSyncMock).toHaveBeenCalledWith('claude', [
      'plugin', 'install', 'horizonlayer@horizonlayer', '--scope', 'user',
    ], { stdio: 'inherit' });

    const missingHome = await temporaryHome();
    spawnSyncMock.mockReset().mockReturnValue({
      error: Object.assign(new Error('missing codex'), { code: 'ENOENT' }),
      status: null,
    } as unknown as ReturnType<typeof spawnSync>);
    await expect(installAgentPlugins('codex', { homeDirectory: missingHome, pluginSource }))
      .rejects.toThrow('Codex CLI was not found');

    const missingClaudeHome = await temporaryHome();
    await expect(installAgentPlugins('claude', {
      homeDirectory: missingClaudeHome,
      marketplaceSource,
      pluginSource,
    })).rejects.toThrow('Claude Code CLI was not found');

    const failedHome = await temporaryHome();
    spawnSyncMock.mockReset().mockReturnValue({ status: 2 } as ReturnType<typeof spawnSync>);
    await expect(installAgentPlugins('codex', { homeDirectory: failedHome, pluginSource }))
      .rejects.toThrow('installation exited with status 2. Run `codex plugin --help`');

    const unknownStatusHome = await temporaryHome();
    spawnSyncMock.mockReset().mockReturnValue({ status: null } as ReturnType<typeof spawnSync>);
    await expect(installAgentPlugins('codex', { homeDirectory: unknownStatusHome, pluginSource }))
      .rejects.toThrow('installation exited with status unknown');

    const permissionHome = await temporaryHome();
    spawnSyncMock.mockReset().mockReturnValue({
      error: new Error('permission denied'),
      status: null,
    } as ReturnType<typeof spawnSync>);
    await expect(installAgentPlugins('codex', { homeDirectory: permissionHome, pluginSource }))
      .rejects.toThrow('permission denied');
  });

  it('uses the bundled plugin source when callers only override the installation home', async () => {
    const home = await temporaryHome();
    const runCommand = vi.fn();
    const target = claudeMarketplaceTarget(home);

    await installAgentPlugins('claude', { homeDirectory: home, runCommand });

    expect(runCommand).toHaveBeenNthCalledWith(1, 'claude', [
      'plugin', 'marketplace', 'add', target,
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(2, 'claude', [
      'plugin', 'install', 'horizonlayer@horizonlayer', '--scope', 'user',
    ]);
  });

  it('installs both clients by default', async () => {
    const home = await temporaryHome();
    const runCommand = vi.fn();

    const results = await installAgentPlugins('all', {
      homeDirectory: home,
      pluginSource,
      runCommand,
    });
    const target = claudeMarketplaceTarget(home);

    expect(results.map((result) => result.host)).toEqual(['Claude Code', 'Codex']);
    await expect(readFile(join(home, 'plugins', 'horizonlayer', '.mcp.json'), 'utf8'))
      .resolves.toContain('horizonlayer');
    expect(runCommand).toHaveBeenCalledWith('claude', [
      'plugin', 'marketplace', 'add', target,
    ]);
    expect(runCommand).toHaveBeenCalledWith('claude', [
      'plugin', 'install', 'horizonlayer@horizonlayer', '--scope', 'user',
    ]);
  });

  it('installs the surviving host and summarizes when one client fails', async () => {
    const home = await temporaryHome();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const runCommand = vi.fn((command: string) => {
        if (command === 'claude') throw new Error('Claude Code CLI was not found');
      });
      const results = await installAgentPlugins('all', {
        homeDirectory: home,
        marketplaceSource,
        pluginSource,
        runCommand,
      });

      expect(results).toEqual([{ host: 'Codex', path: join(home, 'plugins', 'horizonlayer') }]);
      expect(runCommand).toHaveBeenCalledWith('codex', expect.any(Array));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Codex'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Claude Code'));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('installs the surviving host when Codex registration fails', async () => {
    const home = await temporaryHome();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const runCommand = vi.fn((command: string) => {
        if (command === 'codex') throw new Error('Codex registration failed');
      });
      const results = await installAgentPlugins('all', {
        homeDirectory: home,
        marketplaceSource,
        pluginSource,
        runCommand,
      });

      expect(results.map((result) => result.host)).toEqual(['Claude Code']);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Codex registration failed'));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('fails only when every requested host fails, naming each host', async () => {
    const home = await temporaryHome();
    const runCommand = vi.fn((command: string) => {
      throw new Error(command === 'claude' ? 'Claude Code CLI was not found' : 'Codex CLI was not found');
    });

    await expect(installAgentPlugins('all', {
      homeDirectory: home,
      marketplaceSource,
      pluginSource,
      runCommand,
    })).rejects.toThrow(/Claude Code.*Codex/su);
  });
  it('keeps package, marketplace, plugin, and MCP versions aligned', async () => {
    const packageJson = await readJson(fileURLToPath(new URL('../package.json', import.meta.url)));
    const codexManifest = await readJson(join(pluginSource, '.codex-plugin', 'plugin.json'));
    const claudeManifest = await readJson(join(pluginSource, '.claude-plugin', 'plugin.json'));
    const agentPluginsManifest = await readJson(join(pluginSource, 'plugin.json'));
    const claudeMarketplace = await readJson(fileURLToPath(
      new URL('../.claude-plugin/marketplace.json', import.meta.url)
    ));
    const mcp = await readJson(join(pluginSource, '.mcp.json'));
    const agentPluginsMcp = await readJson(join(pluginSource, 'mcp.json'));
    const marketplacePlugin = (claudeMarketplace.plugins as Array<Record<string, unknown>>)[0];
    const mcpServer = (mcp.mcpServers as Record<string, { args: string[] }>).horizonlayer;
    const agentServer = (agentPluginsMcp.mcpServers as Record<string, {
      type: string;
      args: string[];
    }>).horizonlayer;

    expect(codexManifest.version).toBe(packageJson.version);
    expect(claudeManifest.version).toBe(packageJson.version);
    expect(agentPluginsManifest.version).toBe(packageJson.version);
    expect(marketplacePlugin?.version).toBe(packageJson.version);
    expect(mcpServer.args).toContain(`horizonlayer@${packageJson.version as string}`);

    expect(agentPluginsManifest.$schema)
      .toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(agentPluginsManifest.name).toBe('horizonlayer');
    expect(agentPluginsMcp.$schema)
      .toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    expect(agentServer.type).toBe('stdio');
    expect(agentServer.args).toContain(`horizonlayer@${packageJson.version as string}`);
  });

  describe('adaptMcpServersForPlatform', () => {
    const portableConfig = {
      $schema: 'https://example.invalid/mcp.schema.json',
      mcpServers: {
        horizonlayer: { type: 'stdio', command: 'npx', args: ['-y', 'horizonlayer@0.1.1', 'mcp'] },
        other: { type: 'stdio', command: 'node', args: ['server.js'] },
      },
    };

    it('launches npx through cmd /c on win32 and preserves sibling servers', () => {
      const adapted = adaptMcpServersForPlatform(portableConfig, 'win32') as typeof portableConfig;
      const servers = adapted.mcpServers as Record<string, Record<string, unknown>>;

      expect(servers.horizonlayer.command).toBe('cmd');
      expect(servers.horizonlayer.args).toEqual(['/c', 'npx', '-y', 'horizonlayer@0.1.1', 'mcp']);
      expect(servers.horizonlayer.type).toBe('stdio');
      expect(servers.other).toEqual(portableConfig.mcpServers.other);
      expect(adapted.$schema).toBe(portableConfig.$schema);
    });

    it('wraps an npx entry even when its args are missing or malformed', () => {
      const adapted = adaptMcpServersForPlatform({
        mcpServers: {
          bare: { command: 'npx' },
          malformed: { command: 'npx', args: 'not-an-array' },
        },
      }, 'win32') as { mcpServers: Record<string, Record<string, unknown>> };

      expect(adapted.mcpServers.bare.args).toEqual(['/c', 'npx']);
      expect(adapted.mcpServers.malformed.args).toEqual(['/c', 'npx']);
    });

    it('returns configurations unchanged off win32 or without adaptable entries', () => {
      expect(adaptMcpServersForPlatform(portableConfig, 'darwin')).toBe(portableConfig);
      expect(adaptMcpServersForPlatform(portableConfig, 'linux')).toBe(portableConfig);
      expect(adaptMcpServersForPlatform('not-an-object', 'win32')).toBe('not-an-object');
      expect(adaptMcpServersForPlatform(null, 'win32')).toBeNull();
      expect(adaptMcpServersForPlatform({ mcpServers: 'not-an-object' }, 'win32'))
        .toEqual({ mcpServers: 'not-an-object' });
      const withoutNpx = { mcpServers: { other: 'primitive-entry' } };
      expect(adaptMcpServersForPlatform(withoutNpx, 'win32')).toBe(withoutNpx);
    });
  });

  it('adapts staged MCP commands for Windows in both install targets', async () => {
    const home = await temporaryHome();
    await installAgentPlugins('all', {
      homeDirectory: home,
      marketplaceSource,
      pluginSource,
      platform: 'win32',
      runCommand: vi.fn(),
    });
    const expectedArgs = ['/c', 'npx', '-y', 'horizonlayer@0.1.1', 'mcp'];

    for (const stagedPath of [
      join(codexPluginTarget(home), '.mcp.json'),
      join(claudeMarketplaceTarget(home), 'plugins', 'horizonlayer', '.mcp.json'),
    ]) {
      const staged = await readJson(stagedPath);
      const server = (staged.mcpServers as Record<string, { command: string; args: string[] }>)
        .horizonlayer;
      expect(server.command).toBe('cmd');
      expect(server.args).toEqual(expectedArgs);
    }
  });

  it('leaves staged MCP commands byte-identical off Windows', async () => {
    const home = await temporaryHome();
    const bundled = await readFile(join(pluginSource, '.mcp.json'), 'utf8');
    await installAgentPlugins('all', {
      homeDirectory: home,
      marketplaceSource,
      pluginSource,
      runCommand: vi.fn(),
    });

    await expect(readFile(join(codexPluginTarget(home), '.mcp.json'), 'utf8'))
      .resolves.toBe(bundled);
    await expect(readFile(
      join(claudeMarketplaceTarget(home), 'plugins', 'horizonlayer', '.mcp.json'),
      'utf8'
    )).resolves.toBe(bundled);
  });

  it('rejects a bundled plugin whose MCP configuration is unreadable', async () => {
    const home = await temporaryHome();
    const brokenSource = join(home, 'broken-plugin-source');
    await mkdir(brokenSource, { recursive: true });
    await writeFile(join(brokenSource, '.mcp.json'), '{invalid json}', 'utf8');
    const runCommand = vi.fn();

    await expect(installAgentPlugins('codex', {
      homeDirectory: home,
      pluginSource: brokenSource,
      runCommand,
    })).rejects.toThrow('Bundled HorizonLayer MCP configuration at');
    expect(runCommand).not.toHaveBeenCalled();
  });
});
