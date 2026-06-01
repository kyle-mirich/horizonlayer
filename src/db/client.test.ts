import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolInstances: Array<{ end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; options: unknown }> = [];
const PoolMock = vi.fn(function PoolMockImpl(options: unknown) {
  const instance = {
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    options,
  };
  poolInstances.push(instance);
  return instance;
});

vi.mock('pg', () => ({
  default: {
    Pool: PoolMock,
  },
}));

const configState = vi.hoisted(() => ({
  database: {
    connection_timeout_ms: 1000,
    database: 'horizon_layer',
    host: 'localhost',
    idle_timeout_ms: 2000,
    password: 'password',
    pool_max: 5,
    port: 5432,
    ssl_mode: 'disable',
    ssl_reject_unauthorized: true,
    url: undefined as string | undefined,
    user: 'postgres',
  },
}));

vi.mock('../config.js', () => ({
  config: configState,
}));

describe('database client pool', () => {
  beforeEach(async () => {
    const { closePool } = await import('./client.js');
    await closePool();
    PoolMock.mockClear();
    poolInstances.length = 0;
    configState.database.url = undefined;
    configState.database.ssl_mode = 'disable';
    configState.database.ssl_reject_unauthorized = true;
  });

  it('creates and reuses a host-based pool', async () => {
    const { getPool } = await import('./client.js');
    const first = getPool();
    const second = getPool();

    expect(first).toBe(second);
    expect(PoolMock).toHaveBeenCalledTimes(1);
    expect(poolInstances[0]?.options).toMatchObject({
      database: 'horizon_layer',
      host: 'localhost',
      max: 5,
      port: 5432,
      user: 'postgres',
    });
    expect(poolInstances[0]?.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('prefers DATABASE_URL-style connection strings and SSL settings when configured', async () => {
    configState.database.url = 'postgres://example/test';
    configState.database.ssl_mode = 'require';
    configState.database.ssl_reject_unauthorized = false;

    const { closePool, getPool } = await import('./client.js');
    getPool();
    await closePool();

    expect(poolInstances[0]?.options).toMatchObject({
      connectionString: 'postgres://example/test',
      ssl: { rejectUnauthorized: false },
    });
    expect(poolInstances[0]?.end).toHaveBeenCalledTimes(1);
  });

  it('does nothing when closing before a pool is created', async () => {
    const { closePool } = await import('./client.js');
    await expect(closePool()).resolves.toBeUndefined();
    expect(PoolMock).not.toHaveBeenCalled();
  });
});
