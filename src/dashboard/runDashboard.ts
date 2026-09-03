import type { Server } from 'node:http';

import { config } from '../config.js';
import { closePool, getPool } from '../db/client.js';
import { initializeDatabase } from '../db/initialize.js';
import { disposeEmbeddingProvider } from '../search/embedder.js';
import { createAppServer } from '../server.js';
import { createDashboardHttpServer } from './http.js';

const DASHBOARD_HOST = '127.0.0.1';
const SHUTDOWN_GRACE_MS = 5_000;

export interface DashboardRuntime {
  readonly url: string;
  shutdown(): Promise<void>;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(mapListenError(error, port));
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: DASHBOARD_HOST, port });
  });
}

function closeHttpServer(server: Server | null): Promise<void> {
  if (!server?.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(forceCloseTimer);
      if (error) reject(error);
      else resolve();
    };
    const forceCloseTimer = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, SHUTDOWN_GRACE_MS);
    forceCloseTimer.unref();

    try {
      server.close((error) => finish(error));
      server.closeIdleConnections();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function dashboardPortConflictGuidance(port: number): string {
  return `HorizonLayer dashboard port ${port} is already in use. `
    + 'Stop the process using that port, set DASHBOARD_PORT to a free port, '
    + 'or start the dashboard with `horizonlayer dashboard --port <port>`.';
}

export function isPortConflict(error: unknown): boolean {
  const code = error != null && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof code === 'string' && code === 'EADDRINUSE') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('EADDRINUSE');
}

function mapListenError(error: Error, port: number): Error {
  if (!isPortConflict(error)) return error;
  const conflict = new Error(dashboardPortConflictGuidance(port));
  (conflict as { cause?: unknown }).cause = error;
  return conflict;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startDashboard(): Promise<DashboardRuntime> {
  let httpServer: Server | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = Promise.resolve().then(async () => {
        let firstError: unknown;

        try {
          await closeHttpServer(httpServer);
        } catch (error) {
          firstError = error;
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

        if (firstError) throw firstError;
      });
    }
    return shutdownPromise;
  };

  try {
    await initializeDatabase();
    const appServer = createAppServer({ catalogMode: 'legacy' });
    httpServer = createDashboardHttpServer({
      appServer,
      databaseHealth: async () => {
        try {
          await getPool().query('SELECT 1');
          return true;
        } catch {
          return false;
        }
      },
      ragEnabled: config.rag.enabled,
      version: config.server.version,
    });
    await listen(httpServer, config.dashboard.port);
  } catch (error) {
    try {
      await shutdown();
    } catch (cleanupError) {
      console.error(`Dashboard cleanup failed after startup error: ${errorMessage(cleanupError)}`);
    }
    throw error;
  }

  const url = `http://${DASHBOARD_HOST}:${config.dashboard.port}`;
  console.error(`HorizonLayer dashboard: ${url}`);
  return { shutdown, url };
}

export async function runDashboard(): Promise<DashboardRuntime> {
  const runtime = await startDashboard();
  let shutdownPromise: Promise<void> | null = null;

  const unregisterSignals = (): void => {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  };

  const shutdown = (): Promise<void> => {
    unregisterSignals();
    shutdownPromise ??= runtime.shutdown();
    return shutdownPromise;
  };

  const handleSignal = async (): Promise<void> => {
    try {
      await shutdown();
    } catch (error) {
      console.error(`Dashboard shutdown failed: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  return { shutdown, url: runtime.url };
}
