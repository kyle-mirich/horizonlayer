import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const CONFIG_VERSION = 1;
const DEFAULT_DATABASE_PORTS = [55_432, 55_433, 55_434, 55_435];
const DEFAULT_QDRANT_PORTS = [6_333, 56_333, 56_334, 56_335];

export interface LocalRuntimeConfig {
  compose_project: string;
  database_name: string;
  database_password: string;
  database_port: number;
  database_user: string;
  qdrant_port: number;
  version: 1;
}

interface CommandSpec {
  args: string[];
  command: string;
}

interface CommandResult {
  error?: NodeJS.ErrnoException;
  status: number | null;
  stderr: string;
  stdout: string;
}

export class LocalRuntimeError extends Error {
  constructor(message: string, readonly details?: string) {
    super(message);
    this.name = 'LocalRuntimeError';
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; inherit?: boolean } = {}
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  return {
    error: result.error as NodeJS.ErrnoException | undefined,
    status: result.status,
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
  };
}

export function localRuntimeDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir()
): string {
  if (environment.HORIZONLAYER_HOME) return environment.HORIZONLAYER_HOME;
  if (platform === 'darwin') {
    return join(homeDirectory, 'Library', 'Application Support', 'HorizonLayer');
  }
  if (platform === 'win32') {
    return join(environment.LOCALAPPDATA ?? join(homeDirectory, 'AppData', 'Local'), 'HorizonLayer');
  }
  return join(environment.XDG_CONFIG_HOME ?? join(homeDirectory, '.config'), 'horizonlayer');
}

export function localRuntimeConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir()
): string {
  return join(localRuntimeDirectory(environment, platform, homeDirectory), 'runtime.json');
}

export function bundledComposePath(metaUrl = import.meta.url): string {
  return fileURLToPath(new URL('../docker-compose.yml', metaUrl));
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535;
}

export function parseLocalRuntimeConfig(value: unknown): LocalRuntimeConfig {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalRuntimeError('HorizonLayer runtime configuration must contain a JSON object.');
  }
  const config = value as Partial<LocalRuntimeConfig>;
  if (config.version !== CONFIG_VERSION
    || typeof config.compose_project !== 'string'
    || typeof config.database_name !== 'string'
    || typeof config.database_password !== 'string'
    || typeof config.database_user !== 'string'
    || !validPort(config.database_port)
    || !validPort(config.qdrant_port)) {
    throw new LocalRuntimeError('HorizonLayer runtime configuration is invalid or unsupported.');
  }
  return config as LocalRuntimeConfig;
}

export async function readLocalRuntimeConfig(
  path = localRuntimeConfigPath()
): Promise<LocalRuntimeConfig | null> {
  try {
    return parseLocalRuntimeConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof LocalRuntimeError) throw error;
    throw new LocalRuntimeError(
      `Cannot read HorizonLayer runtime configuration at ${path}.`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function writeLocalRuntimeConfig(
  config: LocalRuntimeConfig,
  path = localRuntimeConfigPath()
): Promise<void> {
  parseLocalRuntimeConfig(config);
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.write-${randomUUID()}`;
  await writeFile(staging, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(staging, path);
}

export function runtimeEnvironment(config: LocalRuntimeConfig): NodeJS.ProcessEnv {
  const encodedUser = encodeURIComponent(config.database_user);
  const encodedPassword = encodeURIComponent(config.database_password);
  const encodedDatabase = encodeURIComponent(config.database_name);
  return {
    COMPOSE_PROJECT_NAME: config.compose_project,
    DATABASE_URL: `postgres://${encodedUser}:${encodedPassword}@127.0.0.1:${config.database_port}/${encodedDatabase}`,
    DB_HOST: '127.0.0.1',
    DB_NAME: config.database_name,
    DB_PASSWORD: config.database_password,
    DB_PORT: String(config.database_port),
    DB_USER: config.database_user,
    QDRANT_PORT: String(config.qdrant_port),
    QDRANT_URL: `http://127.0.0.1:${config.qdrant_port}`,
    RAG_ENABLED: 'true',
  };
}

export function applyLocalRuntimeEnvironment(
  config: LocalRuntimeConfig,
  environment: NodeJS.ProcessEnv = process.env
): void {
  for (const [name, value] of Object.entries(runtimeEnvironment(config))) {
    if (environment[name] == null && value != null) environment[name] = value;
  }
}

function dockerInfo(): CommandResult {
  return runCommand('docker', ['info', '--format', '{{.ServerVersion}}']);
}

export function dockerDesktopLaunchCommand(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): CommandSpec | null {
  if (platform === 'darwin') return { command: 'open', args: ['-a', 'Docker'] };
  if (platform === 'win32') {
    const programFiles = environment.ProgramFiles ?? 'C:\\Program Files';
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath '${win32.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe').replaceAll("'", "''")}'`,
      ],
    };
  }
  return null;
}

export async function ensureDockerDesktopReady(timeoutMs = 120_000): Promise<void> {
  const initial = dockerInfo();
  if (!initial.error && initial.status === 0) return;
  if (initial.error?.code === 'ENOENT') {
    throw new LocalRuntimeError(
      'Docker Desktop is not installed. Install Docker Desktop for macOS or Windows, then run `horizonlayer setup` again.',
      'https://www.docker.com/products/docker-desktop/'
    );
  }

  const launch = dockerDesktopLaunchCommand();
  if (!launch) {
    throw new LocalRuntimeError(
      'Docker is installed, but its daemon is unavailable. Start Docker and run `horizonlayer setup` again.',
      initial.stderr || initial.stdout
    );
  }

  console.error('Starting Docker Desktop...');
  const started = runCommand(launch.command, launch.args);
  if (started.error || started.status !== 0) {
    throw new LocalRuntimeError(
      'Docker Desktop could not be opened automatically. Start it manually, then run `horizonlayer setup` again.',
      started.error?.message || started.stderr || started.stdout
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const probe = dockerInfo();
    if (!probe.error && probe.status === 0) return;
  }
  throw new LocalRuntimeError(
    'Docker Desktop did not become ready in time. Finish Docker Desktop setup, then run `horizonlayer setup` again.'
  );
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function choosePort(candidates: number[]): Promise<number> {
  for (const port of candidates) {
    if (await portAvailable(port)) return port;
  }
  throw new LocalRuntimeError(`No available local port found among: ${candidates.join(', ')}`);
}

export async function createLocalRuntimeConfig(): Promise<LocalRuntimeConfig> {
  return {
    compose_project: 'horizonlayer',
    database_name: 'horizon_layer',
    database_password: randomUUID().replaceAll('-', ''),
    database_port: await choosePort(DEFAULT_DATABASE_PORTS),
    database_user: 'postgres',
    qdrant_port: await choosePort(DEFAULT_QDRANT_PORTS),
    version: CONFIG_VERSION,
  };
}

export function runCompose(
  action: 'start' | 'stop',
  config: LocalRuntimeConfig,
  composePath = bundledComposePath()
): void {
  if (!existsSync(composePath)) {
    throw new LocalRuntimeError(`Bundled Docker Compose file is missing from ${composePath}.`);
  }
  const args = ['compose', '-f', composePath, '-p', config.compose_project];
  if (action === 'start') args.push('up', '-d');
  else args.push('stop');
  const result = runCommand('docker', args, {
    env: { ...process.env, ...runtimeEnvironment(config) },
    inherit: true,
  });
  if (result.error || result.status !== 0) {
    throw new LocalRuntimeError(
      `Docker Compose could not ${action === 'start' ? 'start' : 'stop'} HorizonLayer services.`,
      result.error?.message || result.stderr || result.stdout
    );
  }
}

export function openDashboardUrl(
  url: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  let command: CommandSpec | null = null;
  if (platform === 'darwin') command = { command: 'open', args: [url] };
  if (platform === 'win32') command = { command: 'explorer.exe', args: [url] };
  if (platform === 'linux') command = { command: 'xdg-open', args: [url] };
  if (!command) return false;
  const result = runCommand(command.command, command.args);
  return !result.error && result.status === 0;
}
