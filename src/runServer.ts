import { initializeDatabase } from './db/initialize.js';
import { closePool } from './db/client.js';
import { createAppServer, type CreateAppServerOptions } from './server.js';
import { disposeEmbeddingProvider } from './search/embedder.js';

export async function runServer(options: CreateAppServerOptions = {}): Promise<void> {
  let server: ReturnType<typeof createAppServer> | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = Promise.resolve().then(async () => {
        let firstError: unknown;

        if (server) {
          try {
            await server.stop();
          } catch (error) {
            firstError = error;
          }
        }

        try {
          await disposeEmbeddingProvider();
        } catch (error) {
          firstError ??= error;
        }

        try {
          await closePool();
        } catch (error) {
          firstError ??= error;
        }

        if (firstError) {
          throw firstError;
        }
      });
    }
    return shutdownPromise;
  };

  try {
    await initializeDatabase();

    server = createAppServer(options);
    await server.start({
      transportType: 'stdio',
    });
  } catch (error) {
    try {
      await shutdown();
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.error(`Runtime cleanup failed after startup error: ${message}`);
    }
    throw error;
  }

  const handleSignal = async (): Promise<void> => {
    try {
      await shutdown();
      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Runtime shutdown failed: ${message}`);
      process.exit(1);
    }
  };

  const handleDisconnect = (): void => {
    void shutdown().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Runtime shutdown failed after stdio disconnect: ${message}`);
    });
  };

  server.once('disconnect', handleDisconnect);
  process.stdin.once('end', handleDisconnect);
  process.stdin.once('close', handleDisconnect);
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  if (process.stdin.readableEnded || process.stdin.destroyed) {
    try {
      await shutdown();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Runtime shutdown failed after stdio disconnect: ${message}`);
    }
  }
}
