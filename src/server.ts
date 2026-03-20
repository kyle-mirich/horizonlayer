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
import { createFastMcpAuth } from './auth/fastmcp.js';
import type { AppServer, AppSessionData } from './mcp.js';

export function createAppServer(): AppServer {
  const auth = createFastMcpAuth();
  const server = new FastMCP<AppSessionData>({
    ...(auth
      ? {
          authenticate: auth.authenticate,
          oauth: auth.oauth,
        }
      : {}),
    health: {
      path: '/healthz',
    },
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

  const app = server.getApp();
  if (config.server.allowed_hosts.length > 0) {
    const allowedHosts = new Set(config.server.allowed_hosts.map((host) => host.toLowerCase()));
    app.use('*', async (c, next) => {
      if (new URL(c.req.url).pathname === '/healthz') {
        await next();
        return;
      }
      const hostHeader = c.req.header('host');
      const host = hostHeader?.split(':')[0]?.toLowerCase();
      if (!host || !allowedHosts.has(host)) {
        return c.json({ error: 'Host is not allowed' }, 400);
      }
      await next();
    });
  }
  app.get('/favicon.ico', (c) => c.body(null, 204));
  app.get('/', (c) =>
    c.json({
      mode: 'single-user-local',
      name: config.server.name,
      resource_url: config.server.public_url
        ? new URL(config.server.resource_path, config.server.public_url).href
        : undefined,
      single_user: true,
      transport: config.server.transport,
      version: config.server.version,
    })
  );

  return server;
}
