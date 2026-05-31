#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const linkedPlugin = join(homedir(), 'plugins', 'horizonlayer');

function repoRootFromPluginRoot(root) {
  return resolve(root, '..', '..');
}

function findRepoRoot() {
  if (existsSync(linkedPlugin)) {
    return repoRootFromPluginRoot(realpathSync(linkedPlugin));
  }
  return repoRootFromPluginRoot(pluginRoot);
}

const launcherPath = join(findRepoRoot(), 'dist', 'launcher.js');

if (!existsSync(launcherPath)) {
  console.error(`HorizonLayer launcher is missing at ${launcherPath}.`);
  console.error('Run `bash scripts/install-codex-plugin.sh` from the HorizonLayer repo and restart Codex.');
  process.exit(1);
}

const child = spawn(process.execPath, [launcherPath], {
  env: process.env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
