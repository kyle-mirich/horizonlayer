import type { AppServer } from '../mcp.js';
import {
  archiveWorkspace,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  restoreWorkspace,
  updateWorkspace,
} from '../db/queries/workspaces.js';
import {
  closeSession,
  createSession,
  resumeSession,
  listSessions,
} from '../db/queries/sessions.js';
import {
  appendPageBlocks,
  archivePage,
  archivePageBlock,
  createPage,
  getPage,
  listPages,
  restorePage,
  restorePageBlock,
  updatePage,
  updatePageBlock,
} from '../db/queries/pages.js';
import {
  addDatabaseProperty,
  archiveDatabase,
  archiveDatabaseProperty,
  createDatabase,
  getDatabase,
  listDatabases,
  restoreDatabase,
  restoreDatabaseProperty,
  updateDatabase,
  updateDatabaseProperty,
} from '../db/queries/databases.js';
import {
  archiveRow,
  createRow,
  getRow,
  queryRows,
  restoreRow,
  updateRow,
} from '../db/queries/rows.js';
import {
  archiveLink,
  createLink,
  listLinks,
  restoreLink,
} from '../db/queries/links.js';
import { search } from '../db/queries/search.js';
import {
  checkpointRun,
  finishRun,
  getRun,
  listRuns,
  startRun,
} from '../db/queries/runs.js';
import {
  DatabaseSchema,
  CORE_TOOL_OUTPUT_SCHEMAS,
  LinkSchema,
  PageSchema,
  RowSchema,
  RunSchema,
  SearchSchema,
  SessionSchema,
  WorkspaceSchema,
} from './schemas.js';
import { errorEnvelopeFromUnknown, successEnvelope } from './common.js';

const DEFAULT_LIMIT = 50;

function paginated<T>(records: T[], requestedLimit?: number, requestedOffset?: number) {
  const limit = requestedLimit ?? DEFAULT_LIMIT;
  const offset = requestedOffset ?? 0;
  const hasMore = records.length > limit;
  return {
    items: hasMore ? records.slice(0, limit) : records,
    page: {
      has_more: hasMore,
      limit,
      next_offset: hasMore ? offset + limit : null,
      offset,
    },
  };
}

function queryLimit(limit?: number): number {
  return (limit ?? DEFAULT_LIMIT) + 1;
}

export function registerCoreTools(server: AppServer): void {
  server.addTool({
    name: 'workspace',
    description: 'Discover and manage durable workspace scopes. Call list before create to reuse existing knowledge.',
    parameters: WorkspaceSchema,
    outputSchema: CORE_TOOL_OUTPUT_SCHEMAS.workspace,
    execute: async (params) => {
      const action = params.action;
      try {
        switch (action) {
          case 'create':
            return successEnvelope({ action, result: await createWorkspace(params) });
          case 'list': {
            const records = await listWorkspaces({ ...params, limit: queryLimit(params.limit) });
            return successEnvelope({ action, result: paginated(records, params.limit, params.offset) });
          }
          case 'get': {
            const workspace = await getWorkspace(params.workspace_id, {
              include_archived: params.include_archived,
            });
            if (!workspace) throw new Error(`Workspace ${params.workspace_id} not found`);
            return successEnvelope({ action, result: workspace });
          }
          case 'update': {
            const workspace = await updateWorkspace(params.workspace_id, params);
            if (!workspace) throw new Error(`Workspace ${params.workspace_id} not found`);
            return successEnvelope({ action, result: workspace });
          }
          case 'archive': {
            const workspace = await archiveWorkspace(params.workspace_id, params.revision);
            if (!workspace) throw new Error(`Workspace ${params.workspace_id} not found`);
            return successEnvelope({ action, result: workspace });
          }
          case 'restore': {
            const workspace = await restoreWorkspace(params.workspace_id, params.revision);
            if (!workspace) throw new Error(`Workspace ${params.workspace_id} not found`);
            return successEnvelope({ action, result: workspace });
          }
        }
      } catch (error) {
        return errorEnvelopeFromUnknown(action, error);
      }
    },
  });

  server.addTool({
    name: 'session',
    description: 'Start, list, resume, and close agent work sessions inside an existing workspace.',
    parameters: SessionSchema,
    outputSchema: CORE_TOOL_OUTPUT_SCHEMAS.session,
    execute: async (params) => {
      const action = params.action;
      try {
        switch (action) {
          case 'start':
            return successEnvelope({ action, result: await createSession(params) });
          case 'list': {
            const records = await listSessions({ ...params, limit: queryLimit(params.limit) });
            return successEnvelope({ action, result: paginated(records, params.limit, params.offset) });
          }
          case 'resume': {
            const session = await resumeSession(params);
            if (!session) throw new Error(`Session ${params.session_id} not found`);
            return successEnvelope({ action, result: session });
          }
          case 'close': {
            const session = await closeSession(params.session_id);
            if (!session) throw new Error(`Session ${params.session_id} not found`);
            return successEnvelope({ action, result: session });
          }
        }
      } catch (error) {
        return errorEnvelopeFromUnknown(action, error);
      }
    },
  });

  server.addTool({
    name: 'page',
    description: 'Store and edit unstructured knowledge as nested pages and ordered text blocks.',
    parameters: PageSchema,
    outputSchema: CORE_TOOL_OUTPUT_SCHEMAS.page,
    execute: async (params) => {
      const action = params.action;
      try {
        switch (action) {
          case 'create': {
            const page = await createPage({
              ...params,
              blocks: params.blocks?.map((block) => ({
                ...block,
                block_type: block.block_type ?? 'text',
              })),
            });
            return successEnvelope({ action, result: page });
          }
          case 'get': {
            const page = await getPage(params.page_id, {
              session_id: params.session_id,
              include_archived: params.include_archived,
              block_limit: params.block_limit,
              block_offset: params.block_offset,
            });
            if (!page) throw new Error(`Page ${params.page_id} not found`);
            return successEnvelope({ action, result: page });
          }
          case 'list': {
            const records = await listPages({ ...params, limit: queryLimit(params.limit) });
            return successEnvelope({ action, result: paginated(records, params.limit, params.offset) });
          }
          case 'update': {
            const page = await updatePage(params.page_id, params);
            if (!page) throw new Error(`Page ${params.page_id} not found`);
            return successEnvelope({ action, result: page });
          }
          case 'append': {
            const result = await appendPageBlocks(
              params.page_id,
              params.blocks.map((block) => ({
                ...block,
                block_type: block.block_type ?? 'text',
              })),
              { revision: params.revision, session_id: params.session_id }
            );
            return successEnvelope({ action, result });
          }
          case 'block_update': {
            const block = await updatePageBlock(params.block_id, params);
            if (!block) throw new Error(`Block ${params.block_id} not found`);
            return successEnvelope({ action, result: block });
          }
          case 'archive': {
            const page = await archivePage(params.page_id, params.revision);
            if (!page) throw new Error(`Page ${params.page_id} not found`);
            return successEnvelope({ action, result: page });
          }
          case 'restore': {
            const page = await restorePage(params.page_id, params.revision);
            if (!page) throw new Error(`Page ${params.page_id} not found`);
            return successEnvelope({ action, result: page });
          }
          case 'block_archive': {
            const block = await archivePageBlock(params.block_id, params.revision);
            if (!block) throw new Error(`Block ${params.block_id} not found`);
            return successEnvelope({ action, result: block });
          }
          case 'block_restore': {
            const block = await restorePageBlock(params.block_id, params.revision);
            if (!block) throw new Error(`Block ${params.block_id} not found`);
            return successEnvelope({ action, result: block });
          }
        }
      } catch (error) {
        return errorEnvelopeFromUnknown(action, error);
      }
    },
  });

  server.addTool({
    name: 'database',
    description: 'Manage structured database schemas and typed properties. Row data is handled by the row tool.',
    parameters: DatabaseSchema,
    outputSchema: CORE_TOOL_OUTPUT_SCHEMAS.database,
    execute: async (params) => {
      const action = params.action;
      try {
        switch (action) {
          case 'create': {
            const database = await createDatabase({
              ...params,
            });
            return successEnvelope({ action, result: database });
          }
          case 'list': {
            const records = await listDatabases({ ...params, limit: queryLimit(params.limit) });
            return successEnvelope({ action, result: paginated(records, params.limit, params.offset) });
          }
          case 'get': {
            const database = await getDatabase(params.database_id, {
              include_archived: params.include_archived,
            });
            if (!database) throw new Error(`Database ${params.database_id} not found`);
            return successEnvelope({ action, result: database });
          }
          case 'update': {
            const database = await updateDatabase(params.database_id, params);
            if (!database) throw new Error(`Database ${params.database_id} not found`);
            return successEnvelope({ action, result: database });
          }
          case 'archive': {
            const database = await archiveDatabase(params.database_id, params.revision);
            if (!database) throw new Error(`Database ${params.database_id} not found`);
            return successEnvelope({ action, result: database });
          }
          case 'restore': {
            const database = await restoreDatabase(params.database_id, params.revision);
            if (!database) throw new Error(`Database ${params.database_id} not found`);
            return successEnvelope({ action, result: database });
          }
          case 'property_add':
            return successEnvelope({
              action,
              result: await addDatabaseProperty(params.database_id, {
                database_revision: params.revision,
                ...params.property,
              }),
            });
          case 'property_update': {
            const property = await updateDatabaseProperty(params.property_id, params);
            if (!property) throw new Error(`Database property ${params.property_id} not found`);
            return successEnvelope({ action, result: property });
          }
          case 'property_archive': {
            const property = await archiveDatabaseProperty(params.property_id, params.revision);
            if (!property) throw new Error(`Database property ${params.property_id} not found`);
            return successEnvelope({ action, result: property });
          }
          case 'property_restore': {
            const property = await restoreDatabaseProperty(params.property_id, params.revision);
            if (!property) throw new Error(`Database property ${params.property_id} not found`);
            return successEnvelope({ action, result: property });
          }
        }
      } catch (error) {
        return errorEnvelopeFromUnknown(action, error);
      }
    },
  });

  server.addTool({
    name: 'row',
    description: 'Create, query, update, archive, and restore typed rows. Row value keys, filter properties, and sort_by are exact database property names.',
    parameters: RowSchema,
    outputSchema: CORE_TOOL_OUTPUT_SCHEMAS.row,
    execute: async (params) => {
      const action = params.action;
      try {
        switch (action) {
          case 'create':
            return successEnvelope({ action, result: await createRow(params) });
          case 'get': {
            const row = await getRow(params.row_id, {
              include_archived: params.include_archived,
            });
            if (!row) throw new Error(`Row ${params.row_id} not found`);
            return successEnvelope({ action, result: row });
          }
          case 'query': {
            const result = await queryRows({
              ...params,
              limit: queryLimit(params.limit),
              sort_by: 'sort_by' in params ? params.sort_by : undefined,
              sort_direction: 'sort_direction' in params ? params.sort_direction : undefined,
            });
            const page = paginated(result.rows, params.limit, params.offset);
            return successEnvelope({ action, result: { ...page, total: result.total } });
          }
          case 'update': {
            const row = await updateRow(params.row_id, params);
            if (!row) throw new Error(`Row ${params.row_id} not found`);
            return successEnvelope({ action, result: row });
          }
          case 'archive': {
            const row = await archiveRow(params.row_id, params.revision);
            if (!row) throw new Error(`Row ${params.row_id} not found`);
            return successEnvelope({ action, result: row });
          }
          case 'restore': {
            const row = await restoreRow(params.row_id, params.revision);
            if (!row) throw new Error(`Row ${params.row_id} not found`);
            return successEnvelope({ action, result: row });
          }
        }
      } catch (error) {
        return errorEnvelopeFromUnknown(action, error);
      }
    },
  });

  server.addTool({
    name: 'link',
    description: 'Create and inspect explicit same-workspace relationships between pages, databases, rows, blocks, and workspaces.',
    parameters: LinkSchema,
    outputSchema: CORE_TOOL_OUTPUT_SCHEMAS.link,
    execute: async (params) => {
      const action = params.action;
      try {
        switch (action) {
          case 'create':
            return successEnvelope({ action, result: await createLink(params) });
          case 'list': {
            const records = await listLinks({ ...params, limit: queryLimit(params.limit) });
            return successEnvelope({ action, result: paginated(records, params.limit, params.offset) });
          }
          case 'archive': {
            const link = await archiveLink(params.link_id, params.revision);
            if (!link) throw new Error(`Link ${params.link_id} not found`);
            return successEnvelope({ action, result: link });
          }
          case 'restore': {
            const link = await restoreLink(params.link_id, params.revision);
            if (!link) throw new Error(`Link ${params.link_id} not found`);
            return successEnvelope({ action, result: link });
          }
        }
      } catch (error) {
        return errorEnvelopeFromUnknown(action, error);
      }
    },
  });

  server.addTool({
    name: 'search',
    description: 'Search page and row knowledge inside one workspace using PostgreSQL full-text and typo-tolerant ranking.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    parameters: SearchSchema,
    outputSchema: CORE_TOOL_OUTPUT_SCHEMAS.search,
    execute: async (params) => {
      const action = 'search';
      try {
        const records = await search(params);
        return successEnvelope({
          action,
          result: { items: records },
          meta: { limit: params.limit ?? 20 },
        });
      } catch (error) {
        return errorEnvelopeFromUnknown(action, error);
      }
    },
  });

  server.addTool({
    name: 'run',
    description: 'Optional execution journal for one agent attempt: start, inspect, checkpoint resumable state, and finish. Not a task queue.',
    parameters: RunSchema,
    outputSchema: CORE_TOOL_OUTPUT_SCHEMAS.run,
    execute: async (params) => {
      const action = params.action;
      try {
        switch (action) {
          case 'start':
            return successEnvelope({ action, result: await startRun(params) });
          case 'get': {
            const run = await getRun(params.run_id, {
              checkpoint_limit: params.checkpoint_limit,
              checkpoint_offset: params.checkpoint_offset,
            });
            if (!run) throw new Error(`Run ${params.run_id} not found`);
            return successEnvelope({ action, result: run });
          }
          case 'list': {
            const records = await listRuns({ ...params, limit: queryLimit(params.limit) });
            return successEnvelope({ action, result: paginated(records, params.limit, params.offset) });
          }
          case 'checkpoint': {
            const run = await checkpointRun(params);
            if (!run) throw new Error(`Run ${params.run_id} not found`);
            return successEnvelope({ action, result: run });
          }
          case 'finish': {
            const run = await finishRun(params);
            if (!run) throw new Error(`Run ${params.run_id} not found`);
            return successEnvelope({ action, result: run });
          }
        }
      } catch (error) {
        return errorEnvelopeFromUnknown(action, error);
      }
    },
  });
}
