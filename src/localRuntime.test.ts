import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyLocalRuntimeEnvironment,
  bundledComposePath,
  createLocalRuntimeConfig,
  dockerDesktopLaunchCommand,
  ensureDockerDesktopReady,
  localRuntimeConfigPath,
  localRuntimeDirectory,
  openDashboardUrl,
  parseLocalRuntimeConfig,
  readLocalRuntimeConfig,
  runCompose,
  runtimeEnvironment,
  writeLocalRuntimeConfig,
  type LocalRuntimeConfig,
} from './localRuntime.js';

const spawnSyncMock = vi.mocked(spawnSync);
const temporaryPaths: string[] = [];

function commandResult(
  result: Partial<{ error: NodeJS.ErrnoException; status: number | null; stderr: string; stdout: string }> = {}
) {
  return {
    error: undefined,
    status: 0,
    stderr: '',
    stdout: '',
    ...result,
  } as ReturnType<typeof spawnSync>;
}

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'horizonlayer-runtime-'));
  temporaryPaths.push(directory);
  return join(directory, name);
}

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

beforeEach(() => {
  spawnSyncMock.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const config: LocalRuntimeConfig = {
  compose_project: 'horizonlayer',
  database_name: 'horizon_layer',
  database_password: 'local-password',
  database_port: 55_432,
  database_user: 'postgres',
  qdrant_port: 6_333,
  version: 1,
};

describe('local runtime paths', () => {
  it('uses native per-user application data locations on macOS and Windows', () => {
    expect(localRuntimeDirectory({}, 'darwin', '/Users/tester')).toBe(
      join('/Users/tester', 'Library', 'Application Support', 'HorizonLayer')
    );
    expect(localRuntimeDirectory(
      { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
      'win32',
      'C:\\Users\\tester'
    )).toBe(join('C:\\Users\\tester\\AppData\\Local', 'HorizonLayer'));
    expect(localRuntimeConfigPath({ HORIZONLAYER_HOME: '/tmp/horizon' }, 'linux', '/home/tester'))
      .toBe('/tmp/horizon/runtime.json');
    expect(localRuntimeDirectory({}, 'linux', '/home/tester')).toBe('/home/tester/.config/horizonlayer');
    expect(localRuntimeDirectory({ XDG_CONFIG_HOME: '/var/config' }, 'linux', '/home/tester'))
      .toBe('/var/config/horizonlayer');
    expect(localRuntimeDirectory({}, 'win32', 'C:\\Users\\tester')).toBe(
      join('C:\\Users\\tester', 'AppData', 'Local', 'HorizonLayer')
    );
  });

  it('builds platform-specific Docker Desktop launch commands', () => {
    expect(dockerDesktopLaunchCommand('darwin')).toEqual({
      command: 'open',
      args: ['-a', 'Docker'],
    });
    expect(dockerDesktopLaunchCommand('win32', { ProgramFiles: 'C:\\Programs' })).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath '${win32.join('C:\\Programs', 'Docker', 'Docker', 'Docker Desktop.exe')}'`,
      ],
    });
    expect(dockerDesktopLaunchCommand('linux')).toBeNull();
    expect(dockerDesktopLaunchCommand('win32', { ProgramFiles: "C:\\O'Brien" })?.args.at(-1))
      .toContain("C:\\O''Brien");
  });

  it('resolves the bundled compose file relative to a supplied module URL', () => {
    expect(bundledComposePath('file:///tmp/horizonlayer/dist/localRuntime.js'))
      .toBe('/tmp/horizonlayer/docker-compose.yml');
  });
});

describe('local runtime configuration', () => {
  it('validates configuration and derives the service environment', () => {
    expect(parseLocalRuntimeConfig(config)).toEqual(config);
    expect(() => parseLocalRuntimeConfig(null)).toThrow('JSON object');
    expect(() => parseLocalRuntimeConfig([])).toThrow('JSON object');
    expect(() => parseLocalRuntimeConfig({ ...config, database_port: 0 })).toThrow('invalid');
    expect(() => parseLocalRuntimeConfig({ ...config, qdrant_port: 65_536 })).toThrow('invalid');
    expect(() => parseLocalRuntimeConfig({ ...config, version: 2 })).toThrow('invalid');
    expect(runtimeEnvironment(config)).toMatchObject({
      COMPOSE_PROJECT_NAME: 'horizonlayer',
      DATABASE_URL: 'postgres://postgres:local-password@127.0.0.1:55432/horizon_layer',
      DB_PORT: '55432',
      QDRANT_PORT: '6333',
      QDRANT_URL: 'http://127.0.0.1:6333',
      RAG_ENABLED: 'true',
    });
    expect(runtimeEnvironment({
      ...config,
      database_name: 'knowledge / notes',
      database_password: 'pa:ss@word',
      database_user: 'agent/user',
    }).DATABASE_URL).toBe(
      'postgres://agent%2Fuser:pa%3Ass%40word@127.0.0.1:55432/knowledge%20%2F%20notes'
    );
  });

  it('preserves explicit process overrides when applying saved configuration', () => {
    const environment: NodeJS.ProcessEnv = { DATABASE_URL: 'postgres://external/database' };
    applyLocalRuntimeEnvironment(config, environment);
    expect(environment.DATABASE_URL).toBe('postgres://external/database');
    expect(environment.QDRANT_URL).toBe('http://127.0.0.1:6333');
  });

  it('writes and reads a private, validated runtime configuration', async () => {
    const path = await temporaryPath('nested/runtime.json');
    await writeLocalRuntimeConfig(config, path);

    expect(await readLocalRuntimeConfig(path)).toEqual(config);
    await expect(readFile(path, 'utf8')).resolves.toContain('"compose_project": "horizonlayer"');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it('distinguishes a missing configuration from malformed or unsupported content', async () => {
    const missing = await temporaryPath('missing.json');
    expect(await readLocalRuntimeConfig(missing)).toBeNull();

    const malformed = await temporaryPath('malformed.json');
    await writeFile(malformed, '{not json}', 'utf8');
    await expect(readLocalRuntimeConfig(malformed)).rejects.toMatchObject({
      name: 'LocalRuntimeError',
      message: expect.stringContaining('Cannot read HorizonLayer runtime configuration'),
    });

    const unsupported = await temporaryPath('unsupported.json');
    await writeFile(unsupported, JSON.stringify({ ...config, version: 999 }), 'utf8');
    await expect(readLocalRuntimeConfig(unsupported)).rejects.toThrow('invalid or unsupported');
    await expect(writeLocalRuntimeConfig({ ...config, database_port: -1 }, unsupported))
      .rejects.toThrow('invalid or unsupported');
  });

  it('chooses free default service ports when creating a local configuration', async () => {
    const generated = await createLocalRuntimeConfig();
    expect(generated).toMatchObject({
      compose_project: 'horizonlayer',
      database_name: 'horizon_layer',
      database_user: 'postgres',
      version: 1,
    });
    expect([55_432, 55_433, 55_434, 55_435]).toContain(generated.database_port);
    expect([6_333, 56_333, 56_334, 56_335]).toContain(generated.qdrant_port);
    expect(generated.database_password).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('local runtime service commands', () => {
  it('treats a ready Docker daemon as immediately usable and explains a missing installation', async () => {
    spawnSyncMock.mockReturnValueOnce(commandResult());
    await expect(ensureDockerDesktopReady()).resolves.toBeUndefined();

    spawnSyncMock.mockReturnValueOnce(commandResult({
      error: Object.assign(new Error('missing docker'), { code: 'ENOENT' }),
      status: null,
    }));
    await expect(ensureDockerDesktopReady()).rejects.toMatchObject({
      message: expect.stringContaining('Docker Desktop is not installed'),
    });
  });

  it('starts Docker Desktop when available and reports launch or readiness failures', async () => {
    const launch = dockerDesktopLaunchCommand();
    if (!launch) {
      spawnSyncMock.mockReturnValueOnce(commandResult({ status: 1, stderr: 'daemon unavailable' }));
      await expect(ensureDockerDesktopReady()).rejects.toMatchObject({
        message: expect.stringContaining('daemon is unavailable'),
      });
      return;
    }

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    spawnSyncMock
      .mockReturnValueOnce(commandResult({ status: 1, stderr: 'daemon unavailable' }))
      .mockReturnValueOnce(commandResult({ status: 1, stderr: 'launch failed' }));
    await expect(ensureDockerDesktopReady()).rejects.toMatchObject({
      message: expect.stringContaining('could not be opened automatically'),
      details: 'launch failed',
    });

    spawnSyncMock
      .mockReset()
      .mockReturnValueOnce(commandResult({ status: 1 }))
      .mockReturnValueOnce(commandResult());
    await expect(ensureDockerDesktopReady(0)).rejects.toThrow('did not become ready in time');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Starting Docker Desktop...');
  });

  it('waits for Docker Desktop to become ready after launching it', async () => {
    const launch = dockerDesktopLaunchCommand();
    if (!launch) return;

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    spawnSyncMock
      .mockReturnValueOnce(commandResult({ status: 1 }))
      .mockReturnValueOnce(commandResult())
      .mockReturnValueOnce(commandResult());
    vi.useFakeTimers();
    const ready = ensureDockerDesktopReady(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(ready).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Starting Docker Desktop...');
  });

  it('runs compose start and stop with the generated runtime environment', async () => {
    const composePath = await temporaryPath('compose.yml');
    await writeFile(composePath, 'services: {}\n', 'utf8');
    spawnSyncMock.mockReturnValue(commandResult());
    runCompose('start', config, composePath);
    runCompose('stop', config, composePath);

    expect(spawnSyncMock).toHaveBeenNthCalledWith(1, 'docker', [
      'compose', '-f', composePath, '-p', 'horizonlayer', 'up', '-d',
    ], expect.objectContaining({
      env: expect.objectContaining({ DATABASE_URL: runtimeEnvironment(config).DATABASE_URL }),
      stdio: 'inherit',
    }));
    expect(spawnSyncMock).toHaveBeenNthCalledWith(2, 'docker', [
      'compose', '-f', composePath, '-p', 'horizonlayer', 'stop',
    ], expect.anything());
  });

  it('reports missing compose files and command failures without opening external programs', () => {
    expect(() => runCompose('start', config, '/definitely/missing/compose.yml'))
      .toThrow('Bundled Docker Compose file is missing');

    spawnSyncMock.mockReturnValueOnce(commandResult({ status: 1, stderr: 'compose error' }));
    expect(() => runCompose('start', config, import.meta.filename)).toThrow('could not start');

    spawnSyncMock.mockReturnValueOnce(commandResult({
      error: Object.assign(new Error('docker missing'), { code: 'ENOENT' }),
      status: null,
    }));
    expect(() => runCompose('stop', config, import.meta.filename)).toThrow('could not stop');
  });

  it('opens dashboard URLs only on supported platforms and propagates launch status', () => {
    expect(openDashboardUrl('http://127.0.0.1:4310', 'freebsd')).toBe(false);

    spawnSyncMock.mockReturnValueOnce(commandResult());
    expect(openDashboardUrl('http://127.0.0.1:4310', 'darwin')).toBe(true);
    expect(spawnSyncMock).toHaveBeenLastCalledWith('open', ['http://127.0.0.1:4310'], expect.anything());

    spawnSyncMock.mockReturnValueOnce(commandResult({ status: 1 }));
    expect(openDashboardUrl('http://127.0.0.1:4310', 'win32')).toBe(false);

    spawnSyncMock.mockReturnValueOnce(commandResult({
      error: Object.assign(new Error('missing browser'), { code: 'ENOENT' }),
      status: null,
    }));
    expect(openDashboardUrl('http://127.0.0.1:4310', 'linux')).toBe(false);
  });
});
