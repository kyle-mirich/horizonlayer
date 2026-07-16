import { createRequire } from 'node:module';
import { z } from 'zod';

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
}).strict();

const ServerSchema = z.object({
  name: z.string().min(1).default('Horizon Layer'),
  version: z.literal(packageMetadata.version),
}).strict();

const ConfigSchema = z.object({
  database: DatabaseSchema,
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

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
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
    },
    server: {
      name: optional(environment.APP_NAME),
      version: packageMetadata.version,
    },
  });
}

export const config = loadConfig();
