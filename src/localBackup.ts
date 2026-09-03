import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { chmod, lstat, mkdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { z } from 'zod';
import {
  BACKUP_EXTENSION,
  createBackupArtifact,
  inspectBackupArtifact,
  type BackupArtifactInspection,
} from './backupArtifact.js';
import {
  bundledComposePath,
  ensureDockerDesktopReady,
  hasExplicitRuntimeOverride,
  localRuntimeConfigPath,
  readLocalRuntimeConfig,
  runtimeEnvironment,
  withLocalRuntimeLifecycleLock,
  type LocalRuntimeConfig,
} from './localRuntime.js';
import {
  withDeferredSignalInterruption,
  type SignalHost,
} from './processInterruption.js';

const packageVersion = z.string().regex(/^\d+\.\d+\.\d+$/u)
  .parse(createRequire(import.meta.url)('../package.json').version);
const MAX_CAPTURE_BYTES = 64 * 1024;

const { Client } = pg;

export interface ManagedBackupResult extends BackupArtifactInspection {
  configurationPath: string;
}

export interface ManagedBackupOptions {
  cwd?: string;
  destination?: string;
  environment?: NodeJS.ProcessEnv;
}

interface PostgreSqlMetadata {
  pgDumpVersion: string;
  serverMajor: 17;
  serverVersion: string;
}

export interface ManagedBackupDependencies {
  createArtifact: typeof createBackupArtifact;
  dumpDatabase: (
    config: LocalRuntimeConfig,
    path: string,
    environment: NodeJS.ProcessEnv
  ) => Promise<void>;
  ensureDocker: () => Promise<void>;
  inspectArtifact: typeof inspectBackupArtifact;
  inspectPostgreSql: (
    config: LocalRuntimeConfig,
    environment: NodeJS.ProcessEnv
  ) => Promise<PostgreSqlMetadata>;
  now: () => Date;
  randomId: () => string;
  readConfig: typeof readLocalRuntimeConfig;
  startDatabase: (
    config: LocalRuntimeConfig,
    environment: NodeJS.ProcessEnv
  ) => Promise<void>;
  validateDatabaseDump: (
    config: LocalRuntimeConfig,
    path: string,
    environment: NodeJS.ProcessEnv
  ) => Promise<void>;
  waitForDatabase: (config: LocalRuntimeConfig) => Promise<void>;
  withInterruptionGuard: <T>(
    operation: (checkInterruption: () => void) => Promise<T>
  ) => Promise<T>;
  withLifecycleLock: typeof withLocalRuntimeLifecycleLock;
}

export class LocalBackupError extends Error {
  constructor(message: string, readonly details?: string) {
    super(message);
    this.name = 'LocalBackupError';
  }
}

async function withInterruptionGuard<T>(
  operation: (checkInterruption: () => void) => Promise<T>,
  signalHost: SignalHost = process
): Promise<T> {
  return withDeferredSignalInterruption(
    operation,
    (signal) => new LocalBackupError(
      `Managed Backup was interrupted by ${signal}; no final Backup was published. `
      + 'Sensitive temporary files were cleaned up; run `horizonlayer doctor` before retrying.'
    ),
    signalHost
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizedTimestamp(date: Date): string {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.', '');
}

export function defaultBackupDirectory(configurationPath: string): string {
  return join(dirname(configurationPath), 'backups');
}

export function defaultBackupPath(
  configurationPath: string,
  now: Date,
  randomId: string
): string {
  return join(
    defaultBackupDirectory(configurationPath),
    `horizonlayer-backup-${sanitizedTimestamp(now)}-${randomId.slice(0, 8)}${BACKUP_EXTENSION}`
  );
}

function resolveDestination(
  options: ManagedBackupOptions,
  configurationPath: string,
  now: Date,
  randomId: string
): { defaultDirectory: boolean; path: string } {
  if (options.destination == null) {
    return {
      defaultDirectory: true,
      path: defaultBackupPath(configurationPath, now, randomId),
    };
  }
  if (options.destination === '-') {
    throw new LocalBackupError('Backup output must be a file; stdout is not supported.');
  }
  const path = isAbsolute(options.destination)
    ? options.destination
    : resolve(options.cwd ?? process.cwd(), options.destination);
  if (!path.endsWith(BACKUP_EXTENSION)) {
    throw new LocalBackupError(`Backup destination must end with ${BACKUP_EXTENSION}.`);
  }
  return { defaultDirectory: false, path };
}

async function prepareDestination(destination: { defaultDirectory: boolean; path: string }): Promise<void> {
  const parent = dirname(destination.path);
  if (destination.defaultDirectory) {
    await mkdir(parent, { mode: 0o700, recursive: true });
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new LocalBackupError(`Managed Backup directory is not a regular directory: ${parent}.`);
    }
    if (process.platform !== 'win32') await chmod(parent, 0o700);
  } else {
    try {
      const parentStat = await stat(parent);
      if (!parentStat.isDirectory()) {
        throw new LocalBackupError(`Backup parent is not a directory: ${parent}.`);
      }
    } catch (error) {
      if (error instanceof LocalBackupError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new LocalBackupError(
          `Backup parent directory does not exist: ${parent}. Create it first.`
        );
      }
      throw new LocalBackupError(`Cannot access Backup parent directory: ${parent}.`, errorMessage(error));
    }
  }
  try {
    await lstat(destination.path);
    throw new LocalBackupError(
      `Backup destination already exists: ${destination.path}. Choose a new path.`
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function composeExecArgs(config: LocalRuntimeConfig, command: string[]): string[] {
  return [
    'compose',
    '-f',
    bundledComposePath(),
    '-p',
    config.compose_project,
    'exec',
    '-T',
    'db',
    ...command,
  ];
}

function composeStartDatabaseArgs(config: LocalRuntimeConfig): string[] {
  return [
    'compose',
    '-f',
    bundledComposePath(),
    '-p',
    config.compose_project,
    'up',
    '-d',
    'db',
  ];
}

export interface ProcessResult {
  stderr: string;
  stdout: string;
}

async function collect(stream: ReadStream | NodeJS.ReadableStream): Promise<string> {
  let value = '';
  let truncated = false;
  for await (const chunk of stream) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(value);
    if (remaining > 0) value += Buffer.from(text).subarray(0, remaining).toString('utf8');
    if (Buffer.byteLength(text) > remaining) truncated = true;
  }
  return truncated ? `${value}\n[output truncated]` : value;
}

export type BackupProcessRunner = (params: {
  args: string[];
  command: string;
  environment: NodeJS.ProcessEnv;
  stdinPath?: string;
  stdinStart?: number;
  stdout?: 'capture' | 'ignore';
  stdoutPath?: string;
}) => Promise<ProcessResult>;

async function runProcess(params: Parameters<BackupProcessRunner>[0]): Promise<ProcessResult> {
  const child = spawn(params.command, params.args, {
    env: params.environment,
    shell: false,
    stdio: [params.stdinPath ? 'pipe' : 'ignore', params.stdout === 'ignore' ? 'ignore' : 'pipe', 'pipe'],
  });
  const stderrPromise = collect(child.stderr!);
  let stdoutPromise: Promise<string> = Promise.resolve('');
  let ioError: unknown;

  if (params.stdoutPath) {
    stdoutPromise = pipelineToFile(child.stdout!, params.stdoutPath).then(() => '');
  } else if (params.stdout === 'capture') {
    stdoutPromise = collect(child.stdout!);
  }
  const stdinPromise = params.stdinPath
    ? import('node:stream/promises').then(({ pipeline }) => pipeline(
      createReadStream(params.stdinPath!, params.stdinStart == null
        ? undefined
        : { start: params.stdinStart }),
      child.stdin!
    ))
    : Promise.resolve();

  const ioPromise = Promise.all([stdoutPromise, stdinPromise]).catch((error: unknown) => {
    ioError = error;
    child.kill('SIGTERM');
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  }).catch((error: unknown) => {
    throw new LocalBackupError(`Cannot start ${params.command}.`, errorMessage(error));
  });
  await ioPromise;
  const [stdout, stderr] = await Promise.all([stdoutPromise.catch(() => ''), stderrPromise]);
  if (ioError) throw new LocalBackupError('Managed Backup stream failed.', errorMessage(ioError));
  if (exit.code !== 0) {
    throw new LocalBackupError(
      `Managed Backup command failed${exit.signal ? ` after ${exit.signal}` : ''}.`,
      stderr.trim()
    );
  }
  return { stderr, stdout };
}

async function startDatabase(
  config: LocalRuntimeConfig,
  environment: NodeJS.ProcessEnv,
  runner: BackupProcessRunner = runProcess
): Promise<void> {
  await runner({
    args: composeStartDatabaseArgs(config),
    command: 'docker',
    environment: { ...process.env, ...environment, ...runtimeEnvironment(config) },
    stdout: 'ignore',
  });
}

async function pipelineToFile(stream: NodeJS.ReadableStream, path: string): Promise<void> {
  const { pipeline } = await import('node:stream/promises');
  await pipeline(stream, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
}

function processEnvironment(
  config: LocalRuntimeConfig,
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return { ...environment, ...runtimeEnvironment(config) };
}

async function dumpDatabase(
  config: LocalRuntimeConfig,
  path: string,
  environment: NodeJS.ProcessEnv,
  runner: BackupProcessRunner = runProcess
): Promise<void> {
  const result = await runner({
    args: composeExecArgs(config, [
      'pg_dump',
      '--format=custom',
      '--no-password',
      '--username',
      config.database_user,
      '--dbname',
      config.database_name,
    ]),
    command: 'docker',
    environment: processEnvironment(config, environment),
    stdoutPath: path,
  });
  if (result.stderr.trim()) {
    throw new LocalBackupError('pg_dump reported warnings; no Backup was published.', result.stderr.trim());
  }
}

async function validateDatabaseDump(
  config: LocalRuntimeConfig,
  path: string,
  environment: NodeJS.ProcessEnv,
  runner: BackupProcessRunner = runProcess
): Promise<void> {
  const result = await runner({
    args: composeExecArgs(config, ['pg_restore', '--list']),
    command: 'docker',
    environment: processEnvironment(config, environment),
    stdinPath: path,
    stdout: 'ignore',
  });
  if (result.stderr.trim()) {
    throw new LocalBackupError(
      'pg_restore could not validate the Backup cleanly; no Backup was published.',
      result.stderr.trim()
    );
  }
}

async function inspectPostgreSql(
  config: LocalRuntimeConfig,
  environment: NodeJS.ProcessEnv,
  runner: BackupProcessRunner = runProcess
): Promise<PostgreSqlMetadata> {
  const commandEnvironment = processEnvironment(config, environment);
  const server = await runner({
    args: composeExecArgs(config, [
      'psql',
      '--no-password',
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--username',
      config.database_user,
      '--dbname',
      config.database_name,
      '--command',
      'SHOW server_version; SHOW server_version_num;',
    ]),
    command: 'docker',
    environment: commandEnvironment,
    stdout: 'capture',
  });
  const [serverVersion, serverVersionNumber] = server.stdout.trim().split(/\r?\n/u);
  const numericVersion = Number(serverVersionNumber);
  const serverMajor = Math.floor(numericVersion / 10_000);
  if (!serverVersion || !Number.isInteger(numericVersion) || serverMajor !== 17) {
    throw new LocalBackupError('Managed PostgreSQL version is unsupported for Backup.');
  }
  if (server.stderr.trim()) {
    throw new LocalBackupError('Cannot inspect managed PostgreSQL cleanly.', server.stderr.trim());
  }
  const dump = await runner({
    args: composeExecArgs(config, ['pg_dump', '--version']),
    command: 'docker',
    environment: commandEnvironment,
    stdout: 'capture',
  });
  const pgDumpVersion = dump.stdout.trim();
  if (!/^pg_dump \(PostgreSQL\) 17(?:\.|\s|$)/u.test(pgDumpVersion)) {
    throw new LocalBackupError('Managed pg_dump version is unsupported for Backup.');
  }
  if (dump.stderr.trim()) {
    throw new LocalBackupError('Cannot inspect managed pg_dump cleanly.', dump.stderr.trim());
  }
  return { pgDumpVersion, serverMajor: 17, serverVersion };
}

interface DatabaseProbeClient {
  connect: () => Promise<unknown>;
  end: () => Promise<void>;
}

async function canConnect(
  config: LocalRuntimeConfig,
  createClient: (options: ConstructorParameters<typeof Client>[0]) => DatabaseProbeClient = (options) => new Client(options)
): Promise<boolean> {
  const client = createClient({
    connectionString: runtimeEnvironment(config).DATABASE_URL,
    connectionTimeoutMillis: 1_000,
  });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function isQdrantReady(
  config: LocalRuntimeConfig,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  try {
    const response = await fetcher(new URL('/readyz', runtimeEnvironment(config).QDRANT_URL), {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServices(
  config: LocalRuntimeConfig,
  timeoutMs = 90_000,
  probes: {
    database: (config: LocalRuntimeConfig) => Promise<boolean>;
    qdrant: (config: LocalRuntimeConfig) => Promise<boolean>;
  } = { database: canConnect, qdrant: isQdrantReady },
  clock: () => number = Date.now,
  wait: (milliseconds: number) => Promise<unknown> = sleep
): Promise<void> {
  const deadline = clock() + timeoutMs;
  let databaseReady = false;
  let qdrantReady = false;
  while (clock() < deadline) {
    if (!databaseReady) databaseReady = await probes.database(config);
    if (!qdrantReady) qdrantReady = await probes.qdrant(config);
    if (databaseReady && qdrantReady) return;
    await wait(1_000);
  }
  throw new LocalBackupError(
    'Managed PostgreSQL and Qdrant did not become ready. Run `horizonlayer doctor`.'
  );
}

async function waitForDatabase(
  config: LocalRuntimeConfig,
  timeoutMs = 90_000,
  probe: (config: LocalRuntimeConfig) => Promise<boolean> = canConnect,
  clock: () => number = Date.now,
  wait: (milliseconds: number) => Promise<unknown> = sleep
): Promise<void> {
  const deadline = clock() + timeoutMs;
  while (clock() < deadline) {
    if (await probe(config)) return;
    await wait(1_000);
  }
  throw new LocalBackupError(
    'Managed PostgreSQL did not become ready for Backup. Run `horizonlayer doctor`.'
  );
}

const defaultDependencies: ManagedBackupDependencies = {
  createArtifact: createBackupArtifact,
  dumpDatabase,
  ensureDocker: ensureDockerDesktopReady,
  inspectArtifact: inspectBackupArtifact,
  inspectPostgreSql,
  now: () => new Date(),
  randomId: randomUUID,
  readConfig: readLocalRuntimeConfig,
  startDatabase,
  validateDatabaseDump,
  waitForDatabase,
  withInterruptionGuard,
  withLifecycleLock: withLocalRuntimeLifecycleLock,
};

export async function createManagedRuntimeBackup(
  options: ManagedBackupOptions = {},
  dependencyOverrides: Partial<ManagedBackupDependencies> = {}
): Promise<ManagedBackupResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const environment = options.environment ?? process.env;
  if (hasExplicitRuntimeOverride(environment)) {
    throw new LocalBackupError(
      'Managed Backup cannot run with a DATABASE_URL override. '
      + 'Unset it to target the saved Managed Local Runtime.'
    );
  }
  const configurationPath = localRuntimeConfigPath(environment);
  return dependencies.withInterruptionGuard((checkInterruption) => (
    dependencies.withLifecycleLock(async () => {
      checkInterruption();
      const config = await dependencies.readConfig(configurationPath);
      if (!config) {
        throw new LocalBackupError('HorizonLayer is not set up. Run `horizonlayer setup` first.');
      }
      const started = dependencies.now();
      const destination = resolveDestination(
        options,
        configurationPath,
        started,
        dependencies.randomId()
      );
      await prepareDestination(destination);
      const payloadPath = join(
        dirname(destination.path),
        `.${basename(destination.path)}.payload-${dependencies.randomId()}`
      );
      let artifactPublished = false;

      try {
        checkInterruption();
        await dependencies.ensureDocker();
        checkInterruption();
        await dependencies.startDatabase(config, environment);
        checkInterruption();
        await dependencies.waitForDatabase(config);
        checkInterruption();
        const postgresql = await dependencies.inspectPostgreSql(config, environment);
        checkInterruption();
        await dependencies.dumpDatabase(config, payloadPath, environment);
        checkInterruption();
        const completed = dependencies.now();
        await dependencies.validateDatabaseDump(config, payloadPath, environment);
        checkInterruption();
        await dependencies.createArtifact({
          destination: destination.path,
          manifest: {
            artifact: 'horizonlayer-backup',
            artifact_version: 1,
            completed_at: completed.toISOString(),
            contents: {
              canonical_knowledge: 'postgresql',
              derived_search_index_included: false,
            },
            horizonlayer_schema_version: 1,
            horizonlayer_version: packageVersion,
            postgresql: {
              pg_dump_version: postgresql.pgDumpVersion,
              server_major: postgresql.serverMajor,
              server_version: postgresql.serverVersion,
            },
            scope: 'managed-runtime',
            source_database: config.database_name,
            started_at: started.toISOString(),
          },
          payloadPath,
        });
        artifactPublished = true;
        // Publication is the commit point. A signal received after this point
        // must not turn a durable successful Backup into a reported failure.
        const inspection = await dependencies.inspectArtifact(destination.path);
        return { ...inspection, configurationPath };
      } catch (error) {
        if (artifactPublished) {
          await rm(destination.path, { force: true }).catch(() => undefined);
        }
        if (error instanceof LocalBackupError) throw error;
        throw new LocalBackupError(
          'Managed Backup failed; no final Backup was published.',
          errorMessage(error)
        );
      } finally {
        await rm(payloadPath, { force: true }).catch(() => undefined);
      }
    }, configurationPath)
  ));
}

export function formatManagedBackupReceipt(result: ManagedBackupResult): string {
  return [
    `Backup created: ${result.path}`,
    `Snapshot interval: ${result.manifest.started_at} to ${result.manifest.completed_at}`,
    `Size: ${result.manifest.payload.bytes} bytes`,
    `SHA-256: ${result.manifest.payload.sha256}`,
    `Artifact: v${result.manifest.artifact_version}; schema: ${result.manifest.horizonlayer_schema_version}; PostgreSQL: ${result.manifest.postgresql.server_version}`,
  ].join('\n');
}

export const localBackupInternals = {
  canConnect,
  collect,
  composeExecArgs,
  composeStartDatabaseArgs,
  dumpDatabase,
  inspectPostgreSql,
  isQdrantReady,
  prepareDestination,
  resolveDestination,
  runProcess,
  startDatabase,
  validateDatabaseDump,
  waitForDatabase,
  waitForServices,
  withInterruptionGuard,
};
