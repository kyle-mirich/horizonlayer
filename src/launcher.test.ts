import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildManagedDbConfig,
  buildManagedPostgresDockerRun,
  type ManagedDbConfig,
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
