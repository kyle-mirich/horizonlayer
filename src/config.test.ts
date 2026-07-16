import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('environment configuration', () => {
  it('uses local-first defaults without reading a config file', () => {
    expect(loadConfig({})).toEqual({
      database: {
        connection_timeout_ms: 10_000,
        database: 'horizon_layer',
        host: 'localhost',
        idle_timeout_ms: 30_000,
        password: '',
        pool_max: 10,
        port: 5432,
        ssl_mode: 'disable',
        ssl_reject_unauthorized: true,
        user: 'postgres',
      },
      server: {
        name: 'Horizon Layer',
        version: '0.0.1',
      },
    });
  });

  it('parses explicit environment values into their runtime types', () => {
    expect(loadConfig({
      APP_NAME: 'Agent Knowledge',
      DATABASE_URL: 'postgres://local/test',
      DB_CONNECTION_TIMEOUT_MS: '5000',
      DB_IDLE_TIMEOUT_MS: '6000',
      DB_POOL_MAX: '12',
      DB_PORT: '6543',
      DB_SSL_MODE: 'require',
      DB_SSL_REJECT_UNAUTHORIZED: 'off',
    })).toMatchObject({
      database: {
        connection_timeout_ms: 5000,
        idle_timeout_ms: 6000,
        pool_max: 12,
        port: 6543,
        ssl_mode: 'require',
        ssl_reject_unauthorized: false,
        url: 'postgres://local/test',
      },
      server: { name: 'Agent Knowledge', version: '0.0.1' },
    });
  });

  it('accepts explicit true boolean values', () => {
    expect(loadConfig({ DB_SSL_REJECT_UNAUTHORIZED: 'yes' }).database.ssl_reject_unauthorized)
      .toBe(true);
  });

  it('rejects ambiguous boolean values', () => {
    expect(() => loadConfig({ DB_SSL_REJECT_UNAUTHORIZED: 'sometimes' })).toThrow(
      'DB_SSL_REJECT_UNAUTHORIZED must be one of: true, false, 1, 0, yes, no, on, off'
    );
  });

  it('rejects invalid numeric values instead of silently using defaults', () => {
    expect(() => loadConfig({ DB_PORT: 'not-a-number' })).toThrow(
      'DB_PORT must be a finite number'
    );
    expect(() => loadConfig({ DB_PORT: '70000' })).toThrow();
    expect(() => loadConfig({ DB_POOL_MAX: '0' })).toThrow();
  });
});
