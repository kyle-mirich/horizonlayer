import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type InstallTarget = 'all' | 'claude' | 'codex';

type CommandRunner = (command: string, args: string[]) => void;

export interface InstallOptions {
  homeDirectory?: string;
  marketplaceSource?: string;
  pluginSource?: string;
  runCommand?: CommandRunner;
  skills?: string[];
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
const CLAUDE_MARKETPLACE_NAME = 'horizonlayer';
const CLAUDE_MARKETPLACE_MARKER = '.horizonlayer-managed-marketplace.json';
const CODEX_PLUGIN_MARKER = '.horizonlayer-managed-plugin.json';

export function parseInstallTarget(value: string | undefined): InstallTarget {
  if (value == null) return 'all';
  if (value === 'all' || value === 'claude' || value === 'codex') return value;
  throw new Error(`Unknown install target: ${value}\nUsage: horizonlayer install [all|codex|claude]`);
}

function bundledPluginSource(): string {
  return fileURLToPath(new URL('../plugins/horizonlayer/', import.meta.url));
}

function bundledClaudeMarketplaceSource(): string {
  return fileURLToPath(new URL('../', import.meta.url));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(join(path, '.mcp.json'));
    return true;
  } catch {
    return false;
  }
}

async function claudeMarketplaceExists(path: string): Promise<boolean> {
  try {
    await readFile(join(path, '.claude-plugin', 'marketplace.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

interface StagedClaudeMarketplace {
  commit: () => Promise<void>;
  hadExistingTarget: boolean;
  rollback: () => Promise<void>;
}

async function existingDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Claude marketplace target ${path} must be a regular directory.`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function managedClaudeMarketplace(path: string, transaction?: string): Promise<boolean> {
  try {
    const marker: unknown = JSON.parse(await readFile(join(path, CLAUDE_MARKETPLACE_MARKER), 'utf8'));
    if (marker == null || typeof marker !== 'object' || Array.isArray(marker)) return false;
    const value = marker as { installer?: unknown; kind?: unknown; transaction?: unknown };
    return value.installer === PLUGIN_NAME
      && value.kind === 'claude-marketplace'
      && (transaction == null || value.transaction === transaction);
  } catch {
    return false;
  }
}

async function filterBundledSkills(pluginPath: string, skills: string[] | undefined): Promise<void> {
  if (!skills) return;
  const skillsPath = join(pluginPath, 'skills');
  const selected = new Set(skills);
  const entries = await readdir(skillsPath, { withFileTypes: true });
  const available = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const missing = [...selected].filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Bundled HorizonLayer skills are missing: ${missing.join(', ')}`);
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !selected.has(entry.name))
    .map((entry) => rm(join(skillsPath, entry.name), { force: true, recursive: true })));
}

async function stageClaudeMarketplace(
  source: string,
  target: string,
  skills?: string[]
): Promise<StagedClaudeMarketplace> {
  if (!await claudeMarketplaceExists(source)) {
    throw new Error(`Bundled HorizonLayer Claude marketplace is missing from ${source}`);
  }

  await mkdir(dirname(target), { recursive: true });
  const hasExistingTarget = await existingDirectory(target);
  if (hasExistingTarget && !await managedClaudeMarketplace(target)) {
    throw new Error(
      `Claude marketplace target ${target} already exists and is not managed by HorizonLayer. `
      + 'Move it to a safe location or remove it after inspection, then run this command again.'
    );
  }

  const transaction = randomUUID();
  const staging = `${target}.install-${randomUUID()}`;
  const backup = `${target}.backup-${randomUUID()}`;
  let movedExisting = false;

  try {
    await mkdir(staging, { recursive: true });
    await Promise.all([
      cp(join(source, '.claude-plugin'), join(staging, '.claude-plugin'), { recursive: true }),
      cp(join(source, 'plugins'), join(staging, 'plugins'), { recursive: true }),
    ]);
    await filterBundledSkills(join(staging, 'plugins', PLUGIN_NAME), skills);
    await writeFile(join(staging, CLAUDE_MARKETPLACE_MARKER), JSON.stringify({
      installer: PLUGIN_NAME,
      kind: 'claude-marketplace',
      transaction,
    }), 'utf8');
    if (hasExistingTarget) {
      await rename(target, backup);
      movedExisting = true;
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    if (movedExisting) {
      if (await managedClaudeMarketplace(target, transaction)) {
        await rm(target, { force: true, recursive: true });
      }
      if (!await existingDirectory(target)) await rename(backup, target);
    }
    throw error;
  }

  return {
    hadExistingTarget: movedExisting,
    commit: async () => {
      if (movedExisting) await rm(backup, { force: true, recursive: true });
    },
    rollback: async () => {
      if (!movedExisting) return;
      if (await managedClaudeMarketplace(target, transaction)) {
        await rm(target, { force: true, recursive: true });
      }
      if (!await existingDirectory(target)) await rename(backup, target);
    },
  };
}

interface StagedCodexPlugin {
  commit: () => Promise<void>;
  hadExistingTarget: boolean;
  rollback: () => Promise<void>;
}

async function existingCodexPlugin(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Codex plugin target ${path} must be a regular directory.`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function managedCodexPlugin(path: string, transaction?: string): Promise<boolean> {
  try {
    const marker: unknown = JSON.parse(await readFile(join(path, CODEX_PLUGIN_MARKER), 'utf8'));
    if (marker == null || typeof marker !== 'object' || Array.isArray(marker)) return false;
    const value = marker as { installer?: unknown; kind?: unknown; transaction?: unknown };
    return value.installer === PLUGIN_NAME
      && value.kind === 'codex-plugin'
      && (transaction == null || value.transaction === transaction);
  } catch {
    return false;
  }
}

async function stageCodexPlugin(
  source: string,
  target: string,
  skills?: string[]
): Promise<StagedCodexPlugin> {
  if (!await pathExists(source)) {
    throw new Error(`Bundled HorizonLayer plugin is missing from ${source}`);
  }

  await mkdir(dirname(target), { recursive: true });
  const hasExistingTarget = await existingCodexPlugin(target);
  if (hasExistingTarget && !await managedCodexPlugin(target)) {
    throw new Error(
      `Codex plugin target ${target} already exists and is not managed by HorizonLayer. `
      + 'Move it to a safe location or remove it after inspection, then run this command again.'
    );
  }

  const transaction = randomUUID();
  const staging = `${target}.install-${randomUUID()}`;
  const backup = `${target}.backup-${randomUUID()}`;
  let movedExisting = false;

  try {
    await cp(source, staging, { recursive: true });
    await filterBundledSkills(staging, skills);
    await writeFile(join(staging, CODEX_PLUGIN_MARKER), JSON.stringify({
      installer: PLUGIN_NAME,
      kind: 'codex-plugin',
      transaction,
    }), 'utf8');
    if (hasExistingTarget) {
      await rename(target, backup);
      movedExisting = true;
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    if (movedExisting) {
      if (await managedCodexPlugin(target, transaction)) {
        await rm(target, { force: true, recursive: true });
      }
      if (!await existingCodexPlugin(target)) await rename(backup, target);
    }
    throw error;
  }

  return {
    hadExistingTarget: movedExisting,
    commit: async () => {
      if (movedExisting) await rm(backup, { force: true, recursive: true });
    },
    rollback: async () => {
      if (!movedExisting) return;
      if (await managedCodexPlugin(target, transaction)) {
        await rm(target, { force: true, recursive: true });
      }
      if (!await existingCodexPlugin(target)) await rename(backup, target);
    },
  };
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
  const clientName = command === 'claude' ? 'Claude Code CLI' : 'Codex CLI';
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${clientName} was not found. Install it, then run this command again.`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${clientName} plugin installation exited with status ${result.status ?? 'unknown'}. `
      + `Run \`${command} plugin --help\` to verify the client installation, then run this command again.`
    );
  }
}

async function installClaude(
  source: string,
  marketplaceSource: string,
  home: string,
  runCommand: CommandRunner,
  skills?: string[]
): Promise<InstallResult> {
  if (!await pathExists(source)) {
    throw new Error(`Bundled HorizonLayer plugin is missing from ${source}`);
  }
  if (!await claudeMarketplaceExists(marketplaceSource)) {
    throw new Error(`Bundled HorizonLayer Claude marketplace is missing from ${marketplaceSource}`);
  }

  const target = join(home, '.claude', 'horizonlayer-marketplace');
  const staged = await stageClaudeMarketplace(marketplaceSource, target, skills);
  try {
    runCommand('claude', ['plugin', 'marketplace', 'add', target]);
    runCommand('claude', [
      'plugin',
      'install',
      `${PLUGIN_NAME}@${CLAUDE_MARKETPLACE_NAME}`,
      '--scope',
      'user',
    ]);
  } catch (error) {
    if (staged.hadExistingTarget) {
      await staged.rollback();
    }
    // A first install may have registered this source before plugin installation failed.
    // Keep its managed directory in place so retrying the command is safe and deterministic.
    throw error;
  }
  await staged.commit();
  return { host: 'Claude Code', path: target };
}

async function installCodex(
  source: string,
  home: string,
  runCommand: CommandRunner,
  skills?: string[]
): Promise<InstallResult> {
  const target = join(home, 'plugins', PLUGIN_NAME);
  const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
  validateCodexMarketplace(await readMarketplace(marketplacePath), marketplacePath);
  const staged = await stageCodexPlugin(source, target, skills);
  try {
    const marketplaceName = await updateCodexMarketplace(marketplacePath);
    runCommand('codex', ['plugin', 'add', `${PLUGIN_NAME}@${marketplaceName}`]);
  } catch (error) {
    if (staged.hadExistingTarget) await staged.rollback();
    // A first install may have registered the personal marketplace before the client failed.
    // Keep its managed directory in place so retrying the command is safe and deterministic.
    throw error;
  }
  await staged.commit();
  return { host: 'Codex', path: target };
}

export async function installAgentPlugins(
  target: InstallTarget = 'all',
  options: InstallOptions = {}
): Promise<InstallResult[]> {
  const home = options.homeDirectory ?? homedir();
  const source = options.pluginSource ?? bundledPluginSource();
  const marketplaceSource = options.marketplaceSource ?? bundledClaudeMarketplaceSource();
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const results: InstallResult[] = [];

  if (target === 'all' || target === 'claude') {
    results.push(await installClaude(source, marketplaceSource, home, runCommand, options.skills));
  }
  if (target === 'all' || target === 'codex') {
    results.push(await installCodex(source, home, runCommand, options.skills));
  }
  return results;
}
