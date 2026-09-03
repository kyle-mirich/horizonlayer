#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  applyLocalRuntimeEnvironment,
  createLocalRuntimeConfig,
  ensureDockerDesktopReady,
  hasExplicitRuntimeOverride,
  isDockerDaemonReady,
  localRuntimeConfigPath,
  openDashboardUrl,
  readLocalRuntimeConfig,
  removeLocalRuntimeConfig,
  runCompose,
  runtimeEnvironment,
  writeLocalRuntimeConfig,
  withLocalRuntimeLifecycleLock,
  type LocalRuntimeConfig,
} from './localRuntime.js';
import { isDependencyUnavailableCode } from './tools/common.js';

const { Client } = pg;

export type LauncherMode = 'backup' | 'dashboard' | 'doctor' | 'help' | 'install' | 'legacy-mcp' | 'mcp' | 'recover' | 'reset' | 'setup' | 'stop' | 'version';

export interface LauncherCommand {
  backupPath?: string;
  confirmRecovery?: boolean;
  confirmReset: boolean;
  dashboardPort?: number;
  mode: LauncherMode;
  openDashboard: boolean;
  recoveryPath?: string;
}

class FriendlyBootstrapError extends Error {
  constructor(message: string, readonly details?: string) {
    super(message);
    this.name = 'FriendlyBootstrapError';
  }
}

const USAGE = 'Usage: horizonlayer [mcp|legacy-mcp|setup|backup [FILE]|recover FILE [--yes]|dashboard [--open] [--port PORT]|doctor|stop|reset --yes|install [all|codex|claude]|--help|--version]';

const packageVersion: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

export function launcherVersion(): string {
  return packageVersion;
}

export function isHelpFlag(value: string): boolean {
  return value === '--help' || value === '-h' || value === 'help';
}

export function parseDashboardPortValue(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new FriendlyBootstrapError(
      `Invalid dashboard port: ${value}. Use --port 1-65535 or set DASHBOARD_PORT to a free port (1-65535).`
    );
  }
  return port;
}

export function parseDashboardPort(args: string[]): number | undefined {
  let port: number | undefined;
  const rest = args.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--open') continue;
    if (argument === '--port') {
      const value = rest[index + 1];
      if (value == null || value.startsWith('--')) {
        throw new FriendlyBootstrapError(
          'dashboard --port requires a value. Use --port 1-65535 or set DASHBOARD_PORT to a free port.\n'
          + USAGE
        );
      }
      port = parseDashboardPortValue(value);
      index += 1;
      continue;
    }
    if (argument.startsWith('--port=')) {
      port = parseDashboardPortValue(argument.slice('--port='.length));
      continue;
    }
    throw new FriendlyBootstrapError(`Unknown dashboard option: ${argument}\n` + USAGE);
  }
  return port;
}

export function parseLauncherCommand(args: string[]): LauncherCommand {
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    return { confirmReset: false, mode: 'version', openDashboard: false };
  }
  // --help works per subcommand: `setup --help` explains setup instead of
  // falling through to option parsing and failing there.
  if (args.length > 0 && args.some(isHelpFlag)) {
    return { confirmReset: false, mode: 'help', openDashboard: false };
  }
  if (args.length === 0 || (args.length === 1 && args[0] === 'mcp')) {
    return { confirmReset: false, mode: 'mcp', openDashboard: false };
  }
  if (args.length === 1 && args[0] === 'legacy-mcp') {
    return { confirmReset: false, mode: 'legacy-mcp', openDashboard: false };
  }
  if (args[0] === 'dashboard') {
    return {
      confirmReset: false,
      dashboardPort: parseDashboardPort(args),
      mode: 'dashboard',
      openDashboard: args.includes('--open'),
    };
  }
  if (args[0] === 'setup') {
    return { confirmReset: false, mode: 'setup', openDashboard: false };
  }
  if (args.length === 1 && ['doctor', 'stop'].includes(args[0]!)) {
    return { confirmReset: false, mode: args[0] as 'doctor' | 'stop', openDashboard: false };
  }
  if (args[0] === 'backup' && args.length <= 2) {
    return {
      backupPath: args[1],
      confirmReset: false,
      mode: 'backup',
      openDashboard: false,
    };
  }
  if (args[0] === 'recover'
    && args[1] !== '--yes'
    && (args.length === 2 || (args.length === 3 && args[2] === '--yes'))) {
    return {
      confirmRecovery: args[2] === '--yes',
      confirmReset: false,
      mode: 'recover',
      openDashboard: false,
      recoveryPath: args[1],
    };
  }
  if (args[0] === 'reset' && (args.length === 1 || (args.length === 2 && args[1] === '--yes'))) {
    return { confirmReset: args[1] === '--yes', mode: 'reset', openDashboard: false };
  }
  if (args[0] === 'install' && args.length <= 2) {
    return { confirmReset: false, mode: 'install', openDashboard: false };
  }
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h' || args[0] === 'help')) {
    return { confirmReset: false, mode: 'help', openDashboard: false };
  }
  throw new FriendlyBootstrapError(
    `Unknown command: ${args.join(' ') || '<empty>'}\n`
    + USAGE
  );
}

export function parseLauncherMode(args: string[]): LauncherMode {
  return parseLauncherCommand(args).mode;
}

export function shouldStartSavedRuntime(
  mode: LauncherMode,
  hasExplicitDatabaseUrl = false
): boolean {
  return !hasExplicitDatabaseUrl && (mode === 'dashboard' || mode === 'mcp' || mode === 'legacy-mcp');
}

export function shouldProvisionManagedRuntime(
  hasSavedRuntime: boolean,
  hasExplicitRuntimeOverride = false
): boolean {
  return !hasSavedRuntime && !hasExplicitRuntimeOverride;
}

export interface ManagedRuntimeResolution {
  localRuntime: LocalRuntimeConfig | null;
  provisionedManagedRuntime: boolean;
}

export async function resolveManagedRuntimeForLaunch(
  localRuntime: LocalRuntimeConfig | null,
  hasExplicitOverride: boolean,
  provision: () => Promise<void>,
  reread: () => Promise<LocalRuntimeConfig | null>
): Promise<ManagedRuntimeResolution> {
  if (!shouldProvisionManagedRuntime(localRuntime != null, hasExplicitOverride)) {
    return { localRuntime, provisionedManagedRuntime: false };
  }

  await provision();
  const savedRuntime = await reread();
  if (!savedRuntime) {
    throw new FriendlyBootstrapError(
      'HorizonLayer setup completed without saving its local runtime configuration. Run `horizonlayer setup` again.'
    );
  }
  return { localRuntime: savedRuntime, provisionedManagedRuntime: true };
}

export interface LocalRuntimeHealth {
  databaseReady: boolean;
  dockerReady: boolean;
  qdrantReady: boolean;
}

interface ConnectionErrorLike {
  code?: unknown;
  message?: unknown;
}

function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Preserve the endpoint useful for recovery without ever logging user info or query secrets.
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // Do not echo an invalid connection string: it may still contain credentials.
    return '<invalid DATABASE_URL>';
  }
}

export function isDatabaseUnavailable(error: unknown): boolean {
  const candidate = error != null && typeof error === 'object'
    ? error as ConnectionErrorLike
    : {};
  const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  return isDependencyUnavailableCode(code)
    || /connect|connection|timeout|refused|unreachable/u.test(message);
}

export function databaseUnavailableGuidance(url: string): string {
  return `PostgreSQL is unavailable at ${redactDatabaseUrl(url)}. `
    + 'Check DATABASE_URL and that PostgreSQL is running, or run `horizonlayer setup` '
    + 'to restore the managed local runtime.';
}

export async function runWithDatabaseGuidance(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (process.env.DATABASE_URL && isDatabaseUnavailable(error)) {
      throw new FriendlyBootstrapError(databaseUnavailableGuidance(process.env.DATABASE_URL),
        error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

export function localRuntimeRecoveryGuidance(health: LocalRuntimeHealth): string[] {
  const guidance: string[] = [];
  if (!health.dockerReady) {
    guidance.push('Recovery: start Docker Desktop (or Docker Engine), then run `horizonlayer setup`.');
  }
  if (!health.databaseReady) {
    guidance.push(
      'PostgreSQL recovery: run `horizonlayer setup` to start the saved managed service; '
      + 'if it remains unavailable, inspect Docker Desktop and the container logs.'
    );
  }
  if (!health.qdrantReady) {
    guidance.push(
      'Qdrant recovery: run `horizonlayer setup` to start the saved managed service; '
      + 'if it remains unavailable, inspect Docker Desktop and the container logs.'
    );
  }
  return guidance;
}

async function canConnect(url: string): Promise<boolean> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 1000,
  });

  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup failures for unsuccessful probes
    }
  }
}

async function waitForLocalServices(config: LocalRuntimeConfig, timeoutMs = 90_000): Promise<void> {
  const environment = runtimeEnvironment(config);
  const databaseUrl = environment.DATABASE_URL!;
  const qdrantUrl = environment.QDRANT_URL!;
  const deadline = Date.now() + timeoutMs;
  let databaseReady = false;
  let qdrantReady = false;

  while (Date.now() < deadline) {
    if (!databaseReady) databaseReady = await canConnect(databaseUrl);
    if (!qdrantReady) qdrantReady = await isQdrantReady(qdrantUrl);
    if (databaseReady && qdrantReady) return;
    await sleep(1_000);
  }

  const missing = [
    !databaseReady ? 'PostgreSQL' : null,
    !qdrantReady ? 'Qdrant' : null,
  ].filter(Boolean).join(' and ');
  throw new FriendlyBootstrapError(
    `${missing} did not become ready in time. Run \`horizonlayer doctor\` and inspect Docker Desktop.`
  );
}

async function warmLocalRag(): Promise<void> {
  console.error('Preparing the local embedding model and Qdrant collection...');
  const [{ getEmbeddingProvider, disposeEmbeddingProvider }, { getVectorStore, resetVectorStore }] = await Promise.all([
    import('./search/embedder.js'),
    import('./search/qdrant.js'),
  ]);
  try {
    const provider = await getEmbeddingProvider();
    const [vector] = await provider.embed(['HorizonLayer local setup verification']);
    if (!vector) throw new Error('Embedding model did not return a verification vector.');
    const vectorStore = getVectorStore();
    const setupPointId = '00000000-0000-5000-8000-000000000001';
    await vectorStore.upsert([{
      id: setupPointId,
      payload: { record_type: 'setup', source_type: 'setup' },
      vector,
    }]);
    await vectorStore.deleteIds([setupPointId]);
  } finally {
    await disposeEmbeddingProvider();
    resetVectorStore();
  }
}

export async function warmLocalRagBestEffort(
  warm: () => Promise<void> = warmLocalRag
): Promise<boolean> {
  try {
    await warm();
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `Warning: the local embedding model could not be loaded (${reason}). `
      + 'Continuing with RAG disabled for this setup; run `horizonlayer setup` again to retry the embedding warm-up.'
    );
    process.env.RAG_ENABLED = 'false';
    const { reloadConfig } = await import('./config.js');
    try {
      reloadConfig();
    } catch {
      // The configuration was valid before disabling RAG; keep the degraded
      // setup going even if a later reload cannot validate unrelated values.
    }
    return false;
  }
}

async function runSetup(projectOptions: import('./projectSetup.js').ProjectSetupOptions = {}): Promise<void> {
  const configPath = localRuntimeConfigPath();
  await withLocalRuntimeLifecycleLock(async () => {
    await ensureDockerDesktopReady();
    const config = await readLocalRuntimeConfig(configPath) ?? await createLocalRuntimeConfig();
    await writeLocalRuntimeConfig(config, configPath);
    // Setup always manages the saved local runtime. Respecting a caller's DATABASE_URL here
    // could initialize an unrelated external database while the launcher starts local containers.
    applyLocalRuntimeEnvironment(config, process.env, true);
    const { reloadConfig } = await import('./config.js');
    reloadConfig();

    console.error('Starting HorizonLayer PostgreSQL and Qdrant services...');
    runCompose('start', config);
    await waitForLocalServices(config);

    console.error('Initializing the HorizonLayer database...');
    const [{ initializeDatabase }, { closePool }] = await Promise.all([
      import('./db/initialize.js'),
      import('./db/client.js'),
    ]);
    try {
      await initializeDatabase();
    } finally {
      await closePool();
    }
    const { setupProject } = await import('./projectSetup.js');
    let project: Awaited<ReturnType<typeof setupProject>>;
    try {
      project = await setupProject(projectOptions);
    } finally {
      await closePool();
    }
    // The project configuration is durable before the optional embedding
    // warm-up, so a model download failure never loses the configured modules.
    await warmLocalRagBestEffort();
    console.error(`HorizonLayer setup is complete. Configuration: ${configPath}`);
    console.error(`Project configuration: ${project.configPath}`);
    console.error(`Enabled modules: ${project.config.modules.join(', ')}`);
    if (project.installed.length > 0) {
      console.error(`Installed bundled skills for: ${project.installed.map((item) => item.host).join(', ')}`);
    }
    console.error('Run `horizonlayer dashboard --open` or start the MCP server with `horizonlayer mcp`.');
  }, configPath);
}

async function runReset(confirmed: boolean): Promise<void> {
  if (!confirmed) {
    throw new FriendlyBootstrapError(
      'Reset permanently removes the saved Docker PostgreSQL and Qdrant data. '
      + 'Review the runtime you intend to delete, then run `horizonlayer reset --yes`.'
    );
  }

  const configPath = localRuntimeConfigPath();
  await withLocalRuntimeLifecycleLock(async () => {
    const config = await readLocalRuntimeConfig(configPath);
    if (!config) {
      throw new FriendlyBootstrapError('HorizonLayer is not set up. Run `horizonlayer setup` first.');
    }
    await ensureDockerDesktopReady();
    runCompose('reset', config);
    await removeLocalRuntimeConfig(configPath);
    console.error('HorizonLayer local runtime, PostgreSQL data, and Qdrant index were removed.');
  }, configPath);
}

async function runStop(): Promise<void> {
  const configPath = localRuntimeConfigPath();
  await withLocalRuntimeLifecycleLock(async () => {
    const config = await readLocalRuntimeConfig(configPath);
    if (!config) throw new FriendlyBootstrapError('HorizonLayer is not set up. Run `horizonlayer setup` first.');
    await ensureDockerDesktopReady();
    runCompose('stop', config);
  }, configPath);
  console.error('HorizonLayer PostgreSQL and Qdrant services are stopped.');
}

async function startSavedRuntimeForLaunch(): Promise<LocalRuntimeConfig> {
  const configPath = localRuntimeConfigPath();
  return withLocalRuntimeLifecycleLock(async () => {
    const config = await readLocalRuntimeConfig(configPath);
    if (!config) {
      throw new FriendlyBootstrapError(
        'The saved HorizonLayer runtime was removed while it was starting. Run `horizonlayer setup` again.'
      );
    }
    applyLocalRuntimeEnvironment(config);
    await ensureDockerDesktopReady();
    runCompose('start', config);
    await waitForLocalServices(config);
    return config;
  }, configPath);
}

async function runDoctor(): Promise<void> {
  const configPath = localRuntimeConfigPath();
  const config = await readLocalRuntimeConfig(configPath);
  if (!config) {
    console.error(`Configuration: missing (${configPath})`);
    console.error('Run `horizonlayer setup` first.');
    process.exitCode = 1;
    return;
  }
  applyLocalRuntimeEnvironment(config);
  const { reloadConfig } = await import('./config.js');
  try {
    reloadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Configuration: invalid (${configPath})`);
    console.error(message);
    console.error('Fix the named variable values, then run `horizonlayer doctor` again.');
    process.exitCode = 1;
    return;
  }
  const environment = runtimeEnvironment(config);

  const dockerReady = isDockerDaemonReady();
  const databaseReady = await canConnect(environment.DATABASE_URL!);
  const qdrantReady = await isQdrantReady(environment.QDRANT_URL!);

  console.error(`Configuration: ready (${configPath})`);
  console.error(`Docker Desktop: ${dockerReady ? 'ready' : 'unavailable'}`);
  console.error(`PostgreSQL: ${databaseReady ? 'ready' : 'unavailable'} (${redactDatabaseUrl(environment.DATABASE_URL!)})`);
  console.error(`Qdrant: ${qdrantReady ? 'ready' : 'unavailable'} (${environment.QDRANT_URL})`);
  for (const message of localRuntimeRecoveryGuidance({
    databaseReady,
    dockerReady,
    qdrantReady,
  })) {
    console.error(message);
  }
  if (!dockerReady || !databaseReady || !qdrantReady) process.exitCode = 1;
}

export async function isQdrantReady(url: string, timeoutMs = 1_000): Promise<boolean> {
  try {
    const response = await fetch(new URL('/readyz', url), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const command = parseLauncherCommand(args);
  const { mode } = command;
  if (mode === 'help') {
    console.log([
      USAGE,
      '',
      '  mcp        Start the compact module-aware stdio MCP server (default)',
      '  legacy-mcp Start the former eight-tool MCP catalog for temporary compatibility',
      '  setup      Provision services and configure project modules and optional bundled skills',
      '             Flags: --modules knowledge|issues|both --skills none|codex|claude|all --non-interactive',
      '  backup     Create a point-in-time Backup of all managed canonical data',
      '  recover    Preview a managed Runtime Recovery; pass --yes after FILE to perform it',
      '  dashboard  Start the local dashboard; pass --open to open it in a browser, --port PORT to override DASHBOARD_PORT',
      '  doctor     Check configuration, Docker, PostgreSQL, and Qdrant',
      '  stop       Stop the managed PostgreSQL and Qdrant services',
      '  reset      Permanently remove the managed services and local data; pass --yes to confirm',
      '  install    Install the HorizonLayer plugin for Codex and Claude Code',
      '  --version  Print the HorizonLayer version and exit (-v)',
    ].join('\n'));
    return;
  }

  if (mode === 'version') {
    console.log(`horizonlayer ${launcherVersion()}`);
    return;
  }

  if (mode === 'install') {
    const { installAgentPlugins, parseInstallTarget } = await import('./install.js');
    const { bundledSkills, readProjectConfig } = await import('./projectSetup.js');
    const target = parseInstallTarget(args[1]);
    const projectConfig = await readProjectConfig();
    // Without project configuration, stage the complete bundle; otherwise stage
    // only the skills for this project's enabled modules.
    const results = await installAgentPlugins(target, {
      skills: projectConfig ? bundledSkills(projectConfig.modules) : undefined,
    });
    for (const result of results) {
      console.error(`Installed HorizonLayer for ${result.host}: ${result.path}`);
    }
    console.error('Restart your agent client to load the plugin.');
    return;
  }

  if (mode === 'setup') {
    const { parseProjectSetupArgs } = await import('./projectSetup.js');
    const setupOptions = parseProjectSetupArgs(args.slice(1));
    await runSetup(setupOptions);
    return;
  }

  if (mode === 'backup') {
    const { createManagedRuntimeBackup, formatManagedBackupReceipt } = await import('./localBackup.js');
    const result = await createManagedRuntimeBackup({ destination: command.backupPath });
    console.error(formatManagedBackupReceipt(result));
    return;
  }

  if (mode === 'recover') {
    const {
      formatManagedRecoveryPreview,
      formatManagedRecoveryReceipt,
      previewManagedRuntimeRecovery,
      recoverManagedRuntime,
    } = await import('./localRecovery.js');
    const options = { artifact: command.recoveryPath! };
    if (!command.confirmRecovery) {
      const preview = await previewManagedRuntimeRecovery(options);
      console.error(formatManagedRecoveryPreview(preview));
      process.exitCode = 1;
      return;
    }
    const result = await recoverManagedRuntime(options);
    console.error(formatManagedRecoveryReceipt(result));
    return;
  }

  if (mode === 'doctor') {
    await runDoctor();
    return;
  }

  if (mode === 'stop') {
    await runStop();
    return;
  }

  if (mode === 'reset') {
    await runReset(command.confirmReset);
    return;
  }

  const hasExplicitDatabaseUrl = process.env.DATABASE_URL != null && process.env.DATABASE_URL !== '';
  const resolvedRuntime = await resolveManagedRuntimeForLaunch(
    await readLocalRuntimeConfig(),
    hasExplicitRuntimeOverride(),
    () => runSetup({ interactive: false }),
    () => readLocalRuntimeConfig()
  );
  let { localRuntime } = resolvedRuntime;
  const { provisionedManagedRuntime } = resolvedRuntime;
  if (localRuntime) {
    applyLocalRuntimeEnvironment(localRuntime);
    if (!provisionedManagedRuntime && shouldStartSavedRuntime(mode, hasExplicitDatabaseUrl)) {
      localRuntime = await startSavedRuntimeForLaunch();
    }
  }
  const { reloadConfig } = await import('./config.js');
  reloadConfig();

  if (!process.env.DATABASE_URL) {
    throw new FriendlyBootstrapError(
      'No PostgreSQL connection is configured. Run `horizonlayer setup` or set DATABASE_URL to an existing PostgreSQL instance. '
      + 'When DATABASE_URL is set, HorizonLayer uses that database instead of provisioning the managed local runtime.'
    );
  }

  if (mode === 'dashboard') {
    if (command.dashboardPort != null) {
      process.env.DASHBOARD_PORT = String(command.dashboardPort);
      reloadConfig();
    }
    const { runDashboard } = await import('./dashboard/runDashboard.js');
    await runWithDatabaseGuidance(async () => {
      const runtime = await runDashboard();
      if (command.openDashboard && !openDashboardUrl(runtime.url)) {
        console.error(`Open the HorizonLayer dashboard at ${runtime.url}`);
      }
    });
    return;
  }

  const bareInvocation = args.length === 0;
  await runWithDatabaseGuidance(async () => {
    const { runServer } = await import('./runServer.js');
    if (mode === 'legacy-mcp') {
      const { projectConfigPath } = await import('./projectSetup.js');
      console.error(`Project configuration: ${projectConfigPath()}`);
      console.error('Enabled modules: knowledge, issues (legacy catalog)');
      await runServer({ catalogMode: 'legacy' });
    } else {
      const { readProjectConfig, projectConfigPath } = await import('./projectSetup.js');
      const configPath = projectConfigPath();
      const project = process.env.HORIZONLAYER_MODULES ? null : await readProjectConfig();
      if (process.env.HORIZONLAYER_MODULES) {
        console.error(`Project configuration: ${configPath} (overridden by HORIZONLAYER_MODULES)`);
        console.error(`Enabled modules: ${process.env.HORIZONLAYER_MODULES}`);
      } else if (project) {
        console.error(`Project configuration: ${configPath}`);
        console.error(`Enabled modules: ${project.modules.join(', ')}`);
      } else {
        console.error(`Project configuration: ${configPath} (missing, using defaults)`);
        console.error('Enabled modules: knowledge, issues');
      }
      await runServer({ catalogMode: 'modules', modules: project?.modules });
    }
    if (bareInvocation) {
      console.error('HorizonLayer MCP server is ready and listening on stdio.');
    }
  });
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal error: ${message}`);
    process.exit(1);
  });
}
