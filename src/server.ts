import { FastMCP } from 'fastmcp';
import { config } from './config.js';
import { registerWorkspaceTools } from './tools/workspaces.js';
import { registerPageTools } from './tools/pages.js';
import { registerDatabaseTools } from './tools/databases.js';
import { registerRowTools } from './tools/rows.js';
import { registerSearchTools } from './tools/search.js';
import { registerLinkTools } from './tools/links.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerRunTools } from './tools/runs.js';
import type { AppServer, AppSessionData } from './mcp.js';

export function createAppServer(): AppServer {
  const server = new FastMCP<AppSessionData>({
    name: config.server.name,
    version: config.server.version as `${number}.${number}.${number}`,
  });

  registerWorkspaceTools(server);
  registerPageTools(server);
  registerDatabaseTools(server);
  registerRowTools(server);
  registerSearchTools(server);
  registerLinkTools(server);
  registerTaskTools(server);
  registerRunTools(server);

  return server;
}
