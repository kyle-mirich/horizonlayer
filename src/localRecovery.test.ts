import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBackupArtifact,
  type BackupArtifactInspection,
  type BackupManifest,
  type BackupManifestInput,
} from './backupArtifact.js';
import type { ManagedBackupResult } from './localBackup.js';
import {
  formatManagedRecoveryPreview,
  formatManagedRecoveryReceipt,
  localRecoveryInternals,
  previewManagedRuntimeRecovery,
  recoverManagedRuntime,
  type ManagedRecoveryDependencies,
} from './localRecovery.js';
import type { LocalRuntimeConfig } from './localRuntime.js';

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'horizonlayer-managed-recovery-'));
  temporaryPaths.push(directory);
  return directory;
}

const config: LocalRuntimeConfig = {
  compose_project: 'horizonlayer-test',
  database_name: 'horizon_layer',
  database_password: 'never-print-this-password',
  database_port: 55_432,
  database_user: 'postgres',
  qdrant_port: 56_333,
  version: 1,
};

const manifest: BackupManifest = {
  artifact: 'horizonlayer-backup',
  artifact_version: 1,
  completed_at: '2026-08-10T20:00:01.000Z',
  contents: {
    canonical_knowledge: 'postgresql',
    derived_search_index_included: false,
  },
  horizonlayer_schema_version: 1,
  horizonlayer_version: '2.0.0',
  payload: {
    bytes: 19,
    format: 'postgresql-custom',
    sha256: 'a'.repeat(64),
  },
  postgresql: {
    pg_dump_version: 'pg_dump (PostgreSQL) 17.6',
    server_major: 17,
    server_version: '17.6',
  },
  scope: 'managed-runtime',
  source_database: 'horizon_layer',
  started_at: '2026-08-10T20:00:00.000Z',
};

function inspection(path: string): BackupArtifactInspection {
  return { manifest, path, payloadOffset: 256 };
}

function safetyBackup(path = '/runtime/backups/safety.hlbackup'): ManagedBackupResult {
  return {
    ...inspection(path),
    configurationPath: '/runtime/runtime.json',
  };
}

function dependencies(
  order: string[],
  overrides: Partial<ManagedRecoveryDependencies> = {}
): ManagedRecoveryDependencies {
  let randomIndex = 0;
  return {
    clearDerivedSearchIndex: async () => {
      order.push('clear-index');
    },
    createSafetyBackup: async () => {
      order.push('safety-backup');
      return safetyBackup();
    },
    createStagingDirectory: async () => {
      order.push('workspace');
      return '/runtime/recovery-workspace';
    },
    ensureDocker: async () => {
      order.push('docker');
    },
    inspectArtifact: async (path) => inspection(path),
    now: () => new Date('2026-08-10T20:05:00.000Z'),
    randomId: () => ['target-id', 'rollback-id'][randomIndex++] ?? `id-${randomIndex}`,
    readConfig: async () => {
      order.push('config');
      return config;
    },
    removeIsolatedDatabase: async (containerName) => {
      order.push(`remove:${containerName}`);
    },
    removeStagingDirectory: async () => {
      order.push('remove-workspace');
    },
    restoreArchive: async (_config, containerName, archive) => {
      order.push(`restore:${containerName}:${basename(archive.payloadPath)}`);
      return { warnings: '' };
    },
    stageArchive: async (path, payloadPath) => {
      order.push(`stage:${basename(path)}`);
      return { inspection: inspection(path), payloadPath };
    },
    startIsolatedDatabase: async (_config, containerName) => {
      order.push(`isolated:${containerName}`);
    },
    startRuntime: async () => {
      order.push('start');
    },
    stopRuntime: async () => {
      order.push('stop');
    },
    validateArchive: async (_config, archive) => {
      order.push(`validate-archive:${basename(archive.payloadPath)}`);
    },
    validateCanonicalKnowledge: async (_config, containerName) => {
      order.push(`validate-canonical:${containerName}`);
    },
    waitForRuntime: async () => {
      order.push('wait');
    },
    withInterruptionGuard: async (operation) => operation(() => undefined),
    withLifecycleLock: async (operation) => {
      order.push('lock');
      return operation();
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

describe('managed Runtime Recovery orchestration', () => {
  it('validates both archives before mutation, restores in isolation, clears derived state, and receipts success', async () => {
    const order: string[] = [];
    const result = await recoverManagedRuntime({
      artifact: 'incoming.hlbackup',
      cwd: '/requested',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order));

    expect(order).toEqual([
      'lock',
      'config',
      'workspace',
      'stage:incoming.hlbackup',
      'docker',
      'start',
      'wait',
      'validate-archive:incoming.dump',
      'safety-backup',
      'stage:safety.hlbackup',
      'validate-archive:safety.dump',
      'stop',
      'isolated:horizonlayer-recovery-targetid',
      'restore:horizonlayer-recovery-targetid:incoming.dump',
      'validate-canonical:horizonlayer-recovery-targetid',
      'clear-index',
      'remove:horizonlayer-recovery-targetid',
      'start',
      'wait',
      'remove-workspace',
    ]);
    expect(result).toMatchObject({
      artifactPath: '/requested/incoming.hlbackup',
      completedAt: '2026-08-10T20:05:00.000Z',
      configurationPath: '/runtime/runtime.json',
      manifest,
      safetyBackupChecksum: 'a'.repeat(64),
      safetyBackupPath: '/runtime/backups/safety.hlbackup',
    });
    const receipt = formatManagedRecoveryReceipt(result);
    expect(receipt).toContain('Runtime Recovery completed: /requested/incoming.hlbackup');
    expect(receipt).toContain('Safety Backup retained: /runtime/backups/safety.hlbackup');
    expect(receipt).toContain(`Source SHA-256: ${'a'.repeat(64)}`);
    expect(receipt).toContain('Completed: 2026-08-10T20:05:00.000Z');
    expect(receipt).toContain('PostgreSQL ready; Qdrant ready');
    expect(receipt).toContain('cleared; semantic search rebuilds it lazily');
    expect(receipt).not.toContain(config.database_password);
  });

  it('does not create a safety Backup or stop services when incoming validation fails', async () => {
    const order: string[] = [];
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order, {
      validateArchive: async () => {
        order.push('validate-archive:failed');
        throw new Error('invalid archive');
      },
    }))).rejects.toThrow('stopped before current canonical data was changed');
    expect(order).toEqual([
      'lock', 'config', 'workspace', 'stage:incoming.hlbackup', 'docker', 'start', 'wait',
      'validate-archive:failed', 'remove-workspace',
    ]);
  });

  it('does not enter the destructive window when Docker, health, safety Backup, or safety validation fails', async () => {
    const cases: Array<{
      name: string;
      overrides: (order: string[]) => Partial<ManagedRecoveryDependencies>;
    }> = [
      {
        name: 'Docker',
        overrides: (order) => ({
          ensureDocker: async () => {
            order.push('docker:failed');
            throw new Error('Docker unavailable');
          },
        }),
      },
      {
        name: 'runtime health',
        overrides: (order) => ({
          waitForRuntime: async () => {
            order.push('wait:failed');
            throw new Error('runtime unhealthy');
          },
        }),
      },
      {
        name: 'safety Backup',
        overrides: (order) => ({
          createSafetyBackup: async () => {
            order.push('safety-backup:failed');
            throw new Error('cannot publish safety Backup');
          },
        }),
      },
      {
        name: 'safety validation',
        overrides: (order) => {
          let validationCount = 0;
          return {
            validateArchive: async () => {
              validationCount += 1;
              order.push(`validate-archive:${validationCount}`);
              if (validationCount === 2) throw new Error('safety archive invalid');
            },
          };
        },
      },
    ];

    for (const testCase of cases) {
      const order: string[] = [];
      await expect(recoverManagedRuntime({
        artifact: '/requested/incoming.hlbackup',
        environment: { HORIZONLAYER_HOME: '/runtime' },
      }, dependencies(order, testCase.overrides(order))))
        .rejects.toThrow('before current canonical data was changed');
      expect(order, testCase.name).not.toContain('stop');
      expect(order, testCase.name).not.toContain('clear-index');
      expect(order.at(-1), testCase.name).toBe('remove-workspace');
    }

    const order: string[] = [];
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order, {
      withLifecycleLock: async () => {
        order.push('lock:busy');
        throw new Error('lifecycle lock busy');
      },
    }))).rejects.toThrow('lifecycle lock busy');
    expect(order).toEqual(['lock:busy']);
  });

  it('keeps existing canonical data and restarts services after a transactional restore failure', async () => {
    const order: string[] = [];
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order, {
      restoreArchive: async (_config, containerName, archive) => {
        order.push(`restore:${containerName}:${basename(archive.payloadPath)}`);
        throw new Error('restore transaction rolled back');
      },
    }))).rejects.toThrow('failed before commit; existing canonical data was preserved');
    expect(order.slice(-5)).toEqual([
      'validate-canonical:horizonlayer-recovery-targetid',
      'remove:horizonlayer-recovery-targetid',
      'start',
      'wait',
      'remove-workspace',
    ]);
    expect(order).not.toContain('clear-index');
  });

  it('automatically restores the safety Backup after post-commit validation fails', async () => {
    const order: string[] = [];
    let validationCount = 0;
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order, {
      validateCanonicalKnowledge: async (_config, containerName) => {
        order.push(`validate-canonical:${containerName}`);
        validationCount += 1;
        if (validationCount === 1) throw new Error('target validation failed');
      },
    }))).rejects.toThrow('automatic rollback restored the retained safety Backup');
    expect(order).toContain('restore:horizonlayer-recovery-rollbackid:safety.dump');
    expect(order).toContain('validate-canonical:horizonlayer-recovery-rollbackid');
    expect(order.filter((phase) => phase === 'clear-index')).toHaveLength(1);
    expect(order.slice(-4)).toEqual([
      'remove:horizonlayer-recovery-rollbackid',
      'start',
      'wait',
      'remove-workspace',
    ]);
  });

  it('treats diagnostics from a successfully committed target restore as a post-commit rollback trigger', async () => {
    const order: string[] = [];
    let restoreCount = 0;
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order, {
      restoreArchive: async (_config, containerName, archive) => {
        order.push(`restore:${containerName}:${basename(archive.payloadPath)}`);
        restoreCount += 1;
        return { warnings: restoreCount === 1 ? 'target warning' : '' };
      },
    }))).rejects.toThrow('automatic rollback restored');
    expect(order).toContain('restore:horizonlayer-recovery-rollbackid:safety.dump');
  });

  it('turns SIGINT or SIGTERM into phase-aware cleanup and rolls back an interrupted committed restore', async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const host = new EventEmitter();
      await expect(localRecoveryInternals.withInterruptionGuard(async (checkInterruption) => {
        host.emit(signal);
        checkInterruption();
      }, host)).rejects.toThrow(`interrupted by ${signal}`);
      expect(host.listenerCount('SIGINT')).toBe(0);
      expect(host.listenerCount('SIGTERM')).toBe(0);
    }

    const preCommitOrder: string[] = [];
    const preCommitHost = new EventEmitter();
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(preCommitOrder, {
      restoreArchive: async (_config, containerName, archive) => {
        preCommitOrder.push(`restore:${containerName}:${basename(archive.payloadPath)}`);
        if (archive.payloadPath.endsWith('incoming.dump')) {
          preCommitHost.emit('SIGINT');
          throw new Error('restore transaction rolled back');
        }
        return { warnings: '' };
      },
      withInterruptionGuard: async (operation) => localRecoveryInternals.withInterruptionGuard(
        operation,
        preCommitHost
      ),
    }))).rejects.toThrow('interrupted by SIGINT');
    expect(preCommitOrder.slice(-5)).toEqual([
      'validate-canonical:horizonlayer-recovery-targetid',
      'remove:horizonlayer-recovery-targetid',
      'start',
      'wait',
      'remove-workspace',
    ]);

    const order: string[] = [];
    const postCommitHost = new EventEmitter();
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order, {
      validateCanonicalKnowledge: async (_config, containerName) => {
        order.push(`validate-canonical:${containerName}`);
        if (containerName.includes('target')) postCommitHost.emit('SIGTERM');
      },
      withInterruptionGuard: async (operation) => localRecoveryInternals.withInterruptionGuard(
        operation,
        postCommitHost
      ),
    }))).rejects.toThrow('interrupted by SIGTERM');
    expect(order).toContain('restore:horizonlayer-recovery-rollbackid:safety.dump');

    const rollbackOrder: string[] = [];
    const rollbackHost = new EventEmitter();
    let clearCount = 0;
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(rollbackOrder, {
      clearDerivedSearchIndex: async () => {
        rollbackOrder.push('clear-index');
        clearCount += 1;
        if (clearCount === 1) throw new Error('force safety rollback');
      },
      restoreArchive: async (_config, containerName, archive) => {
        rollbackOrder.push(`restore:${containerName}:${basename(archive.payloadPath)}`);
        if (archive.payloadPath.endsWith('safety.dump')) rollbackHost.emit('SIGINT');
        return { warnings: '' };
      },
      withInterruptionGuard: async (operation) => localRecoveryInternals.withInterruptionGuard(
        operation,
        rollbackHost
      ),
    }))).rejects.toThrow('interrupted by SIGINT');
    expect(rollbackOrder).toContain('restore:horizonlayer-recovery-rollbackid:safety.dump');
    expect(rollbackOrder.slice(-3)).toEqual(['start', 'wait', 'remove-workspace']);
  });

  it('rolls back when Derived Search Index invalidation fails before publication', async () => {
    const order: string[] = [];
    let clearCount = 0;
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order, {
      clearDerivedSearchIndex: async () => {
        order.push('clear-index');
        clearCount += 1;
        if (clearCount === 1) throw new Error('clear failed');
      },
    }))).rejects.toThrow('automatic rollback restored');
    expect(order).toContain('restore:horizonlayer-recovery-rollbackid:safety.dump');
    expect(order.at(-1)).toBe('remove-workspace');
  });

  it('preserves a valid recovered commit instead of rolling back a later service-health failure', async () => {
    const order: string[] = [];
    let waitCount = 0;
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order, {
      waitForRuntime: async () => {
        order.push('wait');
        waitCount += 1;
        if (waitCount === 2) throw new Error('published validation failed');
      },
    }))).rejects.toThrow('valid recovered data and safety Backup were preserved');
    expect(order).not.toContain('restore:horizonlayer-recovery-rollbackid:safety.dump');
    expect(order.filter((phase) => phase === 'stop')).toHaveLength(1);
    expect(order.at(-1)).toBe('remove-workspace');
  });

  it('fails closed and reports both paths when automatic rollback also fails', async () => {
    const order: string[] = [];
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order, {
      restoreArchive: async (_config, containerName, archive) => {
        order.push(`restore:${containerName}:${basename(archive.payloadPath)}`);
        return { warnings: archive.payloadPath.endsWith('safety.dump') ? 'rollback warning' : '' };
      },
      validateCanonicalKnowledge: async (_config, containerName) => {
        order.push(`validate-canonical:${containerName}`);
        if (containerName.includes('target')) throw new Error('target validation failed');
      },
    }))).rejects.toMatchObject({
      message: expect.stringMatching(
        /both failed\. Published services remain stopped\.[\s\S]*Requested Backup: \/requested\/incoming\.hlbackup\. Safety Backup: \/runtime\/backups\/safety\.hlbackup\./u
      ),
    });
    expect(order.filter((phase) => phase === 'stop')).toHaveLength(3);
    expect(order.at(-1)).toBe('remove-workspace');
  });

  it('surfaces restart and sensitive-staging cleanup failures without hiding preserved data', async () => {
    const order: string[] = [];
    let startCount = 0;
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order, {
      removeStagingDirectory: async () => {
        order.push('remove-workspace:failed');
        throw new Error('permission denied');
      },
      restoreArchive: async () => {
        throw new Error('pre-commit failure');
      },
      startRuntime: async () => {
        order.push('start');
        startCount += 1;
        if (startCount === 2) throw new Error('restart failed');
      },
    }))).rejects.toThrow(
      'existing canonical data was preserved, but the managed runtime could not be restarted automatically'
    );
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies([], {
      removeStagingDirectory: async () => {
        throw new Error('permission denied');
      },
    }))).rejects.toThrow('sensitive recovery staging remains');
  });

  it('fails closed when a pre-commit recovery container cannot be removed safely', async () => {
    const order: string[] = [];
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order, {
      removeIsolatedDatabase: async (containerName) => {
        order.push(`remove-failed:${containerName}`);
        throw new Error('container still owns the volume');
      },
      restoreArchive: async () => {
        throw new Error('pre-commit failure');
      },
    }))).rejects.toThrow('managed runtime could not be restarted automatically');
    expect(order).not.toContain('clear-index');
    expect(order.filter((phase) => phase === 'start')).toHaveLength(1);
  });

  it('refuses unsafe inputs, explicit runtime overrides, and a missing managed runtime before mutation', async () => {
    for (const artifact of ['-', 'backup.dump']) {
      await expect(recoverManagedRuntime({ artifact }, dependencies([])))
        .rejects.toThrow(artifact === '-' ? 'stdin is not supported' : 'must end with .hlbackup');
    }
    await expect(recoverManagedRuntime({
      artifact: 'https://example.com/backup.hlbackup',
    }, dependencies([]))).rejects.toThrow('URLs are not supported');
    for (const [name, value] of [
      ['DATABASE_URL', 'postgres://example.invalid/db'],
      ['QDRANT_URL', 'http://example.invalid'],
      ['RAG_ENABLED', 'false'],
    ]) {
      await expect(recoverManagedRuntime({
        artifact: '/requested/incoming.hlbackup',
        environment: { HORIZONLAYER_HOME: '/runtime', [name]: value },
      }, dependencies([]))).rejects.toThrow('cannot run with');
    }
    const order: string[] = [];
    await expect(recoverManagedRuntime({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, dependencies(order, { readConfig: async () => null }))).rejects.toThrow('setup');
    expect(order).toEqual(['lock']);

    await expect(previewManagedRuntimeRecovery({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime', RAG_ENABLED: 'false' },
    }, {
      inspectArtifact: async (path) => inspection(path),
      readConfig: async () => config,
    })).rejects.toThrow('cannot run with');
    await expect(previewManagedRuntimeRecovery({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, {
      inspectArtifact: async (path) => inspection(path),
      readConfig: async () => null,
    })).rejects.toThrow('setup');
    await expect(previewManagedRuntimeRecovery({
      artifact: '/requested/incoming.hlbackup',
      environment: { HORIZONLAYER_HOME: '/runtime' },
    }, {
      inspectArtifact: async () => {
        throw new Error('checksum mismatch');
      },
      readConfig: async () => config,
    })).rejects.toThrow('read-only preview made no changes');
  });
});

describe('Runtime Recovery artifacts and process adapter', () => {
  it('previews and privately stages a verified multi-chunk payload without changing runtime state', async () => {
    const directory = await temporaryDirectory();
    const payload = Buffer.alloc(1024 * 1024 + 29, 0x5a);
    const payloadPath = join(directory, 'source.dump');
    const artifactPath = join(directory, 'knowledge.hlbackup');
    const stagedPath = join(directory, 'staged.dump');
    await writeFile(payloadPath, payload, { mode: 0o600 });
    await createBackupArtifact({
      destination: artifactPath,
      manifest: { ...manifest, payload: undefined } as unknown as BackupManifestInput,
      payloadPath,
    });

    const preview = await previewManagedRuntimeRecovery({
      artifact: artifactPath,
      environment: { HORIZONLAYER_HOME: directory },
    }, {
      readConfig: async () => config,
    });
    expect(formatManagedRecoveryPreview(preview)).toContain('no changes were made');
    expect(formatManagedRecoveryPreview(preview)).toContain(`Target configuration: ${join(directory, 'runtime.json')}`);
    expect(formatManagedRecoveryPreview(preview)).toContain('Target Compose project: horizonlayer-test');
    expect(formatManagedRecoveryPreview(preview)).toContain('trusted source');
    expect(formatManagedRecoveryPreview(preview)).toContain(`horizonlayer recover '${artifactPath}' --yes`);
    expect(formatManagedRecoveryPreview(preview)).not.toContain(config.database_password);
    const staged = await localRecoveryInternals.stageArchive(artifactPath, stagedPath);
    expect(await readFile(staged.payloadPath)).toEqual(payload);
    if (process.platform !== 'win32') {
      expect((await stat(staged.payloadPath)).mode & 0o777).toBe(0o600);
    }

    const defaultCwdPath = localRecoveryInternals.resolveArtifactPath({
      artifact: 'relative.hlbackup',
    });
    expect(defaultCwdPath).toBe(join(process.cwd(), 'relative.hlbackup'));
    expect(localRecoveryInternals.confirmationCommand("/tmp/owner's.hlbackup", 'linux'))
      .toBe("horizonlayer recover '/tmp/owner'\"'\"'s.hlbackup' --yes");
    expect(localRecoveryInternals.confirmationCommand('C:\\Backups\\knowledge.hlbackup', 'win32'))
      .toBe('horizonlayer recover "C:\\\\Backups\\\\knowledge.hlbackup" --yes');

    const existingStage = join(directory, 'existing.dump');
    await writeFile(existingStage, 'keep');
    await expect(localRecoveryInternals.stageArchive(artifactPath, existingStage))
      .rejects.toThrow('Cannot stage');
    expect(await readFile(existingStage, 'utf8')).toBe('keep');

    const stagingDirectory = await localRecoveryInternals.createStagingDirectory(
      join(directory, 'runtime.json')
    );
    expect(stagingDirectory).toContain('.recovery-');
    if (process.platform !== 'win32') {
      expect((await stat(stagingDirectory)).mode & 0o777).toBe(0o700);
    }
  }, 15_000);

  it('constructs isolated restore, validation, and Qdrant collection invalidation without a shell', async () => {
    const calls: Array<Parameters<import('./localBackup.js').BackupProcessRunner>[0]> = [];
    const runner = vi.fn(async (params: Parameters<import('./localBackup.js').BackupProcessRunner>[0]) => {
      calls.push(params);
      return { stderr: '', stdout: '' };
    });
    const archive = {
      inspection: inspection('/requested/incoming.hlbackup'),
      payloadPath: '/private/incoming.dump',
    };
    const environment = { PATH: '/bin' };

    await localRecoveryInternals.validateArchive(config, archive, environment, runner);
    await localRecoveryInternals.startIsolatedDatabase(
      config,
      'horizonlayer-recovery-safe',
      environment,
      runner
    );
    await localRecoveryInternals.restoreArchive(
      config,
      'horizonlayer-recovery-safe',
      archive,
      environment,
      runner
    );
    await localRecoveryInternals.validateCanonicalKnowledge(
      config,
      'horizonlayer-recovery-safe',
      environment,
      runner
    );
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await localRecoveryInternals.clearDerivedSearchIndex(
      config,
      { ...environment, QDRANT_COLLECTION: 'custom collection' },
      runner,
      fetcher
    );
    await localRecoveryInternals.removeIsolatedDatabase(
      'horizonlayer-recovery-safe',
      environment,
      runner
    );

    expect(calls.every((call) => call.command === 'docker')).toBe(true);
    expect(calls[0]).toMatchObject({
      args: expect.arrayContaining(['exec', '-T', 'db', 'pg_restore', '--list']),
      stdinPath: '/private/incoming.dump',
    });
    expect(calls).toContainEqual(expect.objectContaining({
      args: expect.arrayContaining([
        'run', '--detach', '--no-deps', '--no-TTY', '--name',
        'horizonlayer-recovery-safe', 'db',
      ]),
    }));
    expect(calls).toContainEqual(expect.objectContaining({
      args: [
        'exec', '-i', 'horizonlayer-recovery-safe', 'pg_restore',
        '--clean', '--if-exists', '--no-owner', '--no-acl', '--single-transaction',
        '--exit-on-error', '--no-password', '--username', 'postgres', '--dbname', 'horizon_layer',
      ],
      stdinPath: '/private/incoming.dump',
    }));
    expect(calls).toContainEqual(expect.objectContaining({
      args: expect.arrayContaining(['--command', 'ANALYZE;']),
    }));
    const validationSql = localRecoveryInternals.canonicalValidationSql();
    for (const table of [
      'issue_projects', 'issues', 'issue_comments', 'issue_dependencies', 'record_links',
    ]) {
      expect(validationSql).toContain(`'${table}'`);
    }
    expect(validationSql).toContain('workspace_search_changes');
    expect(validationSql).not.toContain("'links'");
    expect(calls).toContainEqual(expect.objectContaining({
      args: expect.arrayContaining(['up', '-d', '--no-deps', 'qdrant']),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      new URL('http://127.0.0.1:56333/collections/custom%20collection'),
      { method: 'DELETE' }
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      new URL('http://127.0.0.1:56333/collections/custom%20collection')
    );
    expect(calls.flatMap((call) => call.args)).not.toContain(config.database_password);

    const warningRunner = vi.fn(async () => ({ stderr: 'warning', stdout: '' }));
    await expect(localRecoveryInternals.validateArchive(config, archive, {}, warningRunner))
      .rejects.toThrow('validate the Backup cleanly');
    await expect(localRecoveryInternals.validateCanonicalKnowledge(
      config,
      'horizonlayer-recovery-safe',
      {},
      warningRunner
    )).rejects.toThrow('reported warnings');
    await expect(localRecoveryInternals.restoreArchive(
      config,
      'horizonlayer-recovery-safe',
      archive,
      {},
      warningRunner
    )).resolves.toEqual({ warnings: 'warning' });

    await expect(localRecoveryInternals.runRecoveryProcess({
      args: [],
      command: 'docker',
      environment: {},
      stdout: 'ignore',
    }, vi.fn(async () => Promise.reject('offline')))).rejects.toMatchObject({ details: 'offline' });
  });

  it('requires Qdrant readiness, successful deletion, and verified collection absence', async () => {
    const runner = vi.fn(async () => ({ stderr: '', stdout: '' }));
    let now = 0;
    await expect(localRecoveryInternals.clearDerivedSearchIndex(
      config,
      {},
      runner,
      vi.fn(async () => new Response(null, { status: 503 })),
      2_000,
      () => now,
      async () => {
        now += 1_000;
      }
    )).rejects.toThrow('did not become ready');

    await expect(localRecoveryInternals.clearDerivedSearchIndex(
      config,
      {},
      runner,
      vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
    )).rejects.toThrow('HTTP 500');

    await expect(localRecoveryInternals.clearDerivedSearchIndex(
      config,
      {},
      runner,
      vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
    )).rejects.toThrow('still exposes');
  });

  it('times out isolated readiness deterministically', async () => {
    let now = 0;
    const wait = vi.fn(async () => {
      now += 1_000;
    });
    await expect(localRecoveryInternals.waitForIsolatedDatabase(
      config,
      'recovery-container',
      {},
      vi.fn(async () => {
        throw new Error('not ready');
      }),
      2_000,
      () => now,
      wait
    )).rejects.toThrow('did not become ready');
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
