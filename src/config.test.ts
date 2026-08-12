import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config, loadConfig, reloadConfig } from './config.js';

describe('environment configuration', () => {
  it('refreshes the live binding after the launcher applies runtime values', () => {
    reloadConfig({ DATABASE_URL: 'postgres://local/runtime' });
    expect(config.database.url).toBe('postgres://local/runtime');
    reloadConfig({});
  });
  it('uses local-first defaults without reading a config file', () => {
    expect(loadConfig({})).toEqual({
      dashboard: {
        port: 4_317,
      },
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
        statement_timeout_ms: 30_000,
        user: 'postgres',
      },
      rag: {
        allow_download: true,
        cache_dir: join(homedir(), '.cache', 'horizonlayer', 'models'),
        collection: 'horizonlayer_rag',
        embedding_dtype: 'fp32',
        embedding_model: 'onnx-community/all-MiniLM-L6-v2-ONNX',
        embedding_revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
        enabled: false,
        qdrant_url: 'http://127.0.0.1:6333',
        timeout_ms: 5_000,
      },
      server: {
        name: 'Horizon Layer',
        version: '2.0.0',
      },
    });
  });

  it('parses explicit environment values into their runtime types', () => {
    expect(loadConfig({
      APP_NAME: 'Agent Knowledge',
      DASHBOARD_PORT: '7777',
      DATABASE_URL: 'postgres://local/test',
      DB_CONNECTION_TIMEOUT_MS: '5000',
      DB_IDLE_TIMEOUT_MS: '6000',
      DB_POOL_MAX: '12',
      DB_PORT: '6543',
      DB_SSL_MODE: 'require',
      DB_SSL_REJECT_UNAUTHORIZED: 'off',
      DB_STATEMENT_TIMEOUT_MS: '45000',
      EMBEDDING_ALLOW_DOWNLOAD: 'off',
      EMBEDDING_CACHE_DIR: '/var/cache/horizonlayer-models',
      EMBEDDING_DTYPE: 'q4',
      EMBEDDING_MODEL: 'local/embedding-model',
      EMBEDDING_REVISION: 'pinned-revision',
      QDRANT_API_KEY: 'local-secret',
      QDRANT_COLLECTION: 'agent_memory',
      QDRANT_TIMEOUT_MS: '7500',
      QDRANT_URL: 'https://qdrant.internal:7443',
      RAG_ENABLED: 'yes',
    })).toMatchObject({
      dashboard: {
        port: 7777,
      },
      database: {
        connection_timeout_ms: 5000,
        idle_timeout_ms: 6000,
        pool_max: 12,
        port: 6543,
        ssl_mode: 'require',
        ssl_reject_unauthorized: false,
        statement_timeout_ms: 45000,
        url: 'postgres://local/test',
      },
      rag: {
        allow_download: false,
        api_key: 'local-secret',
        cache_dir: '/var/cache/horizonlayer-models',
        collection: 'agent_memory',
        embedding_dtype: 'q4',
        embedding_model: 'local/embedding-model',
        embedding_revision: 'pinned-revision',
        enabled: true,
        qdrant_url: 'https://qdrant.internal:7443',
        timeout_ms: 7500,
      },
      server: { name: 'Agent Knowledge', version: '2.0.0' },
    });
  });

  it('accepts explicit true boolean values', () => {
    expect(loadConfig({ DB_SSL_REJECT_UNAUTHORIZED: 'yes' }).database.ssl_reject_unauthorized)
      .toBe(true);
    expect(loadConfig({ RAG_ENABLED: 'on' }).rag.enabled).toBe(true);
    expect(loadConfig({ EMBEDDING_ALLOW_DOWNLOAD: '1' }).rag.allow_download).toBe(true);
  });

  it('rejects ambiguous boolean values', () => {
    expect(() => loadConfig({ DB_SSL_REJECT_UNAUTHORIZED: 'sometimes' })).toThrow(
      'DB_SSL_REJECT_UNAUTHORIZED must be one of: true, false, 1, 0, yes, no, on, off'
    );
    expect(() => loadConfig({ RAG_ENABLED: 'sometimes' })).toThrow(
      'RAG_ENABLED must be one of: true, false, 1, 0, yes, no, on, off'
    );
  });

  it('rejects invalid numeric values instead of silently using defaults', () => {
    expect(() => loadConfig({ DB_PORT: 'not-a-number' })).toThrow(
      'DB_PORT must be a finite number'
    );
    expect(() => loadConfig({ DB_PORT: '70000' })).toThrow();
    expect(() => loadConfig({ DB_POOL_MAX: '0' })).toThrow();
    expect(() => loadConfig({ DASHBOARD_PORT: '0' })).toThrow();
    expect(() => loadConfig({ DB_STATEMENT_TIMEOUT_MS: '999' })).toThrow();
    expect(() => loadConfig({ DB_STATEMENT_TIMEOUT_MS: '300001' })).toThrow();
    expect(() => loadConfig({ QDRANT_TIMEOUT_MS: '99' })).toThrow();
    expect(() => loadConfig({ QDRANT_TIMEOUT_MS: '120001' })).toThrow();
  });

  it('rejects credentials embedded in QDRANT_URL', () => {
    expect(() => loadConfig({ QDRANT_URL: 'https://agent:secret@qdrant.internal' })).toThrow(
      'QDRANT_URL must not contain credentials'
    );
  });

  it('never sends a Qdrant API key over cleartext off loopback', () => {
    expect(() => loadConfig({
      QDRANT_API_KEY: 'secret',
      QDRANT_URL: 'http://qdrant.internal:6333',
    })).toThrow('QDRANT_URL must use https when QDRANT_API_KEY is set');
    expect(loadConfig({
      QDRANT_API_KEY: 'local-secret',
      QDRANT_URL: 'http://127.0.0.1:6333',
    }).rag.api_key).toBe('local-secret');
  });

  it('uses XDG_CACHE_HOME for the default embedding cache when provided', () => {
    expect(loadConfig({ XDG_CACHE_HOME: '/tmp/agent-cache' }).rag.cache_dir)
      .toBe('/tmp/agent-cache/horizonlayer/models');
  });

  it('validates RAG URLs, enums, and nonblank values', () => {
    expect(() => loadConfig({ QDRANT_URL: 'not-a-url' })).toThrow();
    expect(() => loadConfig({ QDRANT_URL: 'ftp://127.0.0.1:6333' })).toThrow(
      'QDRANT_URL must use http or https'
    );
    expect(() => loadConfig({ QDRANT_COLLECTION: '   ' })).toThrow();
    expect(() => loadConfig({ EMBEDDING_CACHE_DIR: '   ' })).toThrow();
    expect(() => loadConfig({ EMBEDDING_DTYPE: 'q8' })).toThrow();
  });

});
