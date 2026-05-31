#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_NAME = 'horizonlayer';
const MARKETPLACE_PATH = './plugins/horizonlayer';
const PERSONAL_PLUGIN_SECTION = '[plugins."horizonlayer@personal"]';
const GLOBAL_MCP_SECTION = '[mcp_servers.horizonlayer]';

function repoRootFromScript() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function defaultMarketplace() {
  return {
    name: 'personal',
    interface: { displayName: 'Personal' },
    plugins: [],
  };
}

function horizonLayerMarketplaceEntry() {
  return {
    name: PLUGIN_NAME,
    source: {
      source: 'local',
      path: MARKETPLACE_PATH,
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: 'Productivity',
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function upsertMarketplaceEntry(payload) {
  const next = cloneJson(payload ?? defaultMarketplace());
  if (!next.name) {
    next.name = 'personal';
  }
  if (!next.interface) {
    next.interface = { displayName: 'Personal' };
  }

  const existingPlugins = Array.isArray(next.plugins) ? next.plugins : [];
  next.plugins = [
    ...existingPlugins.filter((entry) => {
      return !(entry && typeof entry === 'object' && !Array.isArray(entry) && entry.name === PLUGIN_NAME);
    }),
    horizonLayerMarketplaceEntry(),
  ];

  return next;
}

function isTomlHeader(line) {
  return /^\[[^\]]+\]\s*$/.test(line.trim());
}

function isTargetOrNestedHeader(line, section) {
  const trimmed = line.trim();
  const nestedPrefix = `${section.slice(0, -1)}.`;
  return trimmed === section || trimmed.startsWith(nestedPrefix);
}

function removeTomlSection(source, section) {
  const lines = source.split('\n');
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    if (isTargetOrNestedHeader(line, section)) {
      skipping = true;
      continue;
    }

    if (skipping && isTomlHeader(line)) {
      skipping = false;
    }

    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

export function removeGlobalHorizonLayerMcp(source) {
  return removeTomlSection(source, GLOBAL_MCP_SECTION);
}

export function enablePluginInConfig(source) {
  const withoutExistingPluginSection = removeTomlSection(source, PERSONAL_PLUGIN_SECTION);
  const trimmed = withoutExistingPluginSection.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : '';
  return `${prefix}${PERSONAL_PLUGIN_SECTION}\nenabled = true\n`;
}

function run(command, args, cwd) {
  console.error(`> ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

function readJson(path) {
  if (!existsSync(path)) {
    return defaultMarketplace();
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readPluginVersion(pluginSource) {
  const manifestPath = join(pluginSource, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.version || typeof manifest.version !== 'string') {
    throw new Error(`Plugin manifest at ${manifestPath} must include a string version.`);
  }
  return manifest.version;
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function refreshCodexPluginCache(pluginSource, home) {
  const version = readPluginVersion(pluginSource);
  const pluginCacheRoot = join(home, '.codex', 'plugins', 'cache', 'personal', PLUGIN_NAME);
  const pluginCachePath = join(pluginCacheRoot, version);

  rmSync(pluginCacheRoot, { recursive: true, force: true });
  mkdirSync(dirname(pluginCachePath), { recursive: true });
  cpSync(pluginSource, pluginCachePath, { recursive: true });
}

function ensurePluginSymlink(source, target) {
  mkdirSync(dirname(target), { recursive: true });

  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${target} already exists and is not a symlink. Move it before running this installer.`);
    }
    unlinkSync(target);
  }

  symlinkSync(source, target, 'dir');
}

function updateCodexConfig(path) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const withoutGlobalMcp = removeGlobalHorizonLayerMcp(existing);
  const next = enablePluginInConfig(withoutGlobalMcp);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
}

function usage() {
  return [
    'Usage: node scripts/install-codex-plugin.mjs [--skip-build]',
    '',
    'Installs the repo-backed HorizonLayer Codex plugin globally for this user.',
    'By default it runs npm ci and npm run build before wiring Codex.',
  ].join('\n');
}

export function installCodexPlugin(options = {}) {
  const repoRoot = repoRootFromScript();
  const pluginSource = join(repoRoot, 'plugins', PLUGIN_NAME);
  const launcherPath = join(repoRoot, 'dist', 'launcher.js');
  const home = homedir();
  const localPluginPath = join(home, 'plugins', PLUGIN_NAME);
  const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json');
  const codexConfigPath = join(home, '.codex', 'config.toml');

  if (!existsSync(join(pluginSource, '.codex-plugin', 'plugin.json'))) {
    throw new Error(`Missing plugin manifest at ${pluginSource}`);
  }

  if (!options.skipBuild) {
    run('npm', ['ci'], repoRoot);
    run('npm', ['run', 'build'], repoRoot);
  }

  if (!existsSync(launcherPath)) {
    throw new Error(`Missing ${launcherPath}. Run npm run build before installing with --skip-build.`);
  }

  ensurePluginSymlink(pluginSource, localPluginPath);
  writeJson(marketplacePath, upsertMarketplaceEntry(readJson(marketplacePath)));
  updateCodexConfig(codexConfigPath);
  refreshCodexPluginCache(pluginSource, home);

  console.error('');
  console.error('HorizonLayer Codex plugin installed.');
  console.error(`Plugin symlink: ${localPluginPath} -> ${pluginSource}`);
  console.error(`Plugin cache: ${join(home, '.codex', 'plugins', 'cache', 'personal', PLUGIN_NAME)}`);
  console.error(`Marketplace: ${marketplacePath}`);
  console.error(`Codex config: ${codexConfigPath}`);
  console.error('');
  console.error('Database behavior on first use: DATABASE_URL if set, local Postgres if reachable, Docker pgvector fallback otherwise.');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }

  const unknown = args.filter((arg) => arg !== '--skip-build');
  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown.join(', ')}\n${usage()}`);
  }

  installCodexPlugin({ skipBuild: args.includes('--skip-build') });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
