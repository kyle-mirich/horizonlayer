import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closePool: vi.fn(),
  createAppServer: vi.fn(),
  createDashboardHttpServer: vi.fn(),
  disposeEmbeddingProvider: vi.fn(),
  poolQuery: vi.fn(),
  initializeDatabase: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    dashboard: { port: 7_788 },
    rag: { enabled: true },
    server: { version: '2.0.0' },
  },
}));

vi.mock('../db/client.js', () => ({
  closePool: mocks.closePool,
  getPool: () => ({ query: mocks.poolQuery }),
}));

vi.mock('../db/initialize.js', () => ({
  initializeDatabase: mocks.initializeDatabase,
}));

vi.mock('../search/embedder.js', () => ({
  disposeEmbeddingProvider: mocks.disposeEmbeddingProvider,
}));

vi.mock('../server.js', () => ({
  createAppServer: mocks.createAppServer,
}));

vi.mock('./http.js', () => ({
  createDashboardHttpServer: mocks.createDashboardHttpServer,
}));

class FakeHttpServer extends EventEmitter {
  listening = false;
  listenError: Error | null = null;
  closeError: Error | null = null;
  closeHangs = false;

  readonly listen = vi.fn((_options: { host: string; port: number }) => {
    this.listening = true;
    queueMicrotask(() => {
      if (this.listenError) {
        this.listening = false;
        this.emit('error', this.listenError);
      } else {
        this.emit('listening');
      }
    });
    return this;
  });

  readonly close = vi.fn((callback?: (error?: Error) => void) => {
    this.listening = false;
    if (!this.closeHangs) queueMicrotask(() => callback?.(this.closeError ?? undefined));
    return this;
  });

  readonly closeAllConnections = vi.fn();
  readonly closeIdleConnections = vi.fn();
}

const appServer = { callTool: vi.fn() };
const processOnceSpy = vi.spyOn(process, 'once').mockReturnValue(process);
const processOffSpy = vi.spyOn(process, 'off').mockReturnValue(process);
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

let httpServer: FakeHttpServer;

describe('dashboard runtime', () => {
  beforeEach(() => {
    httpServer = new FakeHttpServer();
    mocks.initializeDatabase.mockReset().mockResolvedValue(undefined);
    mocks.createAppServer.mockReset().mockReturnValue(appServer);
    mocks.createDashboardHttpServer.mockReset()
      .mockReturnValue(httpServer as unknown as Server);
    mocks.disposeEmbeddingProvider.mockReset().mockResolvedValue(undefined);
    mocks.poolQuery.mockReset().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    mocks.closePool.mockReset().mockResolvedValue(undefined);
    processOnceSpy.mockReset().mockReturnValue(process);
    processOffSpy.mockReset().mockReturnValue(process);
    consoleErrorSpy.mockClear();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('initializes storage and listens only on the literal IPv4 loopback address', async () => {
    const { startDashboard } = await import('./runDashboard.js');
    const runtime = await startDashboard();

    expect(mocks.initializeDatabase).toHaveBeenCalledTimes(1);
    expect(mocks.createAppServer).toHaveBeenCalledTimes(1);
    expect(mocks.createAppServer).toHaveBeenCalledWith({ catalogMode: 'legacy' });
    expect(mocks.createDashboardHttpServer).toHaveBeenCalledWith({
      appServer,
      databaseHealth: expect.any(Function),
      ragEnabled: true,
      version: '2.0.0',
    });
    expect(httpServer.listen).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 7_788,
    });
    expect(runtime.url).toBe('http://127.0.0.1:7788');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'HorizonLayer dashboard: http://127.0.0.1:7788'
    );

    expect(mocks.initializeDatabase.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createAppServer.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.createAppServer.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createDashboardHttpServer.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.createDashboardHttpServer.mock.invocationCallOrder[0])
      .toBeLessThan(httpServer.listen.mock.invocationCallOrder[0] ?? 0);

    await runtime.shutdown();
  });

  it('uses a fresh PostgreSQL probe for dashboard health without throwing details', async () => {
    const { startDashboard } = await import('./runDashboard.js');
    const runtime = await startDashboard();
    const options = mocks.createDashboardHttpServer.mock.calls[0]?.[0] as {
      databaseHealth(): Promise<boolean>;
    };

    await expect(options.databaseHealth()).resolves.toBe(true);
    mocks.poolQuery.mockRejectedValueOnce(new Error('secret connection detail'));
    await expect(options.databaseHealth()).resolves.toBe(false);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
    expect(mocks.poolQuery).toHaveBeenCalledWith('SELECT 1');

    await runtime.shutdown();
  });

  it('shares one ordered graceful shutdown across repeated calls', async () => {
    const { startDashboard } = await import('./runDashboard.js');
    const runtime = await startDashboard();

    await Promise.all([runtime.shutdown(), runtime.shutdown(), runtime.shutdown()]);

    expect(httpServer.close).toHaveBeenCalledTimes(1);
    expect(httpServer.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(mocks.disposeEmbeddingProvider).toHaveBeenCalledTimes(1);
    expect(mocks.closePool).toHaveBeenCalledTimes(1);
    expect(httpServer.close.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.disposeEmbeddingProvider.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.disposeEmbeddingProvider.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.closePool.mock.invocationCallOrder[0] ?? 0);
  });

  it('force-closes active connections after a bounded graceful shutdown window', async () => {
    const { startDashboard } = await import('./runDashboard.js');
    const runtime = await startDashboard();
    httpServer.closeHangs = true;
    vi.useFakeTimers();

    try {
      const shutdown = runtime.shutdown();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(shutdown).resolves.toBeUndefined();

      expect(httpServer.close).toHaveBeenCalledTimes(1);
      expect(httpServer.closeIdleConnections).toHaveBeenCalledTimes(1);
      expect(httpServer.closeAllConnections).toHaveBeenCalledTimes(1);
      expect(mocks.disposeEmbeddingProvider).toHaveBeenCalledTimes(1);
      expect(mocks.closePool).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes SIGINT and SIGTERM through the same shutdown without forcing exit', async () => {
    const { runDashboard } = await import('./runDashboard.js');
    await runDashboard();

    const sigintHandler = processOnceSpy.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as
      | (() => Promise<void>)
      | undefined;
    const sigtermHandler = processOnceSpy.mock.calls.find(([event]) => event === 'SIGTERM')?.[1] as
      | (() => Promise<void>)
      | undefined;

    expect(sigintHandler).toBeDefined();
    expect(sigtermHandler).toBeDefined();
    await Promise.all([sigintHandler?.(), sigtermHandler?.()]);

    expect(httpServer.close).toHaveBeenCalledTimes(1);
    expect(mocks.disposeEmbeddingProvider).toHaveBeenCalledTimes(1);
    expect(mocks.closePool).toHaveBeenCalledTimes(1);
    expect(processOffSpy).toHaveBeenCalledWith('SIGINT', sigintHandler);
    expect(processOffSpy).toHaveBeenCalledWith('SIGTERM', sigtermHandler);
    expect(process.exitCode).toBeUndefined();
  });

  it('cleans initialized resources when HTTP listen fails', async () => {
    httpServer.listenError = new Error('address in use');
    const { startDashboard } = await import('./runDashboard.js');

    await expect(startDashboard()).rejects.toThrow('address in use');

    expect(mocks.disposeEmbeddingProvider).toHaveBeenCalledTimes(1);
    expect(mocks.closePool).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('HorizonLayer dashboard:')
    );
  });

  it('cleans the pool even when database initialization fails', async () => {
    mocks.initializeDatabase.mockRejectedValueOnce(new Error('database unavailable'));
    const { startDashboard } = await import('./runDashboard.js');

    await expect(startDashboard()).rejects.toThrow('database unavailable');

    expect(mocks.createAppServer).not.toHaveBeenCalled();
    expect(mocks.createDashboardHttpServer).not.toHaveBeenCalled();
    expect(mocks.disposeEmbeddingProvider).toHaveBeenCalledTimes(1);
    expect(mocks.closePool).toHaveBeenCalledTimes(1);
  });

  it('continues cleanup after an HTTP close error and preserves the first failure', async () => {
    httpServer.closeError = new Error('HTTP close failed');
    mocks.disposeEmbeddingProvider.mockRejectedValueOnce(new Error('embedding dispose failed'));
    const { startDashboard } = await import('./runDashboard.js');
    const runtime = await startDashboard();

    await expect(runtime.shutdown()).rejects.toThrow('HTTP close failed');

    expect(httpServer.close).toHaveBeenCalledTimes(1);
    expect(mocks.disposeEmbeddingProvider).toHaveBeenCalledTimes(1);
    expect(mocks.closePool).toHaveBeenCalledTimes(1);
    await expect(runtime.shutdown()).rejects.toThrow('HTTP close failed');
    expect(httpServer.close).toHaveBeenCalledTimes(1);
  });

  it('reports signal cleanup failures without calling process.exit', async () => {
    mocks.closePool.mockRejectedValueOnce(new Error('pool close failed'));
    const { runDashboard } = await import('./runDashboard.js');
    await runDashboard();
    const sigintHandler = processOnceSpy.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as
      | (() => Promise<void>)
      | undefined;

    await sigintHandler?.();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Dashboard shutdown failed: pool close failed'
    );
    expect(process.exitCode).toBe(1);
  });
});
