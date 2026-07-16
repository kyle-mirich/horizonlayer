import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildManagedDbConfig,
  buildManagedPostgresDockerRun,
  buildManagedQdrantConfig,
  buildManagedQdrantDockerRun,
  isQdrantReady,
  shouldManageQdrant,
  type ManagedDbConfig,
  type ManagedQdrantConfig,
} from './launcher.js';

const originalEnv = { ...process.env };
const launcherEnvKeys = [
  'DB_HOST',
  'DB_NAME',
  'DB_PASSWORD',
  'DB_PORT',
  'DB_USER',
  'HORIZONLAYER_DOCKER_CONTAINER_NAME',
  'HORIZONLAYER_DOCKER_IMAGE',
  'HORIZONLAYER_DOCKER_VOLUME_NAME',
  'HORIZONLAYER_QDRANT_DOCKER_CONTAINER_NAME',
  'HORIZONLAYER_QDRANT_DOCKER_IMAGE',
  'HORIZONLAYER_QDRANT_DOCKER_VOLUME_NAME',
  'QDRANT_URL',
  'RAG_ENABLED',
];

describe('managed Postgres launcher', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of launcherEnvKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('uses the shared DB_* environment names and PostgreSQL 17 by default', () => {
    process.env.DB_HOST = 'db.internal';
    process.env.DB_NAME = 'memory';
    process.env.DB_PASSWORD = 'current-password';
    process.env.DB_PORT = '6543';
    process.env.DB_USER = 'agent';
    expect(buildManagedDbConfig()).toMatchObject({
      database: 'memory',
      host: 'db.internal',
      image: 'postgres:17',
      password: 'current-password',
      port: 6543,
      user: 'agent',
    });
  });

  it('passes the managed database password through the child environment, not Docker argv', () => {
    const config: ManagedDbConfig = {
      containerName: 'horizonlayer-postgres',
      database: 'horizon_layer',
      host: '127.0.0.1',
      image: 'postgres:17',
      password: 'secret-that-must-not-appear-in-argv',
      port: 5432,
      user: 'postgres',
      volumeName: 'horizonlayer-postgres-data',
    };

    const dockerRun = buildManagedPostgresDockerRun(config);

    expect(dockerRun.args.join(' ')).not.toContain(config.password);
    expect(dockerRun.args).toContain('POSTGRES_PASSWORD');
    expect(dockerRun.env.POSTGRES_PASSWORD).toBe(config.password);
  });
});

describe('managed Qdrant launcher', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of launcherEnvKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('uses a pinned unprivileged local image and isolated persistent volume', () => {
    expect(buildManagedQdrantConfig()).toEqual({
      containerName: 'horizonlayer-qdrant',
      host: '127.0.0.1',
      image: 'qdrant/qdrant:v1.18.2-unprivileged',
      port: 6333,
      volumeName: 'horizonlayer-qdrant-data',
    });

    process.env.HORIZONLAYER_QDRANT_DOCKER_CONTAINER_NAME = 'agent-qdrant';
    process.env.HORIZONLAYER_QDRANT_DOCKER_IMAGE = 'qdrant/qdrant:test';
    process.env.HORIZONLAYER_QDRANT_DOCKER_VOLUME_NAME = 'agent-qdrant-data';
    expect(buildManagedQdrantConfig()).toMatchObject({
      containerName: 'agent-qdrant',
      image: 'qdrant/qdrant:test',
      volumeName: 'agent-qdrant-data',
    });
  });

  it('builds the exact loopback-only Docker invocation without credentials', () => {
    const config: ManagedQdrantConfig = {
      containerName: 'horizonlayer-qdrant',
      host: '127.0.0.1',
      image: 'qdrant/qdrant:v1.18.2-unprivileged',
      port: 6333,
      volumeName: 'horizonlayer-qdrant-data',
    };

    expect(buildManagedQdrantDockerRun(config)).toEqual({
      args: [
        'run',
        '-d',
        '--name',
        'horizonlayer-qdrant',
        '-e',
        'QDRANT__TELEMETRY_DISABLED',
        '-p',
        '127.0.0.1:6333:6333',
        '-v',
        'horizonlayer-qdrant-data:/qdrant/storage',
        'qdrant/qdrant:v1.18.2-unprivileged',
      ],
      env: {
        QDRANT__TELEMETRY_DISABLED: 'true',
      },
    });
  });

  it('owns Qdrant only for explicit RAG opt-in without an explicit URL', () => {
    expect(shouldManageQdrant({})).toBe(false);
    expect(shouldManageQdrant({ RAG_ENABLED: 'false' })).toBe(false);
    expect(shouldManageQdrant({ RAG_ENABLED: 'true' })).toBe(true);
    expect(shouldManageQdrant({ RAG_ENABLED: 'yes', QDRANT_URL: '' })).toBe(true);
    expect(shouldManageQdrant({
      RAG_ENABLED: 'true',
      QDRANT_URL: 'http://127.0.0.1:6333',
    })).toBe(false);
    expect(shouldManageQdrant({ RAG_ENABLED: 'invalid' })).toBe(false);
  });

  it('probes the unauthenticated readiness endpoint and handles failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(isQdrantReady('http://127.0.0.1:6333')).resolves.toBe(true);
    await expect(isQdrantReady('http://127.0.0.1:6333')).resolves.toBe(false);
    await expect(isQdrantReady('http://127.0.0.1:6333')).resolves.toBe(false);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(new URL('http://127.0.0.1:6333/readyz'));
  });
});
