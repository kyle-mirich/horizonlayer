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

const SecuritySchema = z.object({
  cookie_secret: z.string().min(32).default('local-horizon-layer-cookie-secret-01234'),
  encryption_key: z.string().min(32).default('local-horizon-layer-encryption-key-01'),
  secure_cookies: z.boolean().optional(),
  session_cookie_name: z.string().default('horizon_layer_session'),
  session_ttl_hours: z.number().int().positive().default(24 * 7),
  session_absolute_ttl_hours: z.number().int().positive().default(24 * 14),
  refresh_token_ttl_days: z.number().int().positive().default(30),
  auth_code_ttl_minutes: z.number().int().positive().default(10),
});

const LocalAuthSchema = z.object({
  enabled: z.boolean().default(false),
});

const SsoSchema = z.object({
  enabled: z.boolean().default(false),
  default_scopes: z.array(z.string()).default(['openid', 'profile', 'email']),
  provider_type: z.enum(['google_oidc', 'microsoft_oidc', 'generic_oidc']).optional(),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  issuer_url: z.string().url().optional(),
  tenant_id: z.string().min(1).optional(),
  authorization_endpoint: z.string().url().optional(),
  token_endpoint: z.string().url().optional(),
  token_endpoint_auth_method: z.enum(['client_secret_basic', 'client_secret_post']).optional(),
  allowed_domains: z.array(z.string()).default([]),
  token_storage_dir: z.string().min(1).optional(),
});

const AuthSchema = z.object({
  enabled: z.boolean().default(false),
  scopes_supported: z.array(z.string().min(1)).default(['mcp:tools']),
  local: LocalAuthSchema.default({}),
  sso: SsoSchema.default({}),
  security: SecuritySchema.default({}),
});

const ConfigSchema = z.object({
  database: DatabaseSchema,
  embedding: EmbeddingSchema.default({}),
  server: ServerSchema,
  auth: AuthSchema,
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
  const scopesSupported = parseCsv(process.env.OAUTH_SCOPES_SUPPORTED);
  const ssoScopes = parseCsv(process.env.SSO_DEFAULT_SCOPES);
  const allowedDomains = parseCsv(process.env.SSO_ALLOWED_DOMAINS);

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
    auth: {
      enabled: parseBoolean(process.env.AUTH_ENABLED),
      scopes_supported: scopesSupported,
      local: {
        enabled: parseBoolean(process.env.LOCAL_AUTH_ENABLED),
      },
      sso: {
        enabled: parseBoolean(process.env.SSO_ENABLED),
        default_scopes: ssoScopes,
        provider_type: process.env.SSO_PROVIDER_TYPE,
        client_id: process.env.SSO_CLIENT_ID,
        client_secret: process.env.SSO_CLIENT_SECRET,
        issuer_url: process.env.SSO_ISSUER_URL,
        tenant_id: process.env.SSO_TENANT_ID,
        authorization_endpoint: process.env.SSO_AUTHORIZATION_ENDPOINT,
        token_endpoint: process.env.SSO_TOKEN_ENDPOINT,
        token_endpoint_auth_method: process.env.SSO_TOKEN_ENDPOINT_AUTH_METHOD,
        allowed_domains: allowedDomains,
        token_storage_dir: process.env.SSO_TOKEN_STORAGE_DIR,
      },
      security: {
        cookie_secret: process.env.COOKIE_SECRET,
        encryption_key: process.env.ENCRYPTION_KEY,
        secure_cookies: parseBoolean(process.env.SECURE_COOKIES),
        session_cookie_name: process.env.SESSION_COOKIE_NAME,
        session_ttl_hours: parseNumber(process.env.SESSION_TTL_HOURS),
        session_absolute_ttl_hours: parseNumber(process.env.SESSION_ABSOLUTE_TTL_HOURS),
        refresh_token_ttl_days: parseNumber(process.env.REFRESH_TOKEN_TTL_DAYS),
        auth_code_ttl_minutes: parseNumber(process.env.AUTH_CODE_TTL_MINUTES),
      },
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
