import { beforeEach, describe, expect, it, vi } from 'vitest';

const initializeDatabaseMock = vi.fn();
const closePoolMock = vi.fn();
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

vi.mock('./server.js', () => ({
  createAppServer: createAppServerMock,
}));

describe('runServer stdio runtime', () => {
  beforeEach(() => {
    initializeDatabaseMock.mockReset().mockResolvedValue(undefined);
    closePoolMock.mockReset().mockResolvedValue(undefined);
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
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('cleans up safely when server startup fails', async () => {
    startMock.mockRejectedValueOnce(new Error('start failed'));

    const { runServer } = await import('./runServer.js');
    await expect(runServer()).rejects.toThrow('start failed');

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(processOnceSpy).not.toHaveBeenCalled();
  });

  it('closes the pool when database initialization fails before a server exists', async () => {
    initializeDatabaseMock.mockRejectedValueOnce(new Error('initialization failed'));

    const { runServer } = await import('./runServer.js');
    await expect(runServer()).rejects.toThrow('initialization failed');

    expect(createAppServerMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(processOnceSpy).not.toHaveBeenCalled();
  });
});
