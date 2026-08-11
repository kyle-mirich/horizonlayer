import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_QDRANT_COLLECTION } from './search/constants.js';

const packageMetadata = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
}).parse(createRequire(import.meta.url)('../package.json'));

const DatabaseSchema = z.object({
  url: z.string().min(1).optional(),
  host: z.string().min(1).default('localhost'),
  port: z.number().int().min(1).max(65_535).default(5432),
  database: z.string().min(1).default('horizon_layer'),
  user: z.string().min(1).default('postgres'),
  password: z.string().default(''),
  ssl_mode: z.enum(['disable', 'require']).default('disable'),
  ssl_reject_unauthorized: z.boolean().default(true),
  pool_max: z.number().int().positive().max(100).default(10),
  idle_timeout_ms: z.number().int().positive().default(30_000),
  connection_timeout_ms: z.number().int().positive().default(10_000),
  statement_timeout_ms: z.number().int().min(1_000).max(300_000).default(30_000),
}).strict();

const ServerSchema = z.object({
  name: z.string().min(1).default('Horizon Layer'),
  version: z.literal(packageMetadata.version),
}).strict();

const DashboardSchema = z.object({
  port: z.number().int().min(1).max(65_535).default(4_317),
}).strict();

const HttpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'QDRANT_URL must use http or https').refine((value) => {
  const url = new URL(value);
  return url.username === '' && url.password === '';
}, 'QDRANT_URL must not contain credentials; use QDRANT_API_KEY for authentication');

const RagSchema = z.object({
  enabled: z.boolean().default(false),
  qdrant_url: HttpUrlSchema.default('http://127.0.0.1:6333'),
  api_key: z.string().trim().min(1).optional(),
  collection: z.string().trim().min(1).default(DEFAULT_QDRANT_COLLECTION),
  timeout_ms: z.number().int().min(100).max(120_000).default(5_000),
  embedding_model: z.string().trim().min(1)
    .default('onnx-community/all-MiniLM-L6-v2-ONNX'),
  embedding_revision: z.string().trim().min(1)
    .default('aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f'),
  embedding_dtype: z.enum(['fp32', 'fp16', 'q4', 'q4f16']).default('fp32'),
  allow_download: z.boolean().default(true),
  cache_dir: z.string().trim().min(1),
}).strict().superRefine((value, context) => {
  if (!value.api_key) return;
  const url = new URL(value.qdrant_url);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol === 'http:' && !loopback) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'QDRANT_URL must use https when QDRANT_API_KEY is set for a non-loopback host',
      path: ['qdrant_url'],
    });
  }
});

const ConfigSchema = z.object({
  dashboard: DashboardSchema,
  database: DatabaseSchema,
  rag: RagSchema,
  server: ServerSchema,
}).strict();

export type Config = z.infer<typeof ConfigSchema>;

function optional(value: string | undefined): string | undefined {
  return value == null || value === '' ? undefined : value;
}

function parseBoolean(name: string, value: string | undefined): boolean | undefined {
  const normalized = optional(value)?.toLowerCase();
  if (normalized == null) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be one of: true, false, 1, 0, yes, no, on, off`);
}

function parseNumber(name: string, value: string | undefined): number | undefined {
  const normalized = optional(value);
  if (normalized == null) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

function defaultEmbeddingCacheDir(environment: NodeJS.ProcessEnv): string {
  const cacheRoot = optional(environment.XDG_CACHE_HOME) ?? join(homedir(), '.cache');
  return join(cacheRoot, 'horizonlayer', 'models');
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    dashboard: {
      port: parseNumber('DASHBOARD_PORT', environment.DASHBOARD_PORT),
    },
    database: {
      url: optional(environment.DATABASE_URL),
      host: optional(environment.DB_HOST),
      port: parseNumber('DB_PORT', environment.DB_PORT),
      database: optional(environment.DB_NAME),
      user: optional(environment.DB_USER),
      password: environment.DB_PASSWORD,
      ssl_mode: optional(environment.DB_SSL_MODE),
      ssl_reject_unauthorized: parseBoolean(
        'DB_SSL_REJECT_UNAUTHORIZED',
        environment.DB_SSL_REJECT_UNAUTHORIZED
      ),
      pool_max: parseNumber('DB_POOL_MAX', environment.DB_POOL_MAX),
      idle_timeout_ms: parseNumber('DB_IDLE_TIMEOUT_MS', environment.DB_IDLE_TIMEOUT_MS),
      connection_timeout_ms: parseNumber(
        'DB_CONNECTION_TIMEOUT_MS',
        environment.DB_CONNECTION_TIMEOUT_MS
      ),
      statement_timeout_ms: parseNumber(
        'DB_STATEMENT_TIMEOUT_MS',
        environment.DB_STATEMENT_TIMEOUT_MS
      ),
    },
    rag: {
      enabled: parseBoolean('RAG_ENABLED', environment.RAG_ENABLED),
      qdrant_url: optional(environment.QDRANT_URL),
      api_key: optional(environment.QDRANT_API_KEY),
      collection: optional(environment.QDRANT_COLLECTION),
      timeout_ms: parseNumber('QDRANT_TIMEOUT_MS', environment.QDRANT_TIMEOUT_MS),
      embedding_model: optional(environment.EMBEDDING_MODEL),
      embedding_revision: optional(environment.EMBEDDING_REVISION),
      embedding_dtype: optional(environment.EMBEDDING_DTYPE),
      allow_download: parseBoolean(
        'EMBEDDING_ALLOW_DOWNLOAD',
        environment.EMBEDDING_ALLOW_DOWNLOAD
      ),
      cache_dir: optional(environment.EMBEDDING_CACHE_DIR)
        ?? defaultEmbeddingCacheDir(environment),
    },
    server: {
      name: optional(environment.APP_NAME),
      version: packageMetadata.version,
    },
  });
}

export const config = loadConfig();
