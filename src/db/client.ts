import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    const baseConfig = {
      connectionTimeoutMillis: config.database.connection_timeout_ms,
      idleTimeoutMillis: config.database.idle_timeout_ms,
      max: config.database.pool_max,
      ssl: config.database.ssl_mode === 'require'
        ? {
            rejectUnauthorized: config.database.ssl_reject_unauthorized,
          }
        : undefined,
    };
    _pool = config.database.url
      ? new Pool({
          ...baseConfig,
          connectionString: config.database.url,
        })
      : new Pool({
          ...baseConfig,
          host: config.database.host,
          port: config.database.port,
          database: config.database.database,
          user: config.database.user,
          password: config.database.password,
        });

    _pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

export type { PoolClient } from 'pg';
