import { beforeEach, describe, expect, it, vi } from 'vitest';

const initializeDatabaseMock = vi.fn();
const closePoolMock = vi.fn();
const disposeEmbeddingProviderMock = vi.fn();
const startMock = vi.fn();
const stopMock = vi.fn();
const serverOnceMock = vi.fn();
const createAppServerMock = vi.fn();
const stdinOnceSpy = vi.spyOn(process.stdin, 'once');
const processOnceSpy = vi.spyOn(process, 'once');
const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

vi.mock('./db/initialize.js', () => ({
  initializeDatabase: initializeDatabaseMock,
}));

vi.mock('./db/client.js', () => ({
  closePool: closePoolMock,
}));

vi.mock('./search/embedder.js', () => ({
  disposeEmbeddingProvider: disposeEmbeddingProviderMock,
}));

vi.mock('./server.js', () => ({
  createAppServer: createAppServerMock,
}));

describe('runServer stdio runtime', () => {
  beforeEach(() => {
    initializeDatabaseMock.mockReset().mockResolvedValue(undefined);
    closePoolMock.mockReset().mockResolvedValue(undefined);
    disposeEmbeddingProviderMock.mockReset().mockResolvedValue(undefined);
    startMock.mockReset().mockResolvedValue(undefined);
    stopMock.mockReset().mockResolvedValue(undefined);
    serverOnceMock.mockReset();
    createAppServerMock.mockReset().mockReturnValue({
      once: serverOnceMock,
      start: startMock,
      stop: stopMock,
    });
    stdinOnceSpy.mockReset().mockReturnValue(process.stdin);
    processOnceSpy.mockReset().mockReturnValue(process);
    processExitSpy.mockClear();
  });

  it('always starts the official SDK adapter over stdio after database initialization', async () => {
    const { runServer } = await import('./runServer.js');
    await runServer();

    expect(initializeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(createAppServerMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith({
      transportType: 'stdio',
    });
  });

  it('shares one idempotent shutdown across signal handlers', async () => {
    const { runServer } = await import('./runServer.js');
    await runServer();

    const sigintHandler = processOnceSpy.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as
      | (() => Promise<void>)
      | undefined;
    const sigtermHandler = processOnceSpy.mock.calls.find(([event]) => event === 'SIGTERM')?.[1] as
      | (() => Promise<void>)
      | undefined;

    expect(sigintHandler).toBeDefined();
    expect(sigtermHandler).toBeDefined();
    await Promise.all([sigintHandler?.(), sigtermHandler?.()]);

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(disposeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('stays idempotent when stop synchronously emits disconnect', async () => {
    const { runServer } = await import('./runServer.js');
    await runServer();

    const disconnectHandler = serverOnceMock.mock.calls.find(([event]) => event === 'disconnect')?.[1] as
      | (() => void)
      | undefined;
    stopMock.mockImplementationOnce(async () => disconnectHandler?.());
    const sigintHandler = processOnceSpy.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as
      | (() => Promise<void>)
      | undefined;

    await sigintHandler?.();

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(disposeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('cleans up after the stdio transport disconnects without forcing process exit', async () => {
    const { runServer } = await import('./runServer.js');
    await runServer();

    const disconnectHandler = serverOnceMock.mock.calls.find(([event]) => event === 'disconnect')?.[1] as
      | (() => void)
      | undefined;
    expect(disconnectHandler).toBeDefined();
    disconnectHandler?.();
    await vi.waitFor(() => {
      expect(closePoolMock).toHaveBeenCalledTimes(1);
    });

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(disposeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('shares cleanup across stdin end and close without forcing process exit', async () => {
    const { runServer } = await import('./runServer.js');
    await runServer();

    const stdinCalls = stdinOnceSpy.mock.calls as unknown as Array<[string, (...args: unknown[]) => void]>;
    const endHandler = stdinCalls.find(([event]) => event === 'end')?.[1] as
      | (() => void)
      | undefined;
    const closeHandler = stdinCalls.find(([event]) => event === 'close')?.[1] as
      | (() => void)
      | undefined;

    expect(endHandler).toBeDefined();
    expect(closeHandler).toBeDefined();
    endHandler?.();
    closeHandler?.();
    await vi.waitFor(() => {
      expect(closePoolMock).toHaveBeenCalledTimes(1);
    });

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(disposeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('cleans up safely when server startup fails', async () => {
    startMock.mockRejectedValueOnce(new Error('start failed'));

    const { runServer } = await import('./runServer.js');
    await expect(runServer()).rejects.toThrow('start failed');

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(disposeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(processOnceSpy).not.toHaveBeenCalled();
  });

  it('closes the pool when database initialization fails before a server exists', async () => {
    initializeDatabaseMock.mockRejectedValueOnce(new Error('initialization failed'));

    const { runServer } = await import('./runServer.js');
    await expect(runServer()).rejects.toThrow('initialization failed');

    expect(createAppServerMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();
    expect(disposeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(processOnceSpy).not.toHaveBeenCalled();
  });

  it('continues closing the database when embedding disposal fails', async () => {
    disposeEmbeddingProviderMock.mockRejectedValueOnce(new Error('dispose failed'));

    const { runServer } = await import('./runServer.js');
    await runServer();

    const sigintHandler = processOnceSpy.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as
      | (() => Promise<void>)
      | undefined;
    await sigintHandler?.();

    expect(disposeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('reports signal cleanup failures after attempting every teardown step', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { runServer } = await import('./runServer.js');
    await runServer();
    stopMock.mockRejectedValueOnce(new Error('stop failed'));
    disposeEmbeddingProviderMock.mockRejectedValueOnce(new Error('dispose failed'));
    closePoolMock.mockRejectedValueOnce(new Error('pool failed'));

    const sigtermHandler = processOnceSpy.mock.calls.find(([event]) => event === 'SIGTERM')?.[1] as
      | (() => Promise<void>)
      | undefined;
    await sigtermHandler?.();

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(disposeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Runtime shutdown failed: stop failed');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('preserves a startup failure when its compensating cleanup also fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    startMock.mockRejectedValueOnce(new Error('start failed'));
    stopMock.mockRejectedValueOnce(new Error('stop failed'));

    const { runServer } = await import('./runServer.js');
    await expect(runServer()).rejects.toThrow('start failed');

    expect(disposeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Runtime cleanup failed after startup error: stop failed'
    );
  });

  it('reports failed disconnect cleanup without exiting the parent process', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { runServer } = await import('./runServer.js');
    await runServer();
    stopMock.mockRejectedValueOnce(new Error('disconnect stop failed'));

    const disconnectHandler = serverOnceMock.mock.calls.find(([event]) => event === 'disconnect')?.[1] as
      | (() => void)
      | undefined;
    disconnectHandler?.();
    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Runtime shutdown failed after stdio disconnect: disconnect stop failed'
      );
    });

    expect(disposeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('cleans up immediately when stdio was already closed during startup', async () => {
    Object.defineProperty(process.stdin, 'readableEnded', {
      configurable: true,
      value: true,
    });
    try {
      const { runServer } = await import('./runServer.js');
      await runServer();
    } finally {
      delete (process.stdin as unknown as { readableEnded?: boolean }).readableEnded;
    }

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(disposeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('formats non-Error failures during startup cleanup', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    startMock.mockRejectedValueOnce(new Error('start failed'));
    stopMock.mockRejectedValueOnce('string cleanup failure');

    const { runServer } = await import('./runServer.js');
    await expect(runServer()).rejects.toThrow('start failed');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Runtime cleanup failed after startup error: string cleanup failure'
    );
  });

  it('formats non-Error failures from signal and disconnect handlers', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { runServer } = await import('./runServer.js');
    await runServer();
    stopMock.mockRejectedValueOnce('string signal failure');

    const sigintHandler = processOnceSpy.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as
      | (() => Promise<void>)
      | undefined;
    await sigintHandler?.();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Runtime shutdown failed: string signal failure');

    await runServer();
    stopMock.mockRejectedValueOnce('string disconnect failure');
    const disconnectHandler = serverOnceMock.mock.calls.at(-1)?.[1] as (() => void) | undefined;
    disconnectHandler?.();
    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Runtime shutdown failed after stdio disconnect: string disconnect failure'
      );
    });
  });

  it('formats a non-Error failure from an already-ended stdio stream', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(process.stdin, 'readableEnded', {
      configurable: true,
      value: true,
    });
    stopMock.mockRejectedValueOnce('string closed stream failure');
    try {
      const { runServer } = await import('./runServer.js');
      await runServer();
    } finally {
      delete (process.stdin as unknown as { readableEnded?: boolean }).readableEnded;
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Runtime shutdown failed after stdio disconnect: string closed stream failure'
    );
  });
});
