import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  databaseUnavailableGuidance,
  isHelpFlag,
  isQdrantReady,
  isDatabaseUnavailable,
  launcherVersion,
  localRuntimeRecoveryGuidance,
  parseDashboardPort,
  parseDashboardPortValue,
  parseLauncherCommand,
  parseLauncherMode,
  resolveManagedRuntimeForLaunch,
  runWithDatabaseGuidance,
  shouldProvisionManagedRuntime,
  shouldStartSavedRuntime,
  warmLocalRagBestEffort,
} from './launcher.js';
import { hasExplicitRuntimeOverride, type LocalRuntimeConfig } from './localRuntime.js';
import { reloadConfig } from './config.js';

const localRuntime: LocalRuntimeConfig = {
  compose_project: 'horizonlayer',
  database_name: 'horizon_layer',
  database_password: 'test-password',
  database_port: 55_432,
  database_user: 'postgres',
  qdrant_port: 6_333,
  version: 1,
};

describe('launcher commands', () => {
  it('keeps stdio MCP as the zero-argument default and accepts an explicit mode', () => {
    expect(parseLauncherMode([])).toBe('mcp');
    expect(parseLauncherMode(['mcp'])).toBe('mcp');
    expect(parseLauncherMode(['legacy-mcp'])).toBe('legacy-mcp');
    expect(parseLauncherMode(['dashboard'])).toBe('dashboard');
    expect(parseLauncherMode(['setup'])).toBe('setup');
    expect(parseLauncherMode(['backup'])).toBe('backup');
    expect(parseLauncherMode(['recover', 'knowledge.hlbackup'])).toBe('recover');
    expect(parseLauncherMode(['recover', 'knowledge.hlbackup', '--yes'])).toBe('recover');
    expect(parseLauncherMode(['doctor'])).toBe('doctor');
    expect(parseLauncherMode(['reset'])).toBe('reset');
    expect(parseLauncherMode(['reset', '--yes'])).toBe('reset');
    expect(parseLauncherMode(['stop'])).toBe('stop');
    expect(parseLauncherMode(['install'])).toBe('install');
    expect(parseLauncherMode(['install', 'codex'])).toBe('install');
    expect(parseLauncherMode(['install', 'claude'])).toBe('install');
  });

  it('supports help and rejects ambiguous commands', () => {
    expect(parseLauncherMode(['--help'])).toBe('help');
    expect(parseLauncherMode(['-h'])).toBe('help');
    expect(parseLauncherMode(['help'])).toBe('help');
    expect(parseLauncherCommand(['dashboard', '--open'])).toEqual({
      confirmReset: false,
      mode: 'dashboard',
      openDashboard: true,
    });
    expect(parseLauncherCommand(['reset'])).toEqual({
      confirmReset: false,
      mode: 'reset',
      openDashboard: false,
    });
    expect(parseLauncherCommand(['reset', '--yes'])).toEqual({
      confirmReset: true,
      mode: 'reset',
      openDashboard: false,
    });
    expect(parseLauncherCommand(['backup'])).toEqual({
      backupPath: undefined,
      confirmReset: false,
      mode: 'backup',
      openDashboard: false,
    });
    expect(parseLauncherCommand(['backup', 'knowledge.hlbackup'])).toEqual({
      backupPath: 'knowledge.hlbackup',
      confirmReset: false,
      mode: 'backup',
      openDashboard: false,
    });
    expect(parseLauncherCommand(['recover', 'knowledge.hlbackup'])).toEqual({
      confirmRecovery: false,
      confirmReset: false,
      mode: 'recover',
      openDashboard: false,
      recoveryPath: 'knowledge.hlbackup',
    });
    expect(parseLauncherCommand(['recover', 'knowledge.hlbackup', '--yes'])).toEqual({
      confirmRecovery: true,
      confirmReset: false,
      mode: 'recover',
      openDashboard: false,
      recoveryPath: 'knowledge.hlbackup',
    });
    expect(() => parseLauncherMode(['dashboard', '--other'])).toThrow('dashboard [--open]');
    expect(() => parseLauncherMode(['install', 'codex', 'extra'])).toThrow('Unknown command');
    expect(() => parseLauncherMode(['backup', 'one.hlbackup', 'extra'])).toThrow('Unknown command');
    expect(() => parseLauncherMode(['recover'])).toThrow('Unknown command');
    expect(() => parseLauncherMode(['recover', '--yes'])).toThrow('Unknown command');
    expect(() => parseLauncherMode(['recover', '--yes', 'knowledge.hlbackup'])).toThrow('Unknown command');
    expect(() => parseLauncherMode(['recover', 'knowledge.hlbackup', '--force'])).toThrow('Unknown command');
    expect(() => parseLauncherMode(['recover', 'knowledge.hlbackup', '--yes', 'extra'])).toThrow('Unknown command');
    expect(() => parseLauncherMode(['unknown'])).toThrow('Unknown command: unknown');
  });

  it('restores saved managed services for MCP and dashboard starts after stop', () => {
    expect(shouldStartSavedRuntime('mcp')).toBe(true);
    expect(shouldStartSavedRuntime('legacy-mcp')).toBe(true);
    expect(shouldStartSavedRuntime('dashboard')).toBe(true);
    expect(shouldStartSavedRuntime('mcp', true)).toBe(false);
    expect(shouldStartSavedRuntime('dashboard', true)).toBe(false);
    expect(shouldStartSavedRuntime('doctor')).toBe(false);
    expect(shouldStartSavedRuntime('recover')).toBe(false);
    expect(shouldStartSavedRuntime('reset')).toBe(false);
    expect(shouldStartSavedRuntime('setup')).toBe(false);
  });

  it('provisions the saved Compose runtime for a first local MCP or dashboard launch', () => {
    expect(shouldProvisionManagedRuntime(false)).toBe(true);
    expect(shouldProvisionManagedRuntime(false, true)).toBe(false);
    expect(shouldProvisionManagedRuntime(true)).toBe(false);
    expect(hasExplicitRuntimeOverride({ DATABASE_URL: 'postgres://external/db' })).toBe(true);
    expect(hasExplicitRuntimeOverride({ DATABASE_URL: '' })).toBe(false);
    expect(hasExplicitRuntimeOverride({ QDRANT_URL: 'http://127.0.0.1:6333' })).toBe(false);
    expect(hasExplicitRuntimeOverride({ RAG_ENABLED: 'false' })).toBe(false);
    expect(hasExplicitRuntimeOverride({})).toBe(false);
  });

  it('persists and reuses the managed runtime after first-launch provisioning', async () => {
    const provision = vi.fn(async () => undefined);
    const reread = vi.fn(async () => localRuntime);

    await expect(resolveManagedRuntimeForLaunch(null, false, provision, reread)).resolves.toEqual({
      localRuntime,
      provisionedManagedRuntime: true,
    });
    expect(provision).toHaveBeenCalledOnce();
    expect(reread).toHaveBeenCalledOnce();

    const noProvision = vi.fn(async () => undefined);
    const noReread = vi.fn(async () => localRuntime);
    await expect(resolveManagedRuntimeForLaunch(localRuntime, false, noProvision, noReread)).resolves.toEqual({
      localRuntime,
      provisionedManagedRuntime: false,
    });
    await expect(resolveManagedRuntimeForLaunch(null, true, noProvision, noReread)).resolves.toEqual({
      localRuntime: null,
      provisionedManagedRuntime: false,
    });
    expect(noProvision).not.toHaveBeenCalled();
    expect(noReread).not.toHaveBeenCalled();

    await expect(resolveManagedRuntimeForLaunch(
      null,
      false,
      async () => undefined,
      async () => null
    )).rejects.toThrow('without saving its local runtime configuration');
  });

  it('supports --version and per-subcommand help without disturbing existing modes', () => {
    expect(parseLauncherMode(['--version'])).toBe('version');
    expect(parseLauncherMode(['-v'])).toBe('version');
    expect(parseLauncherCommand(['--version'])).toEqual({
      confirmReset: false,
      mode: 'version',
      openDashboard: false,
    });
    expect(launcherVersion()).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(isHelpFlag('--help')).toBe(true);
    expect(isHelpFlag('-h')).toBe(true);
    expect(isHelpFlag('help')).toBe(true);
    expect(isHelpFlag('--other')).toBe(false);
    for (const args of [
      ['setup', '--help'],
      ['setup', '--modules', 'knowledge', '--help'],
      ['install', '--help'],
      ['dashboard', '--help'],
      ['dashboard', '--open', '--help'],
      ['doctor', '-h'],
    ]) {
      expect(parseLauncherMode(args)).toBe('help');
    }
    expect(parseLauncherMode(['setup'])).toBe('setup');
    expect(parseLauncherMode(['install', 'codex'])).toBe('install');
  });

  it('parses dashboard --open and --port combinations and rejects bad ports', () => {
    expect(parseLauncherCommand(['dashboard'])).toEqual({
      confirmReset: false,
      dashboardPort: undefined,
      mode: 'dashboard',
      openDashboard: false,
    });
    expect(parseLauncherCommand(['dashboard', '--open'])).toEqual({
      confirmReset: false,
      dashboardPort: undefined,
      mode: 'dashboard',
      openDashboard: true,
    });
    expect(parseLauncherCommand(['dashboard', '--port', '8080'])).toMatchObject({
      dashboardPort: 8080,
      mode: 'dashboard',
      openDashboard: false,
    });
    expect(parseLauncherCommand(['dashboard', '--open', '--port=8080'])).toMatchObject({
      dashboardPort: 8080,
      openDashboard: true,
    });
    expect(parseDashboardPort(['dashboard'])).toBeUndefined();
    expect(parseDashboardPortValue('4317')).toBe(4317);
    for (const value of ['0', '65536', 'not-a-port', '4317.5', '']) {
      expect(() => parseDashboardPortValue(value)).toThrow(`Invalid dashboard port: ${value}`);
    }
    expect(() => parseLauncherMode(['dashboard', '--other'])).toThrow('dashboard [--open]');
    expect(() => parseLauncherMode(['dashboard', '--port'])).toThrow('--port requires a value');
    expect(() => parseLauncherMode(['dashboard', '--port', '0'])).toThrow('Invalid dashboard port: 0');
  });

  it('shares the redacted database-unavailability guidance with every entry point', async () => {
    await expect(runWithDatabaseGuidance(async () => undefined)).resolves.toBeUndefined();

    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://agent:secret@db.example:5432/knowledge';
    try {
      await expect(runWithDatabaseGuidance(async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      })).rejects.toThrow('PostgreSQL is unavailable at postgres://db.example:5432/knowledge');
      await expect(runWithDatabaseGuidance(async () => {
        throw new Error('schema relation is invalid');
      })).rejects.toThrow('schema relation is invalid');
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    }

    delete process.env.DATABASE_URL;
    try {
      await expect(runWithDatabaseGuidance(async () => {
        throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      })).rejects.toThrow('connection refused');
    } finally {
      if (previousUrl !== undefined) process.env.DATABASE_URL = previousUrl;
    }
  });

  it('degrades the embedding warm-up to RAG-disabled with a warning', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const previousRag = process.env.RAG_ENABLED;
    try {
      await expect(warmLocalRagBestEffort(async () => undefined)).resolves.toBe(true);
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(expect.stringContaining('could not be loaded'));

      consoleErrorSpy.mockClear();
      await expect(warmLocalRagBestEffort(async () => {
        throw new Error('model download failed');
      })).resolves.toBe(false);
      expect(process.env.RAG_ENABLED).toBe('false');
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('could not be loaded'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('RAG disabled'));
    } finally {
      consoleErrorSpy.mockRestore();
      if (previousRag === undefined) delete process.env.RAG_ENABLED;
      else process.env.RAG_ENABLED = previousRag;
      reloadConfig();
    }
  });

  it('provides a distinct recovery action for every unavailable managed dependency', () => {
    expect(localRuntimeRecoveryGuidance({
      databaseReady: false,
      dockerReady: false,
      qdrantReady: false,
    })).toEqual([
      'Recovery: start Docker Desktop (or Docker Engine), then run `horizonlayer setup`.',
      expect.stringContaining('PostgreSQL recovery'),
      expect.stringContaining('Qdrant recovery'),
    ]);
    expect(localRuntimeRecoveryGuidance({
      databaseReady: true,
      dockerReady: true,
      qdrantReady: true,
    })).toEqual([]);
  });

  it('turns external PostgreSQL connection failures into a redacted recovery message', () => {
    for (const code of ['ECONNREFUSED', '08006', '57P03', '53300']) {
      expect(isDatabaseUnavailable({ code })).toBe(true);
    }
    expect(isDatabaseUnavailable(new Error('connection timeout'))).toBe(true);
    expect(isDatabaseUnavailable(new Error('schema relation is invalid'))).toBe(false);
    expect(databaseUnavailableGuidance('postgres://agent:secret@db.example:5432/knowledge')).toBe(
      'PostgreSQL is unavailable at postgres://db.example:5432/knowledge. '
      + 'Check DATABASE_URL and that PostgreSQL is running, or run `horizonlayer setup` '
      + 'to restore the managed local runtime.'
    );
    const punctuationPassword = databaseUnavailableGuidance(
      'postgres://agent:pass:word@db.example:5432/knowledge?password=querysecret&sslkey=/tmp/key'
    );
    expect(punctuationPassword).toContain('postgres://db.example:5432/knowledge');
    expect(punctuationPassword).not.toContain('pass:word');
    expect(punctuationPassword).not.toContain('querysecret');
    expect(punctuationPassword).not.toContain('sslkey');
    expect(databaseUnavailableGuidance('postgres://agent:pass/word@db.example/knowledge'))
      .toContain('<invalid DATABASE_URL>');
  });
});

describe('Qdrant readiness probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes the unauthenticated readiness endpoint and handles failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(isQdrantReady('http://127.0.0.1:6333')).resolves.toBe(true);
    await expect(isQdrantReady('http://127.0.0.1:6333')).resolves.toBe(false);
    await expect(isQdrantReady('http://127.0.0.1:6333')).resolves.toBe(false);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(new URL('http://127.0.0.1:6333/readyz'));
  });
});
