import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackupArtifact, inspectBackupArtifact } from './backupArtifact.js';
import {
  createManagedRuntimeBackup,
  defaultBackupDirectory,
  defaultBackupPath,
  formatManagedBackupReceipt,
  LocalBackupError,
  localBackupInternals,
  type ManagedBackupDependencies,
} from './localBackup.js';
import type { LocalRuntimeConfig } from './localRuntime.js';

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'horizonlayer-managed-backup-'));
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

function dependencies(
  order: string[],
  overrides: Partial<ManagedBackupDependencies> = {}
): ManagedBackupDependencies {
  const times = [
    new Date('2026-08-10T20:00:00.000Z'),
    new Date('2026-08-10T20:00:01.000Z'),
  ];
  const randomIds = ['artifact-id', 'payload-id'];
  return {
    createArtifact: async (params) => {
      order.push('create-artifact');
      return createBackupArtifact(params);
    },
    dumpDatabase: async (_config, path) => {
      order.push('dump');
      await writeFile(path, Buffer.from('PGDMP\u0001\u0002database payload'), { mode: 0o600 });
    },
    ensureDocker: async () => {
      order.push('docker');
    },
    inspectArtifact: async (path) => {
      order.push('inspect-artifact');
      return inspectBackupArtifact(path);
    },
    inspectPostgreSql: async () => {
      order.push('metadata');
      return {
        pgDumpVersion: 'pg_dump (PostgreSQL) 17.6',
        serverMajor: 17,
        serverVersion: '17.6',
      };
    },
    now: () => times.shift() ?? new Date('2026-08-10T20:00:01.000Z'),
    randomId: () => randomIds.shift() ?? 'fallback-id',
    readConfig: async () => {
      order.push('config');
      return config;
    },
    startDatabase: async () => {
      order.push('start');
    },
    validateDatabaseDump: async () => {
      order.push('validate-dump');
    },
    waitForDatabase: async () => {
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

describe('managed runtime Backup', () => {
  it('creates, validates, and receipts an explicit private Backup in lifecycle order', async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, 'knowledge.hlbackup');
    const home = join(directory, 'runtime');
    const order: string[] = [];

    const result = await createManagedRuntimeBackup({
      destination,
      environment: { HORIZONLAYER_HOME: home },
    }, dependencies(order));

    expect(order).toEqual([
      'lock',
      'config',
      'docker',
      'start',
      'wait',
      'metadata',
      'dump',
      'validate-dump',
      'create-artifact',
      'inspect-artifact',
    ]);
    expect(result).toMatchObject({
      configurationPath: join(home, 'runtime.json'),
      manifest: {
        completed_at: '2026-08-10T20:00:01.000Z',
        horizonlayer_version: '2.0.0',
        postgresql: {
          pg_dump_version: 'pg_dump (PostgreSQL) 17.6',
          server_major: 17,
          server_version: '17.6',
        },
        source_database: 'horizon_layer',
        started_at: '2026-08-10T20:00:00.000Z',
      },
      path: destination,
    });
    expect(await readFile(destination)).toHaveLength(
      result.payloadOffset + result.manifest.payload.bytes
    );
    const receipt = formatManagedBackupReceipt(result);
    expect(receipt).toContain(`Backup created: ${destination}`);
    expect(receipt).toContain('Snapshot interval: 2026-08-10T20:00:00.000Z to 2026-08-10T20:00:01.000Z');
    expect(receipt).toContain(`SHA-256: ${result.manifest.payload.sha256}`);
    expect(receipt).not.toContain(config.database_password);
    expect(receipt).not.toContain('DATABASE_URL');
    if (process.platform !== 'win32') {
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    }
    expect((await readdir(directory)).filter((name) => name.includes('.payload-'))).toEqual([]);
  });

  it('creates a collision-safe default path inside the private runtime backup directory', async () => {
    const directory = await temporaryDirectory();
    const home = join(directory, 'runtime');
    const order: string[] = [];
    const result = await createManagedRuntimeBackup({
      environment: { HORIZONLAYER_HOME: home },
    }, dependencies(order));

    expect(result.path).toBe(join(
      home,
      'backups',
      'horizonlayer-backup-20260810T200000000Z-artifact.hlbackup'
    ));
    expect(defaultBackupDirectory(join(home, 'runtime.json'))).toBe(join(home, 'backups'));
    expect(defaultBackupPath(
      join(home, 'runtime.json'),
      new Date('2026-08-10T20:00:00.000Z'),
      'abcdefgh-more'
    )).toBe(join(home, 'backups', 'horizonlayer-backup-20260810T200000000Z-abcdefgh.hlbackup'));
    if (process.platform !== 'win32') {
      expect((await stat(join(home, 'backups'))).mode & 0o777).toBe(0o700);
    }
  });

  it('resolves relative explicit paths without creating their missing parent', async () => {
    const directory = await temporaryDirectory();
    const home = join(directory, 'runtime');
    const order: string[] = [];
    await expect(createManagedRuntimeBackup({
      cwd: directory,
      destination: 'missing/backup.hlbackup',
      environment: { HORIZONLAYER_HOME: home },
    }, dependencies(order))).rejects.toThrow('does not exist');
    expect(order).toEqual(['lock', 'config']);
  });

  it('refuses stdout, wrong suffixes, explicit runtime overrides, and missing setup', async () => {
    const directory = await temporaryDirectory();
    const home = join(directory, 'runtime');

    await expect(createManagedRuntimeBackup({
      destination: '-',
      environment: { HORIZONLAYER_HOME: home },
    }, dependencies([]))).rejects.toThrow('stdout is not supported');
    await expect(createManagedRuntimeBackup({
      destination: join(directory, 'backup.dump'),
      environment: { HORIZONLAYER_HOME: home },
    }, dependencies([]))).rejects.toThrow('must end with .hlbackup');

    for (const [name, value] of [
      ['DATABASE_URL', 'postgres://example.invalid/db'],
      ['QDRANT_URL', 'http://example.invalid'],
      ['RAG_ENABLED', 'false'],
    ]) {
      await expect(createManagedRuntimeBackup({
        destination: join(directory, `${name}.hlbackup`),
        environment: { HORIZONLAYER_HOME: home, [name]: value },
      }, dependencies([]))).rejects.toThrow('cannot run with');
    }

    const order: string[] = [];
    await expect(createManagedRuntimeBackup({
      destination: join(directory, 'missing-config.hlbackup'),
      environment: { HORIZONLAYER_HOME: home },
    }, dependencies(order, { readConfig: async () => null }))).rejects.toThrow('setup');
    expect(order).toEqual(['lock']);
  });

  it('preserves an existing destination and cleans the sensitive payload after failure', async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, 'existing.hlbackup');
    const home = join(directory, 'runtime');
    await writeFile(destination, 'existing');

    await expect(createManagedRuntimeBackup({
      destination,
      environment: { HORIZONLAYER_HOME: home },
    }, dependencies([]))).rejects.toThrow('already exists');
    expect(await readFile(destination, 'utf8')).toBe('existing');
    expect((await readdir(directory)).filter((name) => name.includes('.payload-'))).toEqual([]);
  });

  it('does not publish or retain a payload when pg_dump or structural validation fails', async () => {
    const directory = await temporaryDirectory();
    const home = join(directory, 'runtime');
    const dumpDestination = join(directory, 'dump-failed.hlbackup');
    await expect(createManagedRuntimeBackup({
      destination: dumpDestination,
      environment: { HORIZONLAYER_HOME: home },
    }, dependencies([], {
      dumpDatabase: async (_config, path) => {
        await writeFile(path, 'partial secret');
        throw new Error('pg_dump exited 1');
      },
    }))).rejects.toThrow('no final Backup was published');

    const validationDestination = join(directory, 'validation-failed.hlbackup');
    await expect(createManagedRuntimeBackup({
      destination: validationDestination,
      environment: { HORIZONLAYER_HOME: home },
    }, dependencies([], {
      validateDatabaseDump: async () => {
        throw new Error('pg_restore rejected archive');
      },
    }))).rejects.toThrow('no final Backup was published');

    expect(await readdir(directory)).toEqual([]);
  });

  it('removes the exclusively published artifact when post-publication inspection fails', async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, 'inspection-failed.hlbackup');
    await expect(createManagedRuntimeBackup({
      destination,
      environment: { HORIZONLAYER_HOME: join(directory, 'runtime') },
    }, dependencies([], {
      inspectArtifact: async () => {
        throw new Error('cannot reread published artifact');
      },
    }))).rejects.toThrow('no final Backup was published');

    expect(await readdir(directory)).toEqual([]);
  });

  it('starts only PostgreSQL and builds Compose exec arguments without a shell', async () => {
    const startArgs = [
      'compose',
      '-f',
      expect.stringContaining('docker-compose.yml'),
      '-p',
      'horizonlayer-test',
      'up',
      '-d',
      'db',
    ];
    expect(localBackupInternals.composeStartDatabaseArgs(config)).toEqual(startArgs);
    const runner = vi.fn(async () => ({ stderr: '', stdout: '' }));
    await localBackupInternals.startDatabase(config, { PATH: '/test/bin' }, runner);
    expect(runner).toHaveBeenCalledWith({
      args: startArgs,
      command: 'docker',
      environment: expect.objectContaining({
        DB_PORT: '55432',
        PATH: '/test/bin',
      }),
      stdout: 'ignore',
    });

    expect(localBackupInternals.composeExecArgs(config, [
      'pg_dump',
      '--username',
      config.database_user,
      '--dbname',
      config.database_name,
    ])).toEqual([
      'compose',
      '-f',
      expect.stringContaining('docker-compose.yml'),
      '-p',
      'horizonlayer-test',
      'exec',
      '-T',
      'db',
      'pg_dump',
      '--username',
      'postgres',
      '--dbname',
      'horizon_layer',
    ]);
  });

  it('runs lifecycle cleanup when a failure escapes the operation', async () => {
    const directory = await temporaryDirectory();
    const release = vi.fn();
    const withLifecycleLock: ManagedBackupDependencies['withLifecycleLock'] = async (operation) => {
      try {
        return await operation();
      } finally {
        release();
      }
    };
    await expect(createManagedRuntimeBackup({
      destination: join(directory, 'failed.hlbackup'),
      environment: { HORIZONLAYER_HOME: join(directory, 'runtime') },
    }, dependencies([], {
      dumpDatabase: async () => {
        throw new Error('failed');
      },
      withLifecycleLock,
    }))).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce();
  });

  it('defers backup interruption until phase cleanup can run', async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, 'interrupted.hlbackup');
    let checks = 0;

    await expect(createManagedRuntimeBackup({
      destination,
      environment: { HORIZONLAYER_HOME: join(directory, 'runtime') },
    }, dependencies([], {
      withInterruptionGuard: async (operation) => operation(() => {
        checks += 1;
        if (checks === 7) throw new LocalBackupError('interrupted by SIGINT');
      }),
    }))).rejects.toThrow('interrupted by SIGINT');

    expect((await readdir(directory)).filter((name) => name.includes('.payload-'))).toEqual([]);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('streams child stdin/stdout, captures bounded diagnostics, and rejects process failures', async () => {
    const directory = await temporaryDirectory();
    const input = join(directory, 'input');
    const output = join(directory, 'output');
    await writeFile(input, 'stream me');

    await expect(localBackupInternals.runProcess({
      args: ['-e', 'process.stdin.pipe(process.stdout); process.stderr.write("note")'],
      command: process.execPath,
      environment: process.env,
      stdinPath: input,
      stdoutPath: output,
    })).resolves.toEqual({ stderr: 'note', stdout: '' });
    expect(await readFile(output, 'utf8')).toBe('stream me');

    const rangedOutput = join(directory, 'ranged-output');
    await localBackupInternals.runProcess({
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      command: process.execPath,
      environment: process.env,
      stdinPath: input,
      stdinStart: 7,
      stdoutPath: rangedOutput,
    });
    expect(await readFile(rangedOutput, 'utf8')).toBe('me');

    const captured = await localBackupInternals.runProcess({
      args: ['-e', 'process.stdout.write("x".repeat(70000))'],
      command: process.execPath,
      environment: process.env,
      stdout: 'capture',
    });
    expect(Buffer.byteLength(captured.stdout)).toBeGreaterThanOrEqual(64 * 1024);
    expect(captured.stdout).toContain('[output truncated]');

    await expect(localBackupInternals.runProcess({
      args: ['-e', 'process.stderr.write("failed safely"); process.exit(7)'],
      command: process.execPath,
      environment: process.env,
      stdout: 'ignore',
    })).rejects.toMatchObject({ details: 'failed safely' });
    await expect(localBackupInternals.runProcess({
      args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
      command: process.execPath,
      environment: process.env,
      stdout: 'ignore',
    })).rejects.toThrow('after SIGTERM');
    await expect(localBackupInternals.runProcess({
      args: [],
      command: join(directory, 'missing-command'),
      environment: process.env,
      stdout: 'ignore',
    })).rejects.toThrow('Cannot start');

    const occupied = join(directory, 'occupied');
    await writeFile(occupied, 'keep');
    await expect(localBackupInternals.runProcess({
      args: ['-e', 'setInterval(() => process.stdout.write("payload"), 1)'],
      command: process.execPath,
      environment: process.env,
      stdoutPath: occupied,
    })).rejects.toThrow('stream failed');
    expect(await readFile(occupied, 'utf8')).toBe('keep');
  });

  it('constructs and validates PostgreSQL dump commands through an injectable runner', async () => {
    const directory = await temporaryDirectory();
    const payload = join(directory, 'database.dump');
    const calls: Array<Parameters<import('./localBackup.js').BackupProcessRunner>[0]> = [];
    const runner = vi.fn(async (params) => {
      calls.push(params);
      return { stderr: '', stdout: '' };
    });

    await localBackupInternals.dumpDatabase(config, payload, { PATH: '/bin' }, runner);
    await localBackupInternals.validateDatabaseDump(config, payload, { PATH: '/bin' }, runner);
    expect(calls[0]).toMatchObject({
      args: expect.arrayContaining([
        'exec', '-T', 'db', 'pg_dump', '--format=custom', '--no-password',
        '--username', 'postgres', '--dbname', 'horizon_layer',
      ]),
      command: 'docker',
      stdoutPath: payload,
    });
    expect(calls[0]?.environment).toMatchObject({
      COMPOSE_PROJECT_NAME: 'horizonlayer-test',
      DB_PASSWORD: config.database_password,
      PATH: '/bin',
    });
    expect(calls[1]).toMatchObject({
      args: expect.arrayContaining(['exec', '-T', 'db', 'pg_restore', '--list']),
      stdinPath: payload,
      stdout: 'ignore',
    });

    const warning = vi.fn(async () => ({ stderr: 'warning', stdout: '' }));
    await expect(localBackupInternals.dumpDatabase(config, payload, {}, warning))
      .rejects.toThrow('reported warnings');
    await expect(localBackupInternals.validateDatabaseDump(config, payload, {}, warning))
      .rejects.toThrow('validate the Backup cleanly');
  });

  it('accepts only clean PostgreSQL 17 server and pg_dump metadata', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stderr: '', stdout: '17.6\n170006\n' })
      .mockResolvedValueOnce({ stderr: '', stdout: 'pg_dump (PostgreSQL) 17.6\n' });
    await expect(localBackupInternals.inspectPostgreSql(config, {}, runner)).resolves.toEqual({
      pgDumpVersion: 'pg_dump (PostgreSQL) 17.6',
      serverMajor: 17,
      serverVersion: '17.6',
    });

    for (const stdout of ['', '18.1\n180001\n', '17.6\nnot-a-number\n']) {
      await expect(localBackupInternals.inspectPostgreSql(
        config,
        {},
        vi.fn(async () => ({ stderr: '', stdout }))
      )).rejects.toThrow('PostgreSQL version is unsupported');
    }
    await expect(localBackupInternals.inspectPostgreSql(
      config,
      {},
      vi.fn(async () => ({ stderr: 'server warning', stdout: '17.6\n170006\n' }))
    )).rejects.toThrow('inspect managed PostgreSQL cleanly');

    const badDump = vi.fn()
      .mockResolvedValueOnce({ stderr: '', stdout: '17.6\n170006\n' })
      .mockResolvedValueOnce({ stderr: '', stdout: 'pg_dump (PostgreSQL) 18.1\n' });
    await expect(localBackupInternals.inspectPostgreSql(config, {}, badDump))
      .rejects.toThrow('pg_dump version is unsupported');

    const warnedDump = vi.fn()
      .mockResolvedValueOnce({ stderr: '', stdout: '17.6\n170006\n' })
      .mockResolvedValueOnce({ stderr: 'dump warning', stdout: 'pg_dump (PostgreSQL) 17.6\n' });
    await expect(localBackupInternals.inspectPostgreSql(config, {}, warnedDump))
      .rejects.toThrow('inspect managed pg_dump cleanly');
  });

  it('probes database and runtime readiness and times out deterministically', async () => {
    const end = vi.fn(async () => undefined);
    await expect(localBackupInternals.canConnect(config, () => ({
      connect: async () => undefined,
      end,
    }))).resolves.toBe(true);
    expect(end).toHaveBeenCalledOnce();

    const failedEnd = vi.fn(async () => {
      throw new Error('already closed');
    });
    await expect(localBackupInternals.canConnect(config, () => ({
      connect: async () => {
        throw new Error('offline');
      },
      end: failedEnd,
    }))).resolves.toBe(false);
    expect(failedEnd).toHaveBeenCalledOnce();

    const database = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    let time = 0;
    await expect(localBackupInternals.waitForDatabase(
      config,
      2_000,
      database,
      () => time,
      async (milliseconds) => {
        time += milliseconds;
      }
    )).resolves.toBeUndefined();
    expect(database).toHaveBeenCalledTimes(2);

    time = 0;
    await expect(localBackupInternals.waitForDatabase(
      config,
      1,
      vi.fn(async () => false),
      () => time,
      async (milliseconds) => {
        time += milliseconds;
      }
    )).rejects.toThrow('did not become ready');

    await expect(localBackupInternals.isQdrantReady(
      config,
      vi.fn(async () => new Response('', { status: 200 }))
    )).resolves.toBe(true);
    await expect(localBackupInternals.isQdrantReady(
      config,
      vi.fn(async () => new Response('', { status: 503 }))
    )).resolves.toBe(false);
    await expect(localBackupInternals.isQdrantReady(config, vi.fn(async () => {
      throw new Error('offline');
    }))).resolves.toBe(false);

    const runtimeDatabase = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const qdrant = vi.fn().mockResolvedValue(true);
    time = 0;
    await expect(localBackupInternals.waitForServices(
      config,
      2_000,
      { database: runtimeDatabase, qdrant },
      () => time,
      async (milliseconds) => {
        time += milliseconds;
      }
    )).resolves.toBeUndefined();
    expect(runtimeDatabase).toHaveBeenCalledTimes(2);
    expect(qdrant).toHaveBeenCalledOnce();

    time = 0;
    await expect(localBackupInternals.waitForServices(
      config,
      1,
      {
        database: vi.fn(async () => false),
        qdrant: vi.fn(async () => false),
      },
      () => time,
      async (milliseconds) => {
        time += milliseconds;
      }
    )).rejects.toThrow('did not become ready');
  });

  it('rejects unsafe default directories and explicit file parents', async () => {
    const directory = await temporaryDirectory();
    const parentFile = join(directory, 'not-a-directory');
    await writeFile(parentFile, 'file');
    await expect(localBackupInternals.prepareDestination({
      defaultDirectory: false,
      path: join(parentFile, 'backup.hlbackup'),
    })).rejects.toThrow('not a directory');

    if (process.platform !== 'win32') {
      const target = join(directory, 'target');
      const linked = join(directory, 'linked');
      await mkdir(target);
      await symlink(target, linked);
      await expect(localBackupInternals.prepareDestination({
        defaultDirectory: true,
        path: join(linked, 'backup.hlbackup'),
      })).rejects.toThrow('not a regular directory');
    }
  });
});
