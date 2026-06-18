import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readFileSyncMock = vi.hoisted(() => vi.fn());
const yamlLoadMock = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  readFileSync: readFileSyncMock,
}));

vi.mock('js-yaml', () => ({
  default: {
    load: yamlLoadMock,
  },
}));

const originalEnv = { ...process.env };

async function loadConfigWith(params: {
  env?: Record<string, string | undefined>;
  files: Record<string, unknown>;
}) {
  vi.resetModules();
  readFileSyncMock.mockReset();
  yamlLoadMock.mockReset();

  process.env = { ...originalEnv, ...params.env };

  readFileSyncMock.mockImplementation((path: string) => {
    const match = Object.entries(params.files).find(([suffix]) => path.endsWith(suffix));
    if (!match) {
      throw new Error(`Missing fixture for ${path}`);
    }
    return match[0];
  });
  yamlLoadMock.mockImplementation((raw: string) => params.files[raw]);

  return await import('./config.js');
}

describe('config loading', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('falls back from config.yaml to config.example.yaml and normalizes http transport', async () => {
    const { config } = await loadConfigWith({
      files: {
        'config.example.yaml': {
          database: {
            database: 'example_db',
          },
          server: {
            transport: 'http',
          },
        },
      },
    });

    expect(readFileSyncMock.mock.calls.map(([path]) => String(path))).toEqual([
      expect.stringContaining('config.yaml'),
      expect.stringContaining('config.example.yaml'),
    ]);
    expect(config.database).toMatchObject({
      database: 'example_db',
      host: 'localhost',
      port: 5432,
      ssl_mode: 'disable',
    });
    expect(config.server).toMatchObject({
      endpoint: '/mcp',
      host: '127.0.0.1',
      port: 3000,
      transport: 'httpStream',
    });
    expect(config.dashboard_api).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: 3737,
    });
  });

  it('lets environment variables override nested YAML values with parsed types', async () => {
    const { config } = await loadConfigWith({
      env: {
        APP_NAME: 'Env App',
        DASHBOARD_API_ENABLED: 'yes',
        DASHBOARD_API_HOST: '0.0.0.0',
        DASHBOARD_API_PORT: '4747',
        DB_POOL_MAX: '12',
        DB_SSL_REJECT_UNAUTHORIZED: 'off',
        PORT: '8080',
        SERVER_TRANSPORT: 'stdio',
      },
      files: {
        'config.yaml': {
          dashboard_api: {
            enabled: false,
            host: '127.0.0.1',
            port: 3737,
          },
          database: {
            database: 'file_db',
            pool_max: 3,
            ssl_reject_unauthorized: true,
          },
          server: {
            name: 'File App',
            port: 3000,
            transport: 'httpStream',
          },
        },
      },
    });

    expect(config.server).toMatchObject({
      name: 'Env App',
      port: 8080,
      transport: 'stdio',
    });
    expect(config.dashboard_api).toEqual({
      enabled: true,
      host: '0.0.0.0',
      port: 4747,
    });
    expect(config.database).toMatchObject({
      database: 'file_db',
      pool_max: 12,
      ssl_reject_unauthorized: false,
    });
  });

  it('ignores empty and non-finite numeric environment values', async () => {
    const { config } = await loadConfigWith({
      env: {
        DB_PORT: 'not-a-number',
        EMBEDDING_DIMENSIONS: '',
        PORT: 'Infinity',
      },
      files: {
        'config.yaml': {
          database: {
            port: 6543,
          },
          embedding: {
            dimensions: 768,
          },
          server: {
            port: 4000,
            transport: 'httpStream',
          },
        },
      },
    });

    expect(config.database.port).toBe(6543);
    expect(config.embedding.dimensions).toBe(768);
    expect(config.server.port).toBe(4000);
  });

  it('uses schema defaults when no YAML config source is readable', async () => {
    const { config } = await loadConfigWith({
      files: {},
    });

    expect(readFileSyncMock.mock.calls.map(([path]) => String(path))).toEqual([
      expect.stringContaining('config.yaml'),
      expect.stringContaining('config.example.yaml'),
    ]);
    expect(config.database.database).toBe('horizon_layer');
    expect(config.server.transport).toBe('stdio');
    expect(config.dashboard_api.enabled).toBe(false);
  });
});
