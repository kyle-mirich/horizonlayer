#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { Client } = pg;

export type ManagedDbConfig = {
  containerName: string;
  database: string;
  host: string;
  image: string;
  password: string;
  port: number;
  user: string;
  volumeName: string;
};

export type ManagedQdrantConfig = {
  containerName: string;
  host: string;
  image: string;
  port: number;
  volumeName: string;
};

type BootstrapTarget = 'postgres' | 'qdrant';

class FriendlyBootstrapError extends Error {
  constructor(message: string, readonly details?: string) {
    super(message);
    this.name = 'FriendlyBootstrapError';
  }
}

interface PostgresErrorLike {
  code?: string;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildManagedDbConfig(): ManagedDbConfig {
  return {
    containerName: process.env.HORIZONLAYER_DOCKER_CONTAINER_NAME ?? 'horizonlayer-postgres',
    database: process.env.DB_NAME ?? 'horizon_layer',
    host: process.env.DB_HOST ?? '127.0.0.1',
    image: process.env.HORIZONLAYER_DOCKER_IMAGE ?? 'postgres:17',
    password: process.env.DB_PASSWORD ?? 'postgres',
    port: parseNumber(process.env.DB_PORT, 5432),
    user: process.env.DB_USER ?? 'postgres',
    volumeName: process.env.HORIZONLAYER_DOCKER_VOLUME_NAME ?? 'horizonlayer-postgres-data',
  };
}

export function buildManagedQdrantConfig(): ManagedQdrantConfig {
  return {
    containerName: process.env.HORIZONLAYER_QDRANT_DOCKER_CONTAINER_NAME
      ?? 'horizonlayer-qdrant',
    host: '127.0.0.1',
    image: process.env.HORIZONLAYER_QDRANT_DOCKER_IMAGE
      ?? 'qdrant/qdrant:v1.18.2-unprivileged',
    port: 6333,
    volumeName: process.env.HORIZONLAYER_QDRANT_DOCKER_VOLUME_NAME
      ?? 'horizonlayer-qdrant-data',
  };
}

export function shouldManageQdrant(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  const ragEnabled = environment.RAG_ENABLED?.toLowerCase();
  const hasExplicitUrl = environment.QDRANT_URL != null
    && environment.QDRANT_URL !== '';
  return ['1', 'true', 'yes', 'on'].includes(ragEnabled ?? '') && !hasExplicitUrl;
}

function buildDatabaseUrl(config: ManagedDbConfig, database: string): string {
  return `postgres://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${database}`;
}

function dockerRecoveryHint(target: BootstrapTarget): string {
  if (target === 'qdrant') {
    return 'Start Docker Desktop and try again, set QDRANT_URL to an existing Qdrant instance, '
      + 'or set RAG_ENABLED=false.';
  }
  return 'Start Docker Desktop and try again, or set DATABASE_URL to an existing PostgreSQL instance.';
}

function runDocker(
  args: string[],
  extraEnv: Record<string, string> = {},
  target: BootstrapTarget = 'postgres'
): string {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    if (errorCode !== 'ENOENT') {
      const details = result.error.message;
      throw new FriendlyBootstrapError(
        `Docker could not start while preparing local ${target === 'qdrant' ? 'Qdrant' : 'PostgreSQL'}.\n`
        + `${dockerRecoveryHint(target)}\n`
        + `Docker said: ${details}`,
        details
      );
    }
    throw new FriendlyBootstrapError(
      'Docker is required for the default local setup, but the `docker` command was not found.\n'
      + dockerRecoveryHint(target)
    );
  }
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || `docker ${args.join(' ')} failed`).trim();
    const availabilityCheck = args.length === 1 && args[0] === 'version';
    throw new FriendlyBootstrapError(
      (availabilityCheck
        ? 'Docker is installed, but its daemon is unavailable right now.\n'
        : `Docker failed while preparing local ${target === 'qdrant' ? 'Qdrant' : 'PostgreSQL'}.\n`)
      + `${dockerRecoveryHint(target)}\n`
      + `Docker said: ${details}`,
      details
    );
  }

  return (result.stdout ?? '').trim();
}

export function buildManagedPostgresDockerRun(config: ManagedDbConfig): {
  args: string[];
  env: Record<string, string>;
} {
  return {
    args: [
      'run',
      '-d',
      '--name',
      config.containerName,
      '-e',
      'POSTGRES_DB',
      '-e',
      'POSTGRES_USER',
      '-e',
      'POSTGRES_PASSWORD',
      '-p',
      `${config.host}:${config.port}:5432`,
      '-v',
      `${config.volumeName}:/var/lib/postgresql/data`,
      config.image,
    ],
    env: {
      POSTGRES_DB: config.database,
      POSTGRES_PASSWORD: config.password,
      POSTGRES_USER: config.user,
    },
  };
}

export function buildManagedQdrantDockerRun(config: ManagedQdrantConfig): {
  args: string[];
  env: Record<string, string>;
} {
  return {
    args: [
      'run',
      '-d',
      '--name',
      config.containerName,
      '-e',
      'QDRANT__TELEMETRY_DISABLED',
      '-p',
      `${config.host}:${config.port}:6333`,
      '-v',
      `${config.volumeName}:/qdrant/storage`,
      config.image,
    ],
    env: {
      QDRANT__TELEMETRY_DISABLED: 'true',
    },
  };
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

async function ensureDatabaseExists(config: ManagedDbConfig): Promise<void> {
  const adminUrl = buildDatabaseUrl(config, 'postgres');
  const client = new Client({
    connectionString: adminUrl,
    connectionTimeoutMillis: 5000,
  });

  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.database]);
    if (existing.rowCount && existing.rowCount > 0) {
      return;
    }

    try {
      await client.query(`CREATE DATABASE ${quoteIdentifier(config.database)}`);
    } catch (error) {
      if ((error as PostgresErrorLike).code !== '42P04') {
        throw error;
      }
      // Another launcher created the same database after our existence check.
    }
  } finally {
    await client.end();
  }
}

function getContainerStatus(containerName: string): 'missing' | 'running' | 'stopped' {
  const result = spawnSync(
    'docker',
    ['container', 'inspect', containerName, '--format', '{{.State.Status}}'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  if (result.status !== 0) {
    return 'missing';
  }

  return (result.stdout ?? '').trim() === 'running' ? 'running' : 'stopped';
}

function isContainerNameConflict(error: unknown): error is FriendlyBootstrapError {
  return error instanceof FriendlyBootstrapError
    && /container name .* already in use/i.test(error.details ?? '');
}

function startManagedPostgresContainer(config: ManagedDbConfig): void {
  const dockerRun = buildManagedPostgresDockerRun(config);
  try {
    runDocker(dockerRun.args, dockerRun.env);
  } catch (error) {
    if (!isContainerNameConflict(error)) throw error;

    const convergedStatus = getContainerStatus(config.containerName);
    if (convergedStatus === 'running') return;
    if (convergedStatus === 'stopped') {
      runDocker(['start', config.containerName]);
      return;
    }
    throw error;
  }
}

async function ensureManagedPostgres(config: ManagedDbConfig): Promise<string> {
  const adminUrl = buildDatabaseUrl(config, 'postgres');
  const databaseUrl = buildDatabaseUrl(config, config.database);

  if (await canConnect(adminUrl)) {
    await ensureDatabaseExists(config);
    return databaseUrl;
  }

  runDocker(['version']);

  const status = getContainerStatus(config.containerName);
  if (status === 'missing') {
    console.error(`Starting local Postgres container '${config.containerName}' on ${config.host}:${config.port}...`);
    startManagedPostgresContainer(config);
  } else if (status === 'stopped') {
    console.error(`Starting existing Postgres container '${config.containerName}'...`);
    runDocker(['start', config.containerName]);
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await canConnect(adminUrl)) {
      await ensureDatabaseExists(config);
      return databaseUrl;
    }
    await sleep(1000);
  }

  throw new FriendlyBootstrapError(
    `Started Docker bootstrap, but PostgreSQL did not become reachable at ${config.host}:${config.port} within 30 seconds.\n`
    + 'Check Docker Desktop, container logs, or set DATABASE_URL to an existing PostgreSQL instance.'
  );
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

function managedQdrantUrl(config: ManagedQdrantConfig): string {
  return `http://${config.host}:${config.port}`;
}

function startManagedQdrantContainer(config: ManagedQdrantConfig): void {
  const dockerRun = buildManagedQdrantDockerRun(config);
  try {
    runDocker(dockerRun.args, dockerRun.env, 'qdrant');
  } catch (error) {
    if (!isContainerNameConflict(error)) throw error;

    const convergedStatus = getContainerStatus(config.containerName);
    if (convergedStatus === 'running') return;
    if (convergedStatus === 'stopped') {
      runDocker(['start', config.containerName], {}, 'qdrant');
      return;
    }
    throw error;
  }
}

async function ensureManagedQdrant(config: ManagedQdrantConfig): Promise<void> {
  const url = managedQdrantUrl(config);
  if (await isQdrantReady(url)) return;

  runDocker(['version'], {}, 'qdrant');

  const status = getContainerStatus(config.containerName);
  if (status === 'missing') {
    console.error(
      `Starting local Qdrant container '${config.containerName}' on ${config.host}:${config.port}...`
    );
    startManagedQdrantContainer(config);
  } else if (status === 'stopped') {
    console.error(`Starting existing Qdrant container '${config.containerName}'...`);
    runDocker(['start', config.containerName], {}, 'qdrant');
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isQdrantReady(url)) return;
    await sleep(1_000);
  }

  throw new FriendlyBootstrapError(
    `Started Docker bootstrap, but Qdrant did not become ready at ${url}/readyz within 30 seconds.\n`
    + 'Check Docker Desktop and container logs, set QDRANT_URL to an existing Qdrant instance, '
    + 'or set RAG_ENABLED=false.'
  );
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = await ensureManagedPostgres(buildManagedDbConfig());
  }

  if (shouldManageQdrant()) {
    await ensureManagedQdrant(buildManagedQdrantConfig());
  }

  const { runServer } = await import('./runServer.js');
  await runServer();
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
