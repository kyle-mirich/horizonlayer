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

function buildDatabaseUrl(config: ManagedDbConfig, database: string): string {
  return `postgres://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${database}`;
}

function runDocker(args: string[], extraEnv: Record<string, string> = {}): string {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw new FriendlyBootstrapError(
      'Docker is required for the default local setup, but the `docker` command was not found.\n'
      + 'Install Docker Desktop or set DATABASE_URL to an existing PostgreSQL instance.'
    );
  }
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || `docker ${args.join(' ')} failed`).trim();
    throw new FriendlyBootstrapError(
      'Docker is installed, but it is not available right now.\n'
      + 'Start Docker Desktop and try again, or set DATABASE_URL to an existing PostgreSQL instance.\n'
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

function startManagedContainer(config: ManagedDbConfig): void {
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
    startManagedContainer(config);
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

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = await ensureManagedPostgres(buildManagedDbConfig());
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
