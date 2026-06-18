import { beforeEach, describe, expect, it, vi } from 'vitest';

const runMigrationsMock = vi.fn();
const closePoolMock = vi.fn();
const startMock = vi.fn();
const stopMock = vi.fn();
const createAppServerMock = vi.fn();
const startDashboardApiServerMock = vi.fn();
const closeDashboardApiServerMock = vi.fn();
const processOnSpy = vi.spyOn(process, 'on');
const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

const configState = vi.hoisted(() => ({
  dashboard_api: {
    enabled: false,
    host: '127.0.0.1',
    port: 3737,
  },
  server: {
    endpoint: '/mcp',
    host: '0.0.0.0',
    port: 3000,
    transport: 'httpStream',
  },
}));

vi.mock('./db/migrate.js', () => ({
  runMigrations: runMigrationsMock,
}));

vi.mock('./db/client.js', () => ({
  closePool: closePoolMock,
}));

vi.mock('./server.js', () => ({
  createAppServer: createAppServerMock,
}));

vi.mock('./dashboardApi.js', () => ({
  startDashboardApiServer: startDashboardApiServerMock,
}));

vi.mock('./config.js', () => ({
  config: configState,
}));

describe('runServer transport startup', () => {
  beforeEach(() => {
    configState.server.transport = 'httpStream';
    configState.dashboard_api.enabled = false;
    runMigrationsMock.mockReset().mockResolvedValue(undefined);
    closePoolMock.mockReset().mockResolvedValue(undefined);
    startMock.mockReset().mockResolvedValue(undefined);
    stopMock.mockReset().mockResolvedValue(undefined);
    createAppServerMock.mockReset().mockReturnValue({
      start: startMock,
      stop: stopMock,
    });
    closeDashboardApiServerMock.mockReset().mockResolvedValue(undefined);
    startDashboardApiServerMock.mockReset().mockResolvedValue({
      close: closeDashboardApiServerMock,
      url: 'http://127.0.0.1:3737',
    });
    processOnSpy.mockReset().mockReturnValue(process);
    processExitSpy.mockClear();
  });

  it('starts FastMCP with httpStream options when HTTP transport is configured', async () => {
    const { runServer } = await import('./runServer.js');
    await runServer();

    expect(runMigrationsMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith({
      transportType: 'httpStream',
      httpStream: {
        endpoint: '/mcp',
        host: '0.0.0.0',
        port: 3000,
      },
    });
  });

  it('starts FastMCP over stdio when stdio transport is configured', async () => {
    configState.server.transport = 'stdio';
    const { runServer } = await import('./runServer.js');
    await runServer();

    expect(startMock).toHaveBeenCalledWith({
      transportType: 'stdio',
    });
  });

  it('starts the dashboard API when enabled', async () => {
    configState.dashboard_api.enabled = true;

    const { runServer } = await import('./runServer.js');
    await runServer();

    expect(startDashboardApiServerMock).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 3737,
    });
  });

  it('registers shutdown handlers that stop the server and close the pool', async () => {
    const { runServer } = await import('./runServer.js');
    await runServer();

    const sigintHandler = processOnSpy.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as (() => Promise<void>) | undefined;
    expect(sigintHandler).toBeDefined();
    await sigintHandler?.();

    expect(closeDashboardApiServerMock).not.toHaveBeenCalled();
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('closes the dashboard API during shutdown when it was started', async () => {
    configState.dashboard_api.enabled = true;

    const { runServer } = await import('./runServer.js');
    await runServer();

    const sigtermHandler = processOnSpy.mock.calls.find(([event]) => event === 'SIGTERM')?.[1] as (() => Promise<void>) | undefined;
    expect(sigtermHandler).toBeDefined();
    await sigtermHandler?.();

    expect(closeDashboardApiServerMock).toHaveBeenCalledTimes(1);
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(closePoolMock).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });
});
