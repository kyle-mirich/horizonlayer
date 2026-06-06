import { FastMCP } from 'fastmcp';
import { config } from './config.js';
import { registerCoreTools } from './tools/core.js';
import type { AppServer, AppSessionData } from './mcp.js';

export function createAppServer(): AppServer {
  const server = new FastMCP<AppSessionData>({
    health: {
      enabled: true,
      path: config.server.health_path,
    },
    name: config.server.name,
    version: config.server.version as `${number}.${number}.${number}`,
  });

  registerCoreTools(server);

  return server;
}
