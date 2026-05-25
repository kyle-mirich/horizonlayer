import { beforeEach, describe, expect, it, vi } from 'vitest';

const runMigrationsMock = vi.fn();
const closePoolMock = vi.fn();
const startMock = vi.fn();
const stopMock = vi.fn();
const createAppServerMock = vi.fn();

vi.mock('./db/migrate.js', () => ({
  runMigrations: runMigrationsMock,
}));

vi.mock('./db/client.js', () => ({
  closePool: closePoolMock,
}));

vi.mock('./server.js', () => ({
  createAppServer: createAppServerMock,
}));

vi.mock('./config.js', () => ({
  config: {
    server: {
      endpoint: '/mcp',
      host: '0.0.0.0',
      port: 3000,
      transport: 'httpStream',
    },
  },
}));

describe('runServer transport startup', () => {
  beforeEach(() => {
    runMigrationsMock.mockReset().mockResolvedValue(undefined);
    closePoolMock.mockReset().mockResolvedValue(undefined);
    startMock.mockReset().mockResolvedValue(undefined);
    stopMock.mockReset().mockResolvedValue(undefined);
    createAppServerMock.mockReset().mockReturnValue({
      start: startMock,
      stop: stopMock,
    });
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
});
