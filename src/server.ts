import { config } from './config.js';
import { registerCoreTools } from './tools/core.js';
import { MODULES, registerModuleTools, type HorizonModule, type ToolCatalogMode } from './tools/modules.js';
import { AppServer } from './mcp.js';

export interface CreateAppServerOptions {
  catalogMode?: ToolCatalogMode;
  modules?: readonly HorizonModule[];
}

export function parseSelectedModules(value = process.env.HORIZONLAYER_MODULES): HorizonModule[] {
  if (value === undefined || value.trim() === '' || value.trim().toLowerCase() === 'both') {
    return [...MODULES];
  }
  const modules = [...new Set(value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (modules.length === 0 || modules.some((module) => !MODULES.includes(module as HorizonModule))) {
    throw new Error('HORIZONLAYER_MODULES must be knowledge, issues, or both');
  }
  return modules as HorizonModule[];
}

export function createAppServer(options: CreateAppServerOptions = {}): AppServer {
  const catalogMode = options.catalogMode ?? 'modules';
  const instructions = catalogMode === 'legacy'
    ? [
      'HorizonLayer is durable, workspace-scoped memory for coding agents.',
      'Begin with workspace list or create, then session start with the returned workspace_id.',
      'Use page for unstructured knowledge, database and row for structured knowledge, search to retrieve either, and link for explicit relationships.',
      'Reuse returned IDs and revisions. Mutations require the latest revision; archive and restore replace public hard deletes.',
    ]
    : [
      'HorizonLayer provides durable agent knowledge and Jira-style issue tracking.',
      'Use only the enabled module tools. Knowledge workspaces and Issue Projects are separate scopes connected by explicit links.',
      'Read compact results first and request record content or bounded link traversal only when needed.',
      'Reuse returned IDs and revisions. Assignment is exclusive; never claim an Issue already assigned to another agent.',
      'Mutations require the latest revision; archive and restore replace public hard deletes.',
    ];
  const server = new AppServer({
    instructions: instructions.join(' '),
    name: config.server.name,
    version: config.server.version,
  });

  if (catalogMode === 'legacy') registerCoreTools(server);
  else registerModuleTools(server, options.modules ?? parseSelectedModules());

  return server;
}
