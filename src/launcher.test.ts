import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  databaseUnavailableGuidance,
  hasExplicitRuntimeOverride,
  isQdrantReady,
  isDatabaseUnavailable,
  localRuntimeRecoveryGuidance,
  parseLauncherCommand,
  parseLauncherMode,
  resolveManagedRuntimeForLaunch,
  shouldProvisionManagedRuntime,
  shouldStartSavedRuntime,
} from './launcher.js';
import type { LocalRuntimeConfig } from './localRuntime.js';

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
    expect(parseLauncherMode(['dashboard'])).toBe('dashboard');
    expect(parseLauncherMode(['setup'])).toBe('setup');
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
    expect(() => parseLauncherMode(['dashboard', '--other'])).toThrow('dashboard [--open]');
    expect(() => parseLauncherMode(['install', 'codex', 'extra'])).toThrow('Unknown command');
    expect(() => parseLauncherMode(['unknown'])).toThrow('Unknown command: unknown');
  });

  it('restores saved managed services for MCP and dashboard starts after stop', () => {
    expect(shouldStartSavedRuntime('mcp')).toBe(true);
    expect(shouldStartSavedRuntime('dashboard')).toBe(true);
    expect(shouldStartSavedRuntime('mcp', true)).toBe(false);
    expect(shouldStartSavedRuntime('dashboard', true)).toBe(false);
    expect(shouldStartSavedRuntime('doctor')).toBe(false);
    expect(shouldStartSavedRuntime('reset')).toBe(false);
    expect(shouldStartSavedRuntime('setup')).toBe(false);
  });

  it('provisions the saved Compose runtime for a first local MCP or dashboard launch', () => {
    expect(shouldProvisionManagedRuntime(false)).toBe(true);
    expect(shouldProvisionManagedRuntime(false, true)).toBe(false);
    expect(shouldProvisionManagedRuntime(true)).toBe(false);
    expect(hasExplicitRuntimeOverride({ QDRANT_URL: 'http://127.0.0.1:6333' })).toBe(true);
    expect(hasExplicitRuntimeOverride({ RAG_ENABLED: 'false' })).toBe(true);
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
