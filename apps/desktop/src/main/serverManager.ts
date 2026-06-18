import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesktopSettings, ServerStatus } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ManagedServerPorts {
  apiPort: number;
  mcpPort: number;
}

export function buildManagedServerEnv(ports: ManagedServerPorts): Record<string, string> {
  return {
    DASHBOARD_API_ENABLED: 'true',
    DASHBOARD_API_HOST: '127.0.0.1',
    DASHBOARD_API_PORT: String(ports.apiPort),
    HOST: '127.0.0.1',
    PORT: String(ports.mcpPort),
    SERVER_TRANSPORT: 'httpStream',
  };
}

export function defaultServerCommand(): string {
  const repoRoot = path.resolve(__dirname, '../../..');
  return `node ${path.join(repoRoot, 'dist/launcher.js')}`;
}

export class ServerManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lastDetail = 'Not started';

  status(settings: DesktopSettings): ServerStatus {
    return {
      apiBaseUrl: this.apiBaseUrl(settings),
      detail: this.lastDetail,
      mode: settings.mode,
      running: settings.mode === 'external' || this.child != null,
    };
  }

  apiBaseUrl(settings: DesktopSettings): string {
    return settings.mode === 'external'
      ? settings.externalServerUrl.replace(/\/$/, '')
      : `http://127.0.0.1:${settings.localApiPort}`;
  }

  start(settings: DesktopSettings): ServerStatus {
    if (settings.mode === 'external') {
      this.lastDetail = 'Using external server';
      return this.status(settings);
    }
    if (this.child) {
      this.lastDetail = 'Managed server already running';
      return this.status(settings);
    }

    const [command, ...args] = settings.serverCommand.split(' ').filter(Boolean);
    this.child = spawn(command, args, {
      cwd: path.resolve(__dirname, '../../..'),
      env: {
        ...process.env,
        ...buildManagedServerEnv({
          apiPort: settings.localApiPort,
          mcpPort: settings.localMcpPort,
        }),
      },
      stdio: 'pipe',
    });
    this.lastDetail = `Started managed server on ${this.apiBaseUrl(settings)}`;

    this.child.stderr.on('data', (chunk) => {
      this.lastDetail = String(chunk).trim() || this.lastDetail;
    });
    this.child.on('exit', (code) => {
      this.lastDetail = `Managed server exited${code == null ? '' : ` with code ${code}`}`;
      this.child = null;
    });

    return this.status(settings);
  }

  stop(settings: DesktopSettings): ServerStatus {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
      this.lastDetail = 'Stopped managed server';
    }
    return this.status(settings);
  }
}
