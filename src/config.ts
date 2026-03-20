import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DatabaseSchema = z.object({
  url: z.string().min(1).optional(),
  host: z.string().default('localhost'),
  port: z.number().int().positive().default(5432),
  database: z.string().default('horizon_layer'),
  user: z.string().default('postgres'),
  password: z.string().default(''),
  ssl_mode: z.enum(['disable', 'require']).default('disable'),
  ssl_reject_unauthorized: z.boolean().default(true),
  pool_max: z.number().int().positive().default(10),
  idle_timeout_ms: z.number().int().positive().default(30000),
  connection_timeout_ms: z.number().int().positive().default(10000),
});

const EmbeddingSchema = z.object({
  model: z.string().default('Xenova/all-MiniLM-L6-v2'),
  dimensions: z.number().int().positive().default(384),
});

const ServerSchema = z.object({
  name: z.string().default('Horizon Layer'),
  version: z.string().default('1.0.0'),
  transport: z.enum(['stdio', 'http']).default('stdio'),
  dev_routes_enabled: z.boolean().default(false),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().positive().default(3000),
  public_url: z.string().url().default('http://127.0.0.1:3000'),
  resource_path: z
    .string()
    .default('/mcp')
    .transform((value) => (value.startsWith('/') ? value : `/${value}`)),
  allowed_hosts: z.array(z.string()).default([]),
});

const ConfigSchema = z.object({
  database: DatabaseSchema,
  embedding: EmbeddingSchema.default({}),
  server: ServerSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

function readYamlConfig(): Record<string, unknown> {
  const configPath = join(__dirname, '..', 'config.yaml');
  const examplePath = join(__dirname, '..', 'config.example.yaml');

  for (const candidate of [configPath, examplePath]) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = yaml.load(raw);
      return (parsed as Record<string, unknown> | null) ?? {};
    } catch {
      continue;
    }
  }

  return {};
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value == null || value === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (value == null || value.trim() === '') return undefined;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildEnvConfig(): Record<string, unknown> {
  const allowedHosts = parseCsv(process.env.ALLOWED_HOSTS);

  return {
    database: {
      url: process.env.DATABASE_URL,
      host: process.env.DB_HOST,
      port: parseNumber(process.env.DB_PORT),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl_mode: process.env.DB_SSL_MODE,
      ssl_reject_unauthorized: parseBoolean(process.env.DB_SSL_REJECT_UNAUTHORIZED),
      pool_max: parseNumber(process.env.DB_POOL_MAX),
      idle_timeout_ms: parseNumber(process.env.DB_IDLE_TIMEOUT_MS),
      connection_timeout_ms: parseNumber(process.env.DB_CONNECTION_TIMEOUT_MS),
    },
    embedding: {
      model: process.env.EMBEDDING_MODEL,
      dimensions: parseNumber(process.env.EMBEDDING_DIMENSIONS),
    },
    server: {
      name: process.env.APP_NAME,
      version: process.env.APP_VERSION,
      transport: process.env.SERVER_TRANSPORT,
      dev_routes_enabled: parseBoolean(process.env.DEV_ROUTES_ENABLED),
      host: process.env.HOST,
      port: parseNumber(process.env.PORT),
      public_url: process.env.APP_BASE_URL,
      resource_path: process.env.MCP_RESOURCE_PATH,
      allowed_hosts: allowedHosts,
    },
  };
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (base == null || override == null) return override ?? base;
  if (Array.isArray(base) || Array.isArray(override)) {
    return override ?? base;
  }
  if (typeof base !== 'object' || typeof override !== 'object') {
    return override;
  }

  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    output[key] = key in output ? deepMerge(output[key], value) : value;
  }
  return output;
}

function loadConfig(): Config {
  const fileConfig = readYamlConfig();
  const envConfig = buildEnvConfig();
  return ConfigSchema.parse(deepMerge(fileConfig, envConfig));
}

export const config = loadConfig();
