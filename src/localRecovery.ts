import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BACKUP_EXTENSION,
  createBackupPayloadStream,
  inspectBackupArtifact,
  type BackupArtifactInspection,
  type BackupManifest,
} from './backupArtifact.js';
import {
  createManagedRuntimeBackup,
  localBackupInternals,
  type BackupProcessRunner,
  type ManagedBackupDependencies,
  type ManagedBackupResult,
} from './localBackup.js';
import { DEFAULT_QDRANT_COLLECTION } from './search/constants.js';
import {
  bundledComposePath,
  ensureDockerDesktopReady,
  hasExplicitRuntimeOverride,
  localRuntimeConfigPath,
  readLocalRuntimeConfig,
  runCompose,
  runtimeEnvironment,
  withLocalRuntimeLifecycleLock,
  type LocalRuntimeConfig,
} from './localRuntime.js';
import {
  withDeferredSignalInterruption,
  type InterruptionCheck,
  type SignalHost,
} from './processInterruption.js';

const EXPECTED_CANONICAL_TABLES = [
  'agent_runs',
  'blocks',
  'database_properties',
  'database_row_values',
  'database_rows',
  'databases',
  'links',
  'pages',
  'run_checkpoints',
  'sessions',
  'workspace_search_changes',
  'workspaces',
] as const;

export interface ManagedRecoveryOptions {
  artifact: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface ManagedRecoveryPreview extends BackupArtifactInspection {
  composeProject: string;
  configurationPath: string;
}

export interface ManagedRecoveryResult {
  artifactPath: string;
  completedAt: string;
  configurationPath: string;
  manifest: BackupManifest;
  safetyBackupChecksum: string;
  safetyBackupPath: string;
}

interface StagedRecoveryArchive {
  inspection: BackupArtifactInspection;
  payloadPath: string;
}

interface RestoreArchiveResult {
  warnings: string;
}

interface RecoveryExecutionContext {
  artifactPath: string;
  configurationPath: string;
  environment: NodeJS.ProcessEnv;
  stagingDirectoryPath: string;
}

export interface ManagedRecoveryDependencies {
  clearDerivedSearchIndex: (
    config: LocalRuntimeConfig,
    environment: NodeJS.ProcessEnv
  ) => Promise<void>;
  createSafetyBackup: (environment: NodeJS.ProcessEnv) => Promise<ManagedBackupResult>;
  createStagingDirectory: (configurationPath: string) => Promise<string>;
  ensureDocker: () => Promise<void>;
  inspectArtifact: typeof inspectBackupArtifact;
  now: () => Date;
  randomId: () => string;
  readConfig: typeof readLocalRuntimeConfig;
  removeIsolatedDatabase: (
    containerName: string,
    environment: NodeJS.ProcessEnv
  ) => Promise<void>;
  removeStagingDirectory: (stagingDirectoryPath: string) => Promise<void>;
  restoreArchive: (
    config: LocalRuntimeConfig,
    containerName: string,
    archive: StagedRecoveryArchive,
    environment: NodeJS.ProcessEnv
  ) => Promise<RestoreArchiveResult>;
  stageArchive: (
    artifactPath: string,
    payloadPath: string
  ) => Promise<StagedRecoveryArchive>;
  startIsolatedDatabase: (
    config: LocalRuntimeConfig,
    containerName: string,
    environment: NodeJS.ProcessEnv
  ) => Promise<void>;
  startRuntime: (config: LocalRuntimeConfig) => Promise<void>;
  stopRuntime: (config: LocalRuntimeConfig) => Promise<void>;
  validateArchive: (
    config: LocalRuntimeConfig,
    archive: StagedRecoveryArchive,
    environment: NodeJS.ProcessEnv
  ) => Promise<void>;
  validateCanonicalKnowledge: (
    config: LocalRuntimeConfig,
    containerName: string,
    environment: NodeJS.ProcessEnv
  ) => Promise<void>;
  waitForRuntime: (config: LocalRuntimeConfig) => Promise<void>;
  withInterruptionGuard: <T>(
    operation: (checkInterruption: InterruptionCheck) => Promise<T>
  ) => Promise<T>;
  withLifecycleLock: typeof withLocalRuntimeLifecycleLock;
}

export class LocalRecoveryError extends Error {
  constructor(message: string, readonly details?: string) {
    super(message);
    this.name = 'LocalRecoveryError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeRecoveryCause(error: unknown): string {
  return error instanceof LocalRecoveryError ? ` Cause: ${error.message}` : '';
}

async function withInterruptionGuard<T>(
  operation: (checkInterruption: InterruptionCheck) => Promise<T>,
  signalHost: SignalHost = process
): Promise<T> {
  return withDeferredSignalInterruption(
    operation,
    (signal) => new LocalRecoveryError(
      `Runtime Recovery was interrupted by ${signal}; HorizonLayer will finish phase-specific `
      + 'cleanup before exit. Run `horizonlayer doctor` before retrying.'
    ),
    signalHost
  );
}

function resolveArtifactPath(options: ManagedRecoveryOptions): string {
  if (options.artifact === '-') {
    throw new LocalRecoveryError('Runtime Recovery requires a Backup file; stdin is not supported.');
  }
  if (!options.artifact.endsWith(BACKUP_EXTENSION)) {
    throw new LocalRecoveryError(`Runtime Recovery input must end with ${BACKUP_EXTENSION}.`);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(options.artifact)) {
    throw new LocalRecoveryError('Runtime Recovery accepts local Backup files only; URLs are not supported.');
  }
  return isAbsolute(options.artifact)
    ? options.artifact
    : resolve(options.cwd ?? process.cwd(), options.artifact);
}

function processEnvironment(
  config: LocalRuntimeConfig,
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return { ...environment, ...runtimeEnvironment(config) };
}

function composeArgs(config: LocalRuntimeConfig, args: string[]): string[] {
  return [
    'compose',
    '-f',
    bundledComposePath(),
    '-p',
    config.compose_project,
    ...args,
  ];
}

async function runRecoveryProcess(
  params: Parameters<BackupProcessRunner>[0],
  runner: BackupProcessRunner = localBackupInternals.runProcess
) {
  try {
    return await runner(params);
  } catch (error) {
    throw new LocalRecoveryError('A Runtime Recovery command failed.', errorMessage(error));
  }
}

async function stageArchive(
  artifactPath: string,
  payloadPath: string
): Promise<StagedRecoveryArchive> {
  let inspection: BackupArtifactInspection;
  try {
    inspection = await inspectBackupArtifact(artifactPath);
  } catch (error) {
    throw new LocalRecoveryError(
      'Backup validation failed; current Canonical Knowledge was not changed. '
      + 'Use an intact, compatible Backup from a trusted source.',
      errorMessage(error)
    );
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  let created = false;
  try {
    const exclusive = await open(payloadPath, 'wx', 0o600);
    created = true;
    await exclusive.close();
    await pipeline(
      createBackupPayloadStream(inspection),
      verifier,
      createWriteStream(payloadPath, { flags: 'a', mode: 0o600 })
    );
    const handle = await open(payloadPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (created) await rm(payloadPath, { force: true }).catch(() => undefined);
    throw new LocalRecoveryError('Cannot stage the Backup payload for Runtime Recovery.', errorMessage(error));
  }

  const sha256 = hash.digest('hex');
  if (bytes !== inspection.manifest.payload.bytes
    || sha256 !== inspection.manifest.payload.sha256) {
    await rm(payloadPath, { force: true }).catch(() => undefined);
    throw new LocalRecoveryError(
      'The Backup changed while Runtime Recovery was preparing it; no data was changed.'
    );
  }
  return { inspection, payloadPath };
}

async function createStagingDirectory(configurationPath: string): Promise<string> {
  const path = await mkdtemp(join(dirname(configurationPath), '.recovery-'));
  if (process.platform !== 'win32') await chmod(path, 0o700);
  return path;
}

async function validateArchive(
  config: LocalRuntimeConfig,
  archive: StagedRecoveryArchive,
  environment: NodeJS.ProcessEnv,
  runner: BackupProcessRunner = localBackupInternals.runProcess
): Promise<void> {
  const result = await runRecoveryProcess({
    args: composeArgs(config, ['exec', '-T', 'db', 'pg_restore', '--list']),
    command: 'docker',
    environment: processEnvironment(config, environment),
    stdinPath: archive.payloadPath,
    stdout: 'ignore',
  }, runner);
  if (result.stderr.trim()) {
    throw new LocalRecoveryError(
      'pg_restore could not validate the Backup cleanly; no data was changed.',
      result.stderr.trim()
    );
  }
}

async function waitForIsolatedDatabase(
  config: LocalRuntimeConfig,
  containerName: string,
  environment: NodeJS.ProcessEnv,
  runner: BackupProcessRunner = localBackupInternals.runProcess,
  timeoutMs = 90_000,
  clock: () => number = Date.now,
  wait: (milliseconds: number) => Promise<unknown> = sleep
): Promise<void> {
  const deadline = clock() + timeoutMs;
  while (clock() < deadline) {
    try {
      await runRecoveryProcess({
        args: [
          'exec',
          containerName,
          'pg_isready',
          '--username',
          config.database_user,
          '--dbname',
          config.database_name,
        ],
        command: 'docker',
        environment: processEnvironment(config, environment),
        stdout: 'ignore',
      }, runner);
      return;
    } catch {
      await wait(1_000);
    }
  }
  throw new LocalRecoveryError(
    'The isolated PostgreSQL recovery container did not become ready. Published services remain stopped.'
  );
}

async function startIsolatedDatabase(
  config: LocalRuntimeConfig,
  containerName: string,
  environment: NodeJS.ProcessEnv,
  runner: BackupProcessRunner = localBackupInternals.runProcess
): Promise<void> {
  await runRecoveryProcess({
    args: composeArgs(config, [
      'run',
      '--detach',
      '--no-deps',
      '--no-TTY',
      '--name',
      containerName,
      'db',
    ]),
    command: 'docker',
    environment: processEnvironment(config, environment),
    stdout: 'capture',
  }, runner);
  await waitForIsolatedDatabase(config, containerName, environment, runner);
}

async function removeIsolatedDatabase(
  containerName: string,
  environment: NodeJS.ProcessEnv,
  runner: BackupProcessRunner = localBackupInternals.runProcess
): Promise<void> {
  await runRecoveryProcess({
    args: ['rm', '--force', containerName],
    command: 'docker',
    environment,
    stdout: 'ignore',
  }, runner);
}

async function restoreArchive(
  config: LocalRuntimeConfig,
  containerName: string,
  archive: StagedRecoveryArchive,
  environment: NodeJS.ProcessEnv,
  runner: BackupProcessRunner = localBackupInternals.runProcess
): Promise<RestoreArchiveResult> {
  const result = await runRecoveryProcess({
    args: [
      'exec',
      '-i',
      containerName,
      'pg_restore',
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-acl',
      '--single-transaction',
      '--exit-on-error',
      '--no-password',
      '--username',
      config.database_user,
      '--dbname',
      config.database_name,
    ],
    command: 'docker',
    environment: processEnvironment(config, environment),
    stdinPath: archive.payloadPath,
    stdout: 'ignore',
  }, runner);
  // A zero exit with --single-transaction means the transaction committed.
  // Return diagnostics so orchestration can mark that commit before deciding
  // whether warnings require the automatic safety rollback.
  return { warnings: result.stderr.trim() };
}

function canonicalValidationSql(): string {
  const names = EXPECTED_CANONICAL_TABLES.map((name) => `'${name}'`).join(', ');
  return [
    'DO $horizonlayer$',
    'DECLARE actual integer;',
    'BEGIN',
    '  SELECT count(*) INTO actual',
    '  FROM pg_catalog.pg_class AS relation',
    '  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace',
    `  WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p') AND relation.relname IN (${names});`,
    `  IF actual <> ${EXPECTED_CANONICAL_TABLES.length} THEN`,
    "    RAISE EXCEPTION 'HorizonLayer canonical schema validation failed: expected % tables, found %', "
      + `${EXPECTED_CANONICAL_TABLES.length}, actual;`,
    '  END IF;',
    'END',
    '$horizonlayer$;',
  ].join('\n');
}

async function validateCanonicalKnowledge(
  config: LocalRuntimeConfig,
  containerName: string,
  environment: NodeJS.ProcessEnv,
  runner: BackupProcessRunner = localBackupInternals.runProcess
): Promise<void> {
  const commandEnvironment = processEnvironment(config, environment);
  for (const command of ['ANALYZE;', canonicalValidationSql()]) {
    const result = await runRecoveryProcess({
      args: [
        'exec',
        containerName,
        'psql',
        '--no-password',
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=1',
        '--username',
        config.database_user,
        '--dbname',
        config.database_name,
        '--command',
        command,
      ],
      command: 'docker',
      environment: commandEnvironment,
      stdout: 'ignore',
    }, runner);
    if (result.stderr.trim()) {
      throw new LocalRecoveryError(
        'PostgreSQL reported warnings while validating recovered Canonical Knowledge.',
        result.stderr.trim()
      );
    }
  }
}

async function clearDerivedSearchIndex(
  config: LocalRuntimeConfig,
  environment: NodeJS.ProcessEnv,
  runner: BackupProcessRunner = localBackupInternals.runProcess,
  fetcher: typeof fetch = fetch,
  timeoutMs = 90_000,
  clock: () => number = Date.now,
  wait: (milliseconds: number) => Promise<unknown> = sleep
): Promise<void> {
  const commandEnvironment = processEnvironment(config, environment);
  await runRecoveryProcess({
    args: composeArgs(config, ['up', '-d', '--no-deps', 'qdrant']),
    command: 'docker',
    environment: commandEnvironment,
    stdout: 'ignore',
  }, runner);

  const qdrantUrl = runtimeEnvironment(config).QDRANT_URL!;
  const deadline = clock() + timeoutMs;
  let ready = false;
  while (clock() < deadline) {
    try {
      const response = await fetcher(new URL('/readyz', qdrantUrl), {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Retry until the managed Qdrant service reaches its readiness deadline.
    }
    await wait(1_000);
  }
  if (!ready) {
    throw new LocalRecoveryError(
      'Managed Qdrant did not become ready for Derived Search Index invalidation.'
    );
  }

  const collection = environment.QDRANT_COLLECTION?.trim() || DEFAULT_QDRANT_COLLECTION;
  const collectionUrl = new URL(`/collections/${encodeURIComponent(collection)}`, qdrantUrl);
  const deleted = await fetcher(collectionUrl, { method: 'DELETE' });
  if (!deleted.ok && deleted.status !== 404) {
    throw new LocalRecoveryError(
      `Managed Qdrant refused Derived Search Index deletion with HTTP ${deleted.status}.`
    );
  }
  const verification = await fetcher(collectionUrl);
  if (verification.status !== 404) {
    throw new LocalRecoveryError(
      'Managed Qdrant still exposes the Derived Search Index after deletion.'
    );
  }
}

const withoutLifecycleLock: ManagedBackupDependencies['withLifecycleLock'] = async (operation) => operation();

const defaultDependencies: ManagedRecoveryDependencies = {
  clearDerivedSearchIndex,
  createSafetyBackup: async (environment) => createManagedRuntimeBackup(
    { environment },
    { withLifecycleLock: withoutLifecycleLock }
  ),
  createStagingDirectory,
  ensureDocker: ensureDockerDesktopReady,
  inspectArtifact: inspectBackupArtifact,
  now: () => new Date(),
  randomId: randomUUID,
  readConfig: readLocalRuntimeConfig,
  removeIsolatedDatabase,
  removeStagingDirectory: async (stagingDirectoryPath) => rm(
    stagingDirectoryPath,
    { recursive: true, force: true }
  ),
  restoreArchive,
  stageArchive,
  startIsolatedDatabase,
  startRuntime: async (config) => runCompose('start', config),
  stopRuntime: async (config) => runCompose('stop', config),
  validateArchive,
  validateCanonicalKnowledge,
  waitForRuntime: localBackupInternals.waitForServices,
  withInterruptionGuard,
  withLifecycleLock: withLocalRuntimeLifecycleLock,
};

function isolatedContainerName(randomId: string): string {
  return `horizonlayer-recovery-${randomId.replaceAll('-', '').slice(0, 24)}`;
}

async function tryResumeOriginalRuntime(
  config: LocalRuntimeConfig,
  context: RecoveryExecutionContext,
  dependencies: ManagedRecoveryDependencies,
  isolatedContainer: string | null,
  verifyCanonicalKnowledge: boolean
): Promise<string | null> {
  const failures: string[] = [];
  if (isolatedContainer && verifyCanonicalKnowledge) {
    try {
      await dependencies.validateCanonicalKnowledge(
        config,
        isolatedContainer,
        context.environment
      );
    } catch (error) {
      failures.push(`preserved database validation: ${errorMessage(error)}`);
    }
  }
  if (isolatedContainer) {
    try {
      await dependencies.removeIsolatedDatabase(isolatedContainer, context.environment);
    } catch (error) {
      failures.push(`isolated cleanup: ${errorMessage(error)}`);
    }
  }
  if (failures.length === 0) {
    try {
      await dependencies.startRuntime(config);
      await dependencies.waitForRuntime(config);
    } catch (error) {
      failures.push(`runtime restart: ${errorMessage(error)}`);
    }
  }
  return failures.length === 0 ? null : failures.join('; ');
}

async function rollbackAfterCommit(
  config: LocalRuntimeConfig,
  safetyArchive: StagedRecoveryArchive,
  context: RecoveryExecutionContext,
  dependencies: ManagedRecoveryDependencies,
  currentIsolatedContainer: string | null
): Promise<void> {
  await dependencies.stopRuntime(config);
  if (currentIsolatedContainer) {
    await dependencies.removeIsolatedDatabase(currentIsolatedContainer, context.environment);
  }
  const rollbackContainer = isolatedContainerName(dependencies.randomId());
  try {
    await dependencies.startIsolatedDatabase(config, rollbackContainer, context.environment);
    const rollbackRestore = await dependencies.restoreArchive(
      config,
      rollbackContainer,
      safetyArchive,
      context.environment
    );
    if (rollbackRestore.warnings) {
      throw new LocalRecoveryError(
        'pg_restore reported warnings while applying the safety Backup.',
        rollbackRestore.warnings
      );
    }
    await dependencies.validateCanonicalKnowledge(
      config,
      rollbackContainer,
      context.environment
    );
    await dependencies.clearDerivedSearchIndex(config, context.environment);
    await dependencies.removeIsolatedDatabase(rollbackContainer, context.environment);
    await dependencies.startRuntime(config);
    await dependencies.waitForRuntime(config);
  } catch (error) {
    await dependencies.stopRuntime(config).catch(() => undefined);
    // The create command can succeed even if readiness fails, so always make
    // a best-effort removal of the exact named rollback container.
    await dependencies.removeIsolatedDatabase(rollbackContainer, context.environment)
      .catch(() => undefined);
    throw error;
  }
}

async function executeRecovery(
  config: LocalRuntimeConfig,
  context: RecoveryExecutionContext,
  dependencies: ManagedRecoveryDependencies,
  checkInterruption: InterruptionCheck
): Promise<ManagedRecoveryResult> {
  const incoming = await dependencies.stageArchive(
    context.artifactPath,
    join(context.stagingDirectoryPath, 'incoming.dump')
  );
  checkInterruption();
  await dependencies.ensureDocker();
  checkInterruption();
  await dependencies.startRuntime(config);
  checkInterruption();
  await dependencies.waitForRuntime(config);
  checkInterruption();
  await dependencies.validateArchive(config, incoming, context.environment);
  checkInterruption();

  const safetyBackup = await dependencies.createSafetyBackup(context.environment);
  checkInterruption();
  const safety = await dependencies.stageArchive(
    safetyBackup.path,
    join(context.stagingDirectoryPath, 'safety.dump')
  );
  checkInterruption();
  await dependencies.validateArchive(config, safety, context.environment);
  checkInterruption();

  let isolatedContainer: string | null = null;
  let replacementValidated = false;
  let restoreAttempted = false;
  let targetCommitted = false;
  try {
    await dependencies.stopRuntime(config);
    checkInterruption();
    isolatedContainer = isolatedContainerName(dependencies.randomId());
    await dependencies.startIsolatedDatabase(config, isolatedContainer, context.environment);
    checkInterruption();
    restoreAttempted = true;
    const targetRestore = await dependencies.restoreArchive(
      config,
      isolatedContainer,
      incoming,
      context.environment
    );
    targetCommitted = true;
    if (targetRestore.warnings) {
      throw new LocalRecoveryError(
        'pg_restore reported warnings after the requested Backup committed.',
        targetRestore.warnings
      );
    }
    checkInterruption();
    await dependencies.validateCanonicalKnowledge(config, isolatedContainer, context.environment);
    checkInterruption();
    await dependencies.clearDerivedSearchIndex(config, context.environment);
    replacementValidated = true;
    checkInterruption();
    await dependencies.removeIsolatedDatabase(isolatedContainer, context.environment);
    isolatedContainer = null;
    checkInterruption();
    await dependencies.startRuntime(config);
    checkInterruption();
    await dependencies.waitForRuntime(config);
    checkInterruption();
    return {
      artifactPath: context.artifactPath,
      completedAt: dependencies.now().toISOString(),
      configurationPath: context.configurationPath,
      manifest: incoming.inspection.manifest,
      safetyBackupChecksum: safetyBackup.manifest.payload.sha256,
      safetyBackupPath: safetyBackup.path,
    };
  } catch (recoveryFailure) {
    if (replacementValidated) {
      let cleanupFailure: string | null = null;
      if (isolatedContainer) {
        try {
          await dependencies.removeIsolatedDatabase(isolatedContainer, context.environment);
        } catch (error) {
          cleanupFailure = errorMessage(error);
        }
      }
      throw new LocalRecoveryError(
        'Runtime Recovery committed and validated the requested Backup, but the managed runtime did not '
        + 'return to healthy service. The valid recovered data and safety Backup were preserved; automatic '
        + 'rollback was not attempted. Run `horizonlayer doctor`, then `horizonlayer setup`. '
        + `Requested Backup: ${context.artifactPath}. Safety Backup: ${safetyBackup.path}.`,
        [
          errorMessage(recoveryFailure),
          cleanupFailure ? `isolated cleanup: ${cleanupFailure}` : null,
        ].filter(Boolean).join('; ')
      );
    }
    if (!targetCommitted) {
      const resumeFailure = await tryResumeOriginalRuntime(
        config,
        context,
        dependencies,
        isolatedContainer,
        restoreAttempted
      );
      if (resumeFailure) {
        throw new LocalRecoveryError(
          'Runtime Recovery failed before commit, so existing Canonical Knowledge was preserved, '
          + 'but the managed runtime could not be restarted automatically. '
          + 'Run `horizonlayer doctor`, then `horizonlayer setup` after checking that no recovery container remains. '
          + `Requested Backup: ${context.artifactPath}. Safety Backup: ${safetyBackup.path}.`,
          `${errorMessage(recoveryFailure)}; ${resumeFailure}`
        );
      }
      checkInterruption();
      throw new LocalRecoveryError(
        'Runtime Recovery failed before commit; existing Canonical Knowledge was preserved and the '
        + `managed runtime was restarted. Requested Backup: ${context.artifactPath}. `
        + `Safety Backup retained: ${safetyBackup.path}.${safeRecoveryCause(recoveryFailure)} `
        + 'Correct the reported cause before retrying.',
        errorMessage(recoveryFailure)
      );
    }

    try {
      await rollbackAfterCommit(
        config,
        safety,
        context,
        dependencies,
        isolatedContainer
      );
      checkInterruption();
    } catch (rollbackFailure) {
      if (rollbackFailure instanceof LocalRecoveryError
        && rollbackFailure.message.includes('was interrupted by')) {
        throw rollbackFailure;
      }
      throw new LocalRecoveryError(
        'Runtime Recovery and automatic safety rollback both failed. Published services remain stopped. '
        + 'Do not start clients or run setup; retain both artifacts and inspect the isolated PostgreSQL/Docker logs. '
        + `Requested Backup: ${context.artifactPath}. Safety Backup: ${safetyBackup.path}.`,
        `Recovery failure: ${errorMessage(recoveryFailure)}; rollback failure: ${errorMessage(rollbackFailure)}`
      );
    }
    throw new LocalRecoveryError(
      'Runtime Recovery failed after commit; automatic rollback restored the retained safety Backup, '
      + 'cleared the Derived Search Index, and restarted the managed runtime. '
      + `Requested Backup: ${context.artifactPath}. Safety Backup: ${safetyBackup.path}. `
      + `${safeRecoveryCause(recoveryFailure)} `
      + 'Correct the requested Backup or reported validation problem before retrying.',
      errorMessage(recoveryFailure)
    );
  }
}

export async function previewManagedRuntimeRecovery(
  options: ManagedRecoveryOptions,
  dependencyOverrides: Pick<
    Partial<ManagedRecoveryDependencies>,
    'inspectArtifact' | 'readConfig'
  > = {}
): Promise<ManagedRecoveryPreview> {
  const environment = options.environment ?? process.env;
  if (hasExplicitRuntimeOverride(environment)) {
    throw new LocalRecoveryError(
      'Runtime Recovery cannot run with DATABASE_URL, QDRANT_URL, or RAG_ENABLED overrides. '
      + 'Unset them to preview the saved Managed Local Runtime target.'
    );
  }
  const artifactPath = resolveArtifactPath(options);
  const configurationPath = localRuntimeConfigPath(environment);
  const inspectArtifact = dependencyOverrides.inspectArtifact ?? defaultDependencies.inspectArtifact;
  const readConfig = dependencyOverrides.readConfig ?? defaultDependencies.readConfig;
  const config = await readConfig(configurationPath);
  if (!config) {
    throw new LocalRecoveryError('HorizonLayer is not set up. Run `horizonlayer setup` first.');
  }
  let inspection: BackupArtifactInspection;
  try {
    inspection = await inspectArtifact(artifactPath);
  } catch (error) {
    throw new LocalRecoveryError(
      'Backup validation failed; this read-only preview made no changes. '
      + 'Use an intact, compatible Backup from a trusted source.',
      errorMessage(error)
    );
  }
  return {
    ...inspection,
    composeProject: config.compose_project,
    configurationPath,
    path: artifactPath,
  };
}

export async function recoverManagedRuntime(
  options: ManagedRecoveryOptions,
  dependencyOverrides: Partial<ManagedRecoveryDependencies> = {}
): Promise<ManagedRecoveryResult> {
  const environment = options.environment ?? process.env;
  if (hasExplicitRuntimeOverride(environment)) {
    throw new LocalRecoveryError(
      'Runtime Recovery cannot run with DATABASE_URL, QDRANT_URL, or RAG_ENABLED overrides. '
      + 'Unset them to target the saved Managed Local Runtime.'
    );
  }
  const artifactPath = resolveArtifactPath(options);
  const configurationPath = localRuntimeConfigPath(environment);
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  return dependencies.withInterruptionGuard((checkInterruption) => (
    dependencies.withLifecycleLock(async () => {
      checkInterruption();
      const config = await dependencies.readConfig(configurationPath);
      if (!config) {
        throw new LocalRecoveryError('HorizonLayer is not set up. Run `horizonlayer setup` first.');
      }
      const stagingDirectoryPath = await dependencies.createStagingDirectory(configurationPath);
      const context = { artifactPath, configurationPath, environment, stagingDirectoryPath };
      let result: ManagedRecoveryResult | undefined;
      let operationFailure: unknown;
      try {
        result = await executeRecovery(config, context, dependencies, checkInterruption);
      } catch (error) {
        operationFailure = error instanceof LocalRecoveryError
          ? error
          : new LocalRecoveryError(
            'Runtime Recovery stopped before current Canonical Knowledge was changed. '
            + 'Correct the reported Backup, Docker, or managed-runtime problem and retry.',
            errorMessage(error)
          );
      }

      let cleanupFailure: unknown;
      try {
        await dependencies.removeStagingDirectory(stagingDirectoryPath);
      } catch (error) {
        cleanupFailure = error;
      }
      if (operationFailure) {
        if (cleanupFailure) {
          const base = operationFailure instanceof Error
            ? operationFailure
            : new LocalRecoveryError(errorMessage(operationFailure));
          throw new LocalRecoveryError(
            `${base.message} Sensitive recovery staging also remains at ${stagingDirectoryPath}.`,
            [
              'details' in base && typeof base.details === 'string' ? base.details : undefined,
              `cleanup failure: ${errorMessage(cleanupFailure)}`,
            ].filter(Boolean).join('; ')
          );
        }
        throw operationFailure;
      }
      if (cleanupFailure) {
        throw new LocalRecoveryError(
          `Runtime Recovery completed, but sensitive recovery staging remains at ${stagingDirectoryPath}. Remove it manually.`,
          errorMessage(cleanupFailure)
        );
      }
      checkInterruption();
      return result!;
    }, configurationPath)
  ));
}

function confirmationCommand(
  artifactPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') return `horizonlayer recover ${JSON.stringify(artifactPath)} --yes`;
  const quoted = `'${artifactPath.replaceAll("'", "'\"'\"'")}'`;
  return `horizonlayer recover ${quoted} --yes`;
}

export function formatManagedRecoveryPreview(preview: ManagedRecoveryPreview): string {
  return [
    'Runtime Recovery preview — no changes were made.',
    `Backup: ${preview.path}`,
    `Snapshot interval: ${preview.manifest.started_at} to ${preview.manifest.completed_at}`,
    `Payload: ${preview.manifest.payload.bytes} bytes; SHA-256: ${preview.manifest.payload.sha256}`,
    `Compatibility: artifact v${preview.manifest.artifact_version}; scope ${preview.manifest.scope}; schema ${preview.manifest.horizonlayer_schema_version}; HorizonLayer ${preview.manifest.horizonlayer_version}; PostgreSQL ${preview.manifest.postgresql.server_version}`,
    `Target configuration: ${preview.configurationPath}`,
    `Target Compose project: ${preview.composeProject}`,
    'Canonical Knowledge: PostgreSQL included.',
    'Derived Search Index: excluded; successful recovery clears it for lazy rebuild.',
    'Safety: confirmed recovery retains an automatic Backup and stops published services during replacement.',
    'Trust warning: this sensitive Backup contains executable database definitions; recover only an artifact from a trusted source.',
    `Exact confirmation command: ${confirmationCommand(preview.path)}`,
  ].join('\n');
}

export function formatManagedRecoveryReceipt(result: ManagedRecoveryResult): string {
  return [
    `Runtime Recovery completed: ${result.artifactPath}`,
    `Source SHA-256: ${result.manifest.payload.sha256}`,
    `Recovered snapshot: ${result.manifest.started_at} to ${result.manifest.completed_at}`,
    `Safety Backup retained: ${result.safetyBackupPath}`,
    `Safety SHA-256: ${result.safetyBackupChecksum}`,
    `Completed: ${result.completedAt}`,
    'Derived Search Index: cleared; semantic search rebuilds it lazily from Canonical Knowledge.',
    `Service health: PostgreSQL ready; Qdrant ready. Configuration: ${result.configurationPath}`,
  ].join('\n');
}

export const localRecoveryInternals = {
  canonicalValidationSql,
  clearDerivedSearchIndex,
  composeArgs,
  confirmationCommand,
  createStagingDirectory,
  isolatedContainerName,
  removeIsolatedDatabase,
  resolveArtifactPath,
  restoreArchive,
  runRecoveryProcess,
  stageArchive,
  startIsolatedDatabase,
  validateArchive,
  validateCanonicalKnowledge,
  waitForIsolatedDatabase,
  withInterruptionGuard,
};
