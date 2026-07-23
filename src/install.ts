import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type InstallTarget = 'all' | 'claude' | 'codex';

type CommandRunner = (command: string, args: string[]) => void;

export interface InstallOptions {
  homeDirectory?: string;
  pluginSource?: string;
  runCommand?: CommandRunner;
}

export interface InstallResult {
  host: 'Claude Code' | 'Codex';
  path: string;
}

interface MarketplacePlugin {
  name?: unknown;
  source?: {
    source?: unknown;
    path?: unknown;
  };
  [key: string]: unknown;
}

interface Marketplace {
  name?: unknown;
  interface?: unknown;
  plugins?: unknown;
  [key: string]: unknown;
}

const PLUGIN_NAME = 'horizonlayer';
const PERSONAL_MARKETPLACE_PATH = './plugins/horizonlayer';

export function parseInstallTarget(value: string | undefined): InstallTarget {
  if (value == null) return 'all';
  if (value === 'all' || value === 'claude' || value === 'codex') return value;
  throw new Error(`Unknown install target: ${value}\nUsage: horizonlayer install [all|codex|claude]`);
}

function bundledPluginSource(): string {
  return fileURLToPath(new URL('../plugins/horizonlayer/', import.meta.url));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(join(path, '.mcp.json'));
    return true;
  } catch {
    return false;
  }
}

async function replaceDirectory(source: string, target: string): Promise<void> {
  if (!await pathExists(source)) {
    throw new Error(`Bundled HorizonLayer plugin is missing from ${source}`);
  }

  await mkdir(dirname(target), { recursive: true });
  const staging = `${target}.install-${randomUUID()}`;
  const backup = `${target}.backup-${randomUUID()}`;
  let movedExisting = false;

  try {
    await cp(source, staging, { recursive: true });
    try {
      await rename(target, backup);
      movedExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(staging, target);
    if (movedExisting) await rm(backup, { force: true, recursive: true });
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    if (movedExisting) {
      await rm(target, { force: true, recursive: true });
      await rename(backup, target);
    }
    throw error;
  }
}

function horizonLayerMarketplaceEntry(): MarketplacePlugin {
  return {
    name: PLUGIN_NAME,
    source: {
      source: 'local',
      path: PERSONAL_MARKETPLACE_PATH,
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: 'Productivity',
  };
}

async function readMarketplace(path: string): Promise<Marketplace> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('root must be a JSON object');
    }
    return value as Marketplace;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        name: 'personal',
        interface: { displayName: 'Personal' },
        plugins: [],
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read Codex personal marketplace at ${path}: ${message}`);
  }
}

function validateCodexMarketplace(marketplace: Marketplace, path: string): void {
  if (typeof marketplace.name !== 'string' || marketplace.name.length === 0) {
    throw new Error(`Codex personal marketplace at ${path} must have a non-empty name`);
  }
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error(`Codex personal marketplace at ${path} must have a plugins array`);
  }

  const plugins = marketplace.plugins as MarketplacePlugin[];
  const existingIndex = plugins.findIndex((plugin) => plugin?.name === PLUGIN_NAME);
  if (existingIndex >= 0) {
    const existing = plugins[existingIndex];
    if (existing?.source?.source !== 'local'
      || existing.source.path !== PERSONAL_MARKETPLACE_PATH) {
      throw new Error(
        `Codex marketplace '${marketplace.name}' already defines HorizonLayer from another source; `
        + 'remove or rename that entry before installing this local plugin.'
      );
    }
  }
}

async function updateCodexMarketplace(path: string): Promise<string> {
  const marketplace = await readMarketplace(path);
  validateCodexMarketplace(marketplace, path);
  const plugins = marketplace.plugins as MarketplacePlugin[];
  const existingIndex = plugins.findIndex((plugin) => plugin?.name === PLUGIN_NAME);
  if (existingIndex >= 0) {
    plugins[existingIndex] = horizonLayerMarketplaceEntry();
  } else {
    plugins.push(horizonLayerMarketplaceEntry());
  }

  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.install-${randomUUID()}`;
  await writeFile(staging, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8');
  await rename(staging, path);
  return marketplace.name as string;
}

function defaultCommandRunner(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Codex CLI was not found. Install Codex, then run this command again.');
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Codex plugin installation exited with status ${result.status ?? 'unknown'}`);
  }
}

async function installClaude(source: string, home: string): Promise<InstallResult> {
  const target = join(home, '.claude', 'skills', PLUGIN_NAME);
  await replaceDirectory(source, target);
  return { host: 'Claude Code', path: target };
}

async function installCodex(
  source: string,
  home: string,
  runCommand: CommandRunner
): Promise<InstallResult> {
  const target = join(home, 'plugins', PLUGIN_NAME);
  const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
  validateCodexMarketplace(await readMarketplace(marketplacePath), marketplacePath);
  await replaceDirectory(source, target);
  const marketplaceName = await updateCodexMarketplace(marketplacePath);
  runCommand('codex', ['plugin', 'add', `${PLUGIN_NAME}@${marketplaceName}`]);
  return { host: 'Codex', path: target };
}

export async function installAgentPlugins(
  target: InstallTarget = 'all',
  options: InstallOptions = {}
): Promise<InstallResult[]> {
  const home = options.homeDirectory ?? homedir();
  const source = options.pluginSource ?? bundledPluginSource();
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const results: InstallResult[] = [];

  if (target === 'all' || target === 'claude') {
    results.push(await installClaude(source, home));
  }
  if (target === 'all' || target === 'codex') {
    results.push(await installCodex(source, home, runCommand));
  }
  return results;
}
