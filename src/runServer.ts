import { runMigrations } from './db/migrate.js';
import { closePool } from './db/client.js';
import { createAppServer } from './server.js';
import { config } from './config.js';

export async function runServer(): Promise<void> {
  await runMigrations();

  const server = createAppServer();
  if (config.server.transport === 'httpStream') {
    await server.start({
      transportType: 'httpStream',
      httpStream: {
        endpoint: config.server.endpoint as `/${string}`,
        host: config.server.host,
        port: config.server.port,
      },
    });
  } else {
    await server.start({
      transportType: 'stdio',
    });
  }

  const shutdown = async (): Promise<void> => {
    await server.stop();
    await closePool();
  };

  process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });
}
