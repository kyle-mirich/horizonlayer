import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyLocalRuntimeEnvironment,
  acquireLocalRuntimeSetupLock,
  bundledComposePath,
  chooseLocalPort,
  composeProjectForEnvironment,
  createLocalRuntimeConfig,
  dockerDesktopLaunchCommand,
  ensureDockerDesktopReady,
  hasExplicitRuntimeOverride,
  isDockerDaemonReady,
  localRuntimeConfigPath,
  localRuntimeDirectory,
  openDashboardUrl,
  parseLocalRuntimeConfig,
  readLocalRuntimeConfig,
  removeLocalRuntimeConfig,
  runCompose,
  runtimeEnvironment,
  withLocalRuntimeLifecycleLock,
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
    expect(() => parseLocalRuntimeConfig({ ...config, compose_project: '' })).toThrow('invalid');
    expect(() => parseLocalRuntimeConfig({ ...config, compose_project: 'not a project' })).toThrow('invalid');
    expect(() => parseLocalRuntimeConfig({ ...config, database_name: '' })).toThrow('invalid');
    expect(() => parseLocalRuntimeConfig({ ...config, database_password: '' })).toThrow('invalid');
    expect(() => parseLocalRuntimeConfig({ ...config, database_user: '' })).toThrow('invalid');
    expect(() => parseLocalRuntimeConfig({ ...config, qdrant_port: config.database_port })).toThrow('invalid');
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

  it('preserves explicit process overrides unless setup explicitly owns the runtime environment', () => {
    const environment: NodeJS.ProcessEnv = { DATABASE_URL: 'postgres://external/database' };
    applyLocalRuntimeEnvironment(config, environment);
    expect(environment.DATABASE_URL).toBe('postgres://external/database');
    expect(environment.QDRANT_URL).toBe('http://127.0.0.1:6333');

    applyLocalRuntimeEnvironment(config, environment, true);
    expect(environment.DATABASE_URL).toBe(runtimeEnvironment(config).DATABASE_URL);
  });

  it('writes and reads a private, validated runtime configuration', async () => {
    const path = await temporaryPath('nested/runtime.json');
    await writeLocalRuntimeConfig(config, path);

    expect(await readLocalRuntimeConfig(path)).toEqual(config);
    await expect(readFile(path, 'utf8')).resolves.toContain('"compose_project": "horizonlayer"');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    await removeLocalRuntimeConfig(path);
    expect(await readLocalRuntimeConfig(path)).toBeNull();
  });

  it('distinguishes a missing configuration from malformed or unsupported content', async () => {
    const missing = await temporaryPath('missing.json');
    expect(await readLocalRuntimeConfig(missing)).toBeNull();

    const malformed = await temporaryPath('malformed.json');
    await writeFile(malformed, '{not json}', 'utf8');
    await expect(readLocalRuntimeConfig(malformed)).rejects.toMatchObject({
      name: 'LocalRuntimeError',
      message: expect.stringContaining('Restore a valid runtime.json backup'),
    });

    const unsupported = await temporaryPath('unsupported.json');
    await writeFile(unsupported, JSON.stringify({ ...config, version: 999 }), 'utf8');
    await expect(readLocalRuntimeConfig(unsupported)).rejects.toThrow('Restore a valid runtime.json backup');
    await expect(writeLocalRuntimeConfig({ ...config, database_port: -1 }, unsupported))
      .rejects.toThrow('invalid or unsupported');
  });

  it('serializes lifecycle commands so concurrent mutations cannot overwrite generated credentials', async () => {
    const path = await temporaryPath('runtime.json');
    const first = await acquireLocalRuntimeSetupLock(path);

    await expect(acquireLocalRuntimeSetupLock(path)).rejects.toThrow(
      'Another HorizonLayer lifecycle command is already running'
    );
    await first.release();

    const second = await acquireLocalRuntimeSetupLock(path);
    await second.release();
  });

  it('holds one lifecycle lock across the complete operation', async () => {
    const path = await temporaryPath('runtime.json');
    let finishFirst: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = withLocalRuntimeLifecycleLock(async () => {
      markStarted?.();
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    }, path);

    await started;
    await expect(withLocalRuntimeLifecycleLock(async () => undefined, path)).rejects.toThrow(
      'Another HorizonLayer lifecycle command is already running'
    );
    finishFirst?.();
    await first;

    await expect(withLocalRuntimeLifecycleLock(async () => 'safe', path)).resolves.toBe('safe');
  });

  it('chooses free default service ports and isolates explicit runtime homes', async () => {
    const generated = await createLocalRuntimeConfig({});
    expect(generated).toMatchObject({
      compose_project: 'horizonlayer',
      database_name: 'horizon_layer',
      database_user: 'postgres',
      version: 1,
    });
    expect([55_432, 55_433, 55_434, 55_435]).toContain(generated.database_port);
    expect([6_333, 56_333, 56_334, 56_335]).toContain(generated.qdrant_port);
    expect(generated.database_password).toMatch(/^[0-9a-f]{32}$/);

    const firstHome = '/tmp/horizonlayer-first';
    const secondHome = '/tmp/horizonlayer-second';
    expect(composeProjectForEnvironment({})).toBe('horizonlayer');
    expect(composeProjectForEnvironment({ HORIZONLAYER_HOME: firstHome }))
      .toMatch(/^horizonlayer-[a-f0-9]{12}$/u);
    expect(composeProjectForEnvironment({ HORIZONLAYER_HOME: firstHome }))
      .toBe(composeProjectForEnvironment({ HORIZONLAYER_HOME: firstHome }));
    expect(composeProjectForEnvironment({ HORIZONLAYER_HOME: firstHome }))
      .not.toBe(composeProjectForEnvironment({ HORIZONLAYER_HOME: secondHome }));

    const isolated = await createLocalRuntimeConfig({ HORIZONLAYER_HOME: firstHome });
    expect(isolated.compose_project).toBe(composeProjectForEnvironment({ HORIZONLAYER_HOME: firstHome }));
  });

  it('explains how to recover when every managed port candidate is occupied', async () => {
    await expect(chooseLocalPort([55_432, 55_433], async () => false)).rejects.toThrow(
      'Stop the process using one of those loopback ports'
    );
  });
});

describe('explicit runtime overrides', () => {
  it('treats only DATABASE_URL as a user-managed runtime marker', () => {
    expect(hasExplicitRuntimeOverride({ DATABASE_URL: 'postgres://external/db' })).toBe(true);
    expect(hasExplicitRuntimeOverride({ DATABASE_URL: '' })).toBe(false);
    expect(hasExplicitRuntimeOverride({ QDRANT_URL: 'http://127.0.0.1:6333' })).toBe(false);
    expect(hasExplicitRuntimeOverride({ RAG_ENABLED: 'true' })).toBe(false);
    expect(hasExplicitRuntimeOverride({ RAG_ENABLED: 'false' })).toBe(false);
    expect(hasExplicitRuntimeOverride({})).toBe(false);
  });
});

describe('local runtime service commands', () => {
  it('checks Docker daemon availability without attempting to launch Docker Desktop', () => {
    spawnSyncMock.mockReturnValueOnce(commandResult());
    expect(isDockerDaemonReady()).toBe(true);

    spawnSyncMock.mockReturnValueOnce(commandResult({ status: 1, stderr: 'daemon unavailable' }));
    expect(isDockerDaemonReady()).toBe(false);
  });

  it('treats a ready Docker daemon as immediately usable and explains a missing Docker installation', async () => {
    spawnSyncMock.mockReturnValueOnce(commandResult());
    await expect(ensureDockerDesktopReady()).resolves.toBeUndefined();

    spawnSyncMock.mockReturnValueOnce(commandResult({
      error: Object.assign(new Error('missing docker'), { code: 'ENOENT' }),
      status: null,
    }));
    await expect(ensureDockerDesktopReady()).rejects.toMatchObject({
      message: expect.stringContaining('is not installed'),
    });

    spawnSyncMock.mockReset().mockReturnValueOnce(commandResult({
      error: Object.assign(new Error('missing docker'), { code: 'ENOENT' }),
      status: null,
    }));
    await expect(ensureDockerDesktopReady(120_000, 'linux')).rejects.toMatchObject({
      message: expect.stringContaining('Docker Engine (or Docker Desktop) is not installed'),
    });
  });

  it('starts Docker Desktop when available and reports launch or readiness failures', async () => {
    spawnSyncMock.mockReturnValueOnce(commandResult({ status: 1, stderr: 'daemon unavailable' }));
    await expect(ensureDockerDesktopReady(120_000, 'linux')).rejects.toMatchObject({
      message: expect.stringContaining('daemon is unavailable'),
    });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    spawnSyncMock.mockReset()
      .mockReturnValueOnce(commandResult({ status: 1, stderr: 'daemon unavailable' }))
      .mockReturnValueOnce(commandResult({ status: 1, stderr: 'launch failed' }));
    await expect(ensureDockerDesktopReady(120_000, 'darwin')).rejects.toMatchObject({
      message: expect.stringContaining('could not be opened automatically'),
      details: 'launch failed',
    });

    spawnSyncMock
      .mockReset()
      .mockReturnValueOnce(commandResult({ status: 1 }))
      .mockReturnValueOnce(commandResult());
    await expect(ensureDockerDesktopReady(0, 'darwin')).rejects.toThrow('did not become ready in time');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Starting Docker Desktop...');
  });

  it('waits for Docker Desktop to become ready after launching it', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    spawnSyncMock
      .mockReturnValueOnce(commandResult({ status: 1 }))
      .mockReturnValueOnce(commandResult())
      .mockReturnValueOnce(commandResult());
    vi.useFakeTimers();
    const ready = ensureDockerDesktopReady(2_000, 'darwin');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(ready).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Starting Docker Desktop...');
  });

  it('runs compose start, stop, and destructive reset with the generated runtime environment', async () => {
    const composePath = await temporaryPath('compose.yml');
    await writeFile(composePath, 'services: {}\n', 'utf8');
    spawnSyncMock.mockReturnValue(commandResult());
    runCompose('start', config, composePath);
    runCompose('stop', config, composePath);
    runCompose('reset', config, composePath);

    expect(spawnSyncMock).toHaveBeenNthCalledWith(1, 'docker', [
      'compose', '-f', composePath, '-p', 'horizonlayer', 'up', '-d',
    ], expect.objectContaining({
      env: expect.objectContaining({ DATABASE_URL: runtimeEnvironment(config).DATABASE_URL }),
      stdio: 'inherit',
    }));
    expect(spawnSyncMock).toHaveBeenNthCalledWith(2, 'docker', [
      'compose', '-f', composePath, '-p', 'horizonlayer', 'stop',
    ], expect.anything());
    expect(spawnSyncMock).toHaveBeenNthCalledWith(3, 'docker', [
      'compose', '-f', composePath, '-p', 'horizonlayer', 'down', '--volumes', '--remove-orphans',
    ], expect.anything());
  });

  it('reports missing compose files and command failures with recovery guidance', () => {
    expect(() => runCompose('start', config, '/definitely/missing/compose.yml'))
      .toThrow('Reinstall HorizonLayer');

    spawnSyncMock.mockReturnValueOnce(commandResult({ status: 1, stderr: 'compose error' }));
    spawnSyncMock.mockReturnValueOnce(commandResult());
    expect(() => runCompose('start', config, import.meta.filename)).toThrow('free the configured local ports');

    spawnSyncMock.mockReturnValueOnce(commandResult({
      error: Object.assign(new Error('docker missing'), { code: 'ENOENT' }),
      status: null,
    }));
    expect(() => runCompose('stop', config, import.meta.filename)).toThrow('Your data remains in Docker volumes');

    spawnSyncMock.mockReturnValueOnce(commandResult({ status: 1, stderr: 'compose error' }));
    spawnSyncMock.mockReturnValueOnce(commandResult());
    expect(() => runCompose('reset', config, import.meta.filename)).toThrow('configuration was kept');

    spawnSyncMock
      .mockReturnValueOnce(commandResult({ status: 1 }))
      .mockReturnValueOnce(commandResult({ status: 1, stderr: 'compose plugin missing' }));
    expect(() => runCompose('start', config, import.meta.filename)).toThrow('Docker Compose v2 is unavailable');
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
