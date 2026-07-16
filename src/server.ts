import { config } from './config.js';
import { registerCoreTools } from './tools/core.js';
import { AppServer } from './mcp.js';

export function createAppServer(): AppServer {
  const server = new AppServer({
    instructions: [
      'HorizonLayer is durable, workspace-scoped memory for coding agents.',
      'Begin with workspace list or create, then session start with the returned workspace_id.',
      'Use page for unstructured knowledge, database and row for structured knowledge, search to retrieve either, and link for explicit relationships.',
      'The optional run tool records execution history and checkpoints; it does not schedule or claim tasks.',
      'Reuse returned IDs and revisions. Mutations that change existing knowledge require the latest revision; archive and restore replace public hard deletes.',
    ].join(' '),
    name: config.server.name,
    version: config.server.version,
  });

  registerCoreTools(server);

  return server;
}
