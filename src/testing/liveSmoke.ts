import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import pg from 'pg';
import {
  TOOL_NAMES,
  asArray,
  asRecord,
  assert,
  callTool,
  callToolEnvelope,
  closeClient,
  createStdioClient,
  getPaginatedItems,
  getRevision,
  getString,
  type JsonObject,
  type ToolName,
} from './mcpClient.js';

const { Client: PostgresClient } = pg;

const ACTION_REQUIREMENTS: Record<Exclude<ToolName, 'search'>, Record<string, string[]>> = {
  workspace: {
    create: ['action', 'name'],
    list: ['action'],
    get: ['action', 'workspace_id'],
    update: ['action', 'workspace_id', 'revision'],
    archive: ['action', 'workspace_id', 'revision'],
    restore: ['action', 'workspace_id', 'revision'],
  },
  session: {
    start: ['action', 'workspace_id'],
    list: ['action', 'workspace_id'],
    resume: ['action', 'session_id'],
    close: ['action', 'session_id'],
  },
  page: {
    create: ['action', 'workspace_id', 'title'],
    get: ['action', 'page_id'],
    list: ['action', 'workspace_id'],
    update: ['action', 'page_id', 'revision'],
    append: ['action', 'page_id', 'revision', 'blocks'],
    block_update: ['action', 'block_id', 'revision'],
    archive: ['action', 'page_id', 'revision'],
    restore: ['action', 'page_id', 'revision'],
    block_archive: ['action', 'block_id', 'revision'],
    block_restore: ['action', 'block_id', 'revision'],
  },
  database: {
    create: ['action', 'workspace_id', 'name'],
    list: ['action', 'workspace_id'],
    get: ['action', 'database_id'],
    update: ['action', 'database_id', 'revision'],
    archive: ['action', 'database_id', 'revision'],
    restore: ['action', 'database_id', 'revision'],
    property_add: ['action', 'database_id', 'revision', 'property'],
    property_update: ['action', 'property_id', 'revision'],
    property_archive: ['action', 'property_id', 'revision'],
    property_restore: ['action', 'property_id', 'revision'],
  },
  row: {
    create: ['action', 'database_id', 'values'],
    get: ['action', 'row_id'],
    query: ['action', 'database_id'],
    update: ['action', 'row_id', 'revision'],
    archive: ['action', 'row_id', 'revision'],
    restore: ['action', 'row_id', 'revision'],
  },
  link: {
    create: ['action', 'workspace_id', 'from_type', 'from_id', 'to_type', 'to_id'],
    list: ['action', 'workspace_id'],
    archive: ['action', 'link_id', 'revision'],
    restore: ['action', 'link_id', 'revision'],
  },
  run: {
    start: ['action', 'workspace_id', 'agent_name'],
    get: ['action', 'run_id'],
    list: ['action', 'workspace_id'],
    checkpoint: ['action', 'run_id'],
    finish: ['action', 'run_id', 'outcome'],
  },
};

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function actionBranches(schema: unknown): Map<string, JsonObject> {
  const branches = new Map<string, JsonObject>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value == null || typeof value !== 'object') return;
    const node = value as JsonObject;
    if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
      const properties = node.properties as JsonObject;
      const action = properties.action;
      if (action && typeof action === 'object' && !Array.isArray(action)) {
        const actionName = (action as JsonObject).const;
        if (typeof actionName === 'string') branches.set(actionName, node);
      }
    }
    for (const child of Object.values(node)) visit(child);
  };

  visit(schema);
  return branches;
}

function verifyAdvertisedContract(listToolsResult: unknown): string[] {
  const result = asRecord(listToolsResult, 'tools/list result was not an object');
  const tools = asArray(result.tools, 'tools/list result missing tools').map((value) =>
    asRecord(value, 'tools/list returned an invalid tool')
  );
  const names = sorted(tools.map((tool) => getString(tool, 'name')));
  assert(
    JSON.stringify(names) === JSON.stringify(sorted(TOOL_NAMES)),
    `Expected exactly ${sorted(TOOL_NAMES).join(', ')}; got ${names.join(', ')}`
  );

  for (const toolName of TOOL_NAMES) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    assert(tool, `${toolName} was not advertised`);
    assert(
      typeof tool.description === 'string' && tool.description.trim().length > 0,
      `${toolName} must advertise a non-empty description`
    );
    const inputSchema = asRecord(tool.inputSchema, `${toolName} missing inputSchema`);
    assert(inputSchema.type === 'object', `${toolName} inputSchema must advertise an object root`);
    const outputSchema = asRecord(tool.outputSchema, `${toolName} missing outputSchema`);
    assert(outputSchema.type === 'object', `${toolName} outputSchema must advertise an object root`);
    assert(
      outputSchema.additionalProperties === false,
      `${toolName} outputSchema must reject unknown envelope fields`
    );

    if (toolName === 'search') {
      const modeBranches = asArray(inputSchema.anyOf, 'search schema missing mode branches').map(
        (value) => asRecord(value, 'search schema contained an invalid mode branch')
      );
      assert(modeBranches.length === 2, 'search schema must advertise records and rag modes');

      const modes = new Map<string, JsonObject>();
      for (const branch of modeBranches) {
        const required = asArray(branch.required, 'search mode branch missing required fields');
        assert(required.includes('mode'), 'every search mode branch must require mode');
        assert(required.includes('query'), 'every search mode branch must require query');
        assert(required.includes('scope'), 'every search mode branch must require scope');
        assert(branch.additionalProperties === false, 'search mode branches must reject unknown fields');
        const properties = asRecord(branch.properties, 'search mode branch missing properties');
        const mode = getString(asRecord(properties.mode, 'search mode property was invalid'), 'const');
        modes.set(mode, branch);
      }
      assert(
        JSON.stringify(sorted(modes.keys())) === JSON.stringify(['rag', 'records']),
        'search schema must require exactly records or rag mode'
      );

      const recordsProperties = asRecord(
        modes.get('records')?.properties,
        'records mode missing properties'
      );
      const scopeSchema = asRecord(recordsProperties.scope, 'records mode missing scope schema');
      const scopeBranches = asArray(scopeSchema.anyOf, 'search schema missing scope branches').map(
        (value) => asRecord(value, 'search schema contained an invalid scope branch')
      );
      assert(scopeBranches.length === 3, 'search schema must advertise workspace, session, and database scopes');

      let workspaceBranches = 0;
      let sessionBranches = 0;
      let databaseBranches = 0;
      for (const branch of scopeBranches) {
        const required = asArray(branch.required, 'search scope branch missing required fields');
        assert(required.includes('kind'), 'every search scope branch must require kind');
        assert(branch.additionalProperties === false, 'search scope branches must reject unknown fields');

        const properties = asRecord(branch.properties, 'search scope branch missing properties');
        const kind = getString(asRecord(properties.kind, 'search scope kind was invalid'), 'const');
        if (kind === 'workspace') {
          workspaceBranches += 1;
          assert(required.includes('workspace_id'), 'workspace search scope must require workspace_id');
        } else if (kind === 'session') {
          sessionBranches += 1;
          assert(required.includes('session_id'), 'session search scope must require session_id');
        } else if (kind === 'database') {
          databaseBranches += 1;
          assert(required.includes('database_id'), 'database search scope must require database_id');
        } else {
          throw new Error(`search schema advertised unsupported scope kind ${kind}`);
        }
      }
      assert(workspaceBranches === 1, 'search schema must advertise exactly one workspace scope');
      assert(sessionBranches === 1, 'search schema must advertise exactly one session scope');
      assert(databaseBranches === 1, 'search schema must advertise exactly one database scope');
      const outputContract = JSON.stringify(outputSchema);
      assert(outputContract.includes('"records"'), 'search output must advertise canonical records');
      assert(outputContract.includes('"chunks"'), 'search output must advertise RAG chunks');
      assert(outputContract.includes('"citation"'), 'RAG chunks must advertise citations');
      assert(outputContract.includes('"revision"'), 'search output must advertise canonical revisions');
      assert(
        outputContract.includes('DEPENDENCY_UNAVAILABLE'),
        'search output must advertise optional dependency failures'
      );
      assert(actionBranches(inputSchema).size === 0, 'search must not advertise action branches');
      continue;
    }

    const branches = actionBranches(inputSchema);
    const expected = ACTION_REQUIREMENTS[toolName];
    assert(
      JSON.stringify(sorted(branches.keys())) === JSON.stringify(sorted(Object.keys(expected))),
      `${toolName} advertised unexpected actions: ${sorted(branches.keys()).join(', ')}`
    );
    for (const [action, requiredFields] of Object.entries(expected)) {
      const branch = branches.get(action);
      assert(branch, `${toolName}/${action} schema was not advertised`);
      const required = asArray(branch.required, `${toolName}/${action} schema missing required fields`);
      for (const field of requiredFields) {
        assert(required.includes(field), `${toolName}/${action} schema must require ${field}`);
      }
      assert(branch.additionalProperties === false, `${toolName}/${action} schema must reject unknown fields`);
    }
  }

  return names;
}

function resultRecord(result: unknown, label: string): JsonObject {
  return asRecord(result, `${label} result was not an object`);
}

function hasId(records: JsonObject[], id: string): boolean {
  return records.some((record) => record.id === id);
}

function getPageRevision(result: JsonObject, label: string): number {
  const revision = result.page_revision;
  assert(
    typeof revision === 'number' && Number.isInteger(revision) && revision > 0,
    `${label} did not return a positive page_revision`
  );
  return revision;
}

function getDatabaseRevision(result: JsonObject, label: string): number {
  const revision = result.database_revision;
  assert(
    typeof revision === 'number' && Number.isInteger(revision) && revision > 0,
    `${label} did not return a positive database_revision`
  );
  return revision;
}

function assertBoundedPage(value: unknown, label: string): void {
  const page = resultRecord(value, label);
  assert(typeof page.has_more === 'boolean', `${label} missing has_more`);
  assert(
    typeof page.limit === 'number' && Number.isInteger(page.limit) && page.limit > 0,
    `${label} missing a positive limit`
  );
  assert(
    typeof page.offset === 'number' && Number.isInteger(page.offset) && page.offset >= 0,
    `${label} missing a non-negative offset`
  );
  assert(
    page.next_offset === null ||
      (typeof page.next_offset === 'number' && Number.isInteger(page.next_offset)),
    `${label} returned an invalid next_offset`
  );
}

async function safeCleanup(
  client: Client,
  state: {
    sessionClosed: boolean;
    sessionId: string | null;
    workspaceArchived: boolean;
    workspaceId: string | null;
    workspaceRevision: number | null;
  }
): Promise<void> {
  if (state.sessionId && !state.sessionClosed) {
    try {
      await callTool(client, 'session', { action: 'close', session_id: state.sessionId });
      state.sessionClosed = true;
    } catch (error) {
      console.error(`Smoke cleanup could not close session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (state.workspaceId && state.workspaceRevision && !state.workspaceArchived) {
    try {
      await callTool(client, 'workspace', {
        action: 'archive',
        revision: state.workspaceRevision,
        workspace_id: state.workspaceId,
      });
      state.workspaceArchived = true;
    } catch (error) {
      console.error(`Smoke cleanup could not archive workspace: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function deleteSmokeWorkspace(databaseUrl: string, workspaceId: string | null): Promise<void> {
  if (!workspaceId) return;
  const client = new PostgresClient({
    application_name: 'horizonlayer-live-smoke-cleanup',
    connectionString: databaseUrl,
  });
  await client.connect();
  try {
    await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert(
    databaseUrl,
    'DATABASE_URL is required so the live smoke can delete its isolated test workspace'
  );
  const suffix = randomUUID().slice(0, 8);
  const { args, client, command, transport } = createStdioClient(
    'horizonlayer-live-smoke',
    ['legacy-mcp']
  );
  const cleanupState = {
    sessionClosed: false,
    sessionId: null as string | null,
    workspaceArchived: false,
    workspaceId: null as string | null,
    workspaceRevision: null as number | null,
  };
  const revisions: JsonObject = {};

  try {
    await client.connect(transport);
    const toolNames = verifyAdvertisedContract(await client.listTools());

    const missingWorkspace = await callToolEnvelope(client, 'workspace', {
      action: 'get',
      workspace_id: randomUUID(),
    });
    assert(!missingWorkspace.ok, 'workspace/get unexpectedly found a random workspace');
    assert(missingWorkspace.error?.code === 'NOT_FOUND', 'workspace/get must return stable NOT_FOUND');
    assert(missingWorkspace.error.retryable === false, 'NOT_FOUND must not be retryable');

    const workspace = resultRecord((await callTool(client, 'workspace', {
      action: 'create',
      description: 'Ephemeral live smoke workspace; archived during cleanup',
      name: `Smoke Workspace ${suffix}`,
    })).result, 'workspace/create');
    const workspaceId = getString(workspace, 'id');
    cleanupState.workspaceId = workspaceId;
    cleanupState.workspaceRevision = getRevision(workspace, 'workspace/create');

    const workspaces = getPaginatedItems((await callTool(client, 'workspace', {
      action: 'list',
      limit: 50,
    })).result, 'workspace/list');
    assert(hasId(workspaces, workspaceId), 'workspace/list did not return the created workspace');
    const loadedWorkspace = resultRecord((await callTool(client, 'workspace', {
      action: 'get',
      workspace_id: workspaceId,
    })).result, 'workspace/get');
    cleanupState.workspaceRevision = getRevision(loadedWorkspace, 'workspace/get');

    const previousWorkspaceRevision = cleanupState.workspaceRevision;
    const updatedWorkspace = resultRecord((await callTool(client, 'workspace', {
      action: 'update',
      description: 'Ephemeral live smoke workspace with verified revision handling',
      revision: previousWorkspaceRevision,
      workspace_id: workspaceId,
    })).result, 'workspace/update');
    cleanupState.workspaceRevision = getRevision(updatedWorkspace, 'workspace/update');
    const staleWorkspaceUpdate = await callToolEnvelope(client, 'workspace', {
      action: 'update',
      description: 'This stale write must not commit',
      revision: previousWorkspaceRevision,
      workspace_id: workspaceId,
    });
    assert(!staleWorkspaceUpdate.ok, 'workspace/update accepted a stale revision');
    assert(staleWorkspaceUpdate.error?.code === 'CONFLICT', 'stale update must return CONFLICT');
    assert(staleWorkspaceUpdate.error.retryable === true, 'stale update conflict must be retryable');

    const session = resultRecord((await callTool(client, 'session', {
      action: 'start',
      summary: 'Live PostgreSQL and stdio MCP verification',
      title: `Agent smoke ${suffix}`,
      workspace_id: workspaceId,
    })).result, 'session/start');
    const sessionId = getString(session, 'id');
    cleanupState.sessionId = sessionId;
    const sessions = getPaginatedItems((await callTool(client, 'session', {
      action: 'list',
      limit: 50,
      status: ['active'],
      workspace_id: workspaceId,
    })).result, 'session/list');
    assert(hasId(sessions, sessionId), 'session/list did not return the active session');

    let page = resultRecord((await callTool(client, 'page', {
      action: 'create',
      blocks: [{
        block_type: 'heading',
        content: `Postgres-backed agent knowledge ${suffix}`,
      }],
      session_id: sessionId,
      tags: ['smoke', suffix],
      title: `Architecture ${suffix}`,
      workspace_id: workspaceId,
    })).result, 'page/create');
    const pageId = getString(page, 'id');
    let pageRevision = getRevision(page, 'page/create');
    const initialBlock = resultRecord(asArray(page.blocks, 'page/create missing blocks')[0], 'page/create block');
    const initialBlockId = getString(initialBlock, 'id');
    let initialBlockRevision = getRevision(initialBlock, 'page/create block');

    page = resultRecord((await callTool(client, 'page', {
      action: 'get',
      page_id: pageId,
      session_id: sessionId,
    })).result, 'page/get');
    pageRevision = getRevision(page, 'page/get');
    assertBoundedPage(page.blocks_page, 'page/get blocks_page');
    const pages = getPaginatedItems((await callTool(client, 'page', {
      action: 'list',
      limit: 50,
      session_id: sessionId,
      workspace_id: workspaceId,
    })).result, 'page/list');
    assert(hasId(pages, pageId), 'page/list did not return the created page');

    page = resultRecord((await callTool(client, 'page', {
      action: 'update',
      importance: 0.9,
      page_id: pageId,
      revision: pageRevision,
      tags: ['smoke', 'architecture', suffix],
      title: `Agent architecture ${suffix}`,
    })).result, 'page/update');
    pageRevision = getRevision(page, 'page/update');

    const appendMutation = resultRecord((await callTool(client, 'page', {
      action: 'append',
      blocks: [{ block_type: 'callout', content: `Durable search token ${suffix}` }],
      page_id: pageId,
      revision: pageRevision,
      session_id: sessionId,
    })).result, 'page/append result was not an object');
    const appendedBlock = resultRecord(
      asArray(appendMutation.blocks, 'page/append result missing blocks')[0],
      'page/append block'
    );
    const appendedBlockId = getString(appendedBlock, 'id');
    let appendedBlockRevision = getRevision(appendedBlock, 'page/append block');
    pageRevision = getPageRevision(appendMutation, 'page/append');

    const updateBlockMutation = resultRecord((await callTool(client, 'page', {
      action: 'block_update',
      block_id: initialBlockId,
      content: `HorizonLayer stores Postgres-native searchable agent knowledge ${suffix}`,
      revision: initialBlockRevision,
    })).result, 'page/block_update result was not an object');
    const updatedBlock = resultRecord(
      updateBlockMutation.block,
      'page/block_update result missing block'
    );
    initialBlockRevision = getRevision(updatedBlock, 'page/block_update');
    pageRevision = getPageRevision(updateBlockMutation, 'page/block_update');

    const archiveBlockMutation = resultRecord((await callTool(client, 'page', {
      action: 'block_archive',
      block_id: appendedBlockId,
      revision: appendedBlockRevision,
    })).result, 'page/block_archive result was not an object');
    const archivedBlock = resultRecord(
      archiveBlockMutation.block,
      'page/block_archive result missing block'
    );
    appendedBlockRevision = getRevision(archivedBlock, 'page/block_archive');
    pageRevision = getPageRevision(archiveBlockMutation, 'page/block_archive');

    const restoreBlockMutation = resultRecord((await callTool(client, 'page', {
      action: 'block_restore',
      block_id: appendedBlockId,
      revision: appendedBlockRevision,
    })).result, 'page/block_restore result was not an object');
    const restoredBlock = resultRecord(
      restoreBlockMutation.block,
      'page/block_restore result missing block'
    );
    appendedBlockRevision = getRevision(restoredBlock, 'page/block_restore');
    pageRevision = getPageRevision(restoreBlockMutation, 'page/block_restore');
    page = resultRecord((await callTool(client, 'page', {
      action: 'archive',
      page_id: pageId,
      revision: pageRevision,
    })).result, 'page/archive');
    pageRevision = getRevision(page, 'page/archive');
    page = resultRecord((await callTool(client, 'page', {
      action: 'restore',
      page_id: pageId,
      revision: pageRevision,
    })).result, 'page/restore');
    pageRevision = getRevision(page, 'page/restore');

    let database = resultRecord((await callTool(client, 'database', {
      action: 'create',
      description: 'Structured decisions created by the live smoke test',
      name: `Decisions ${suffix}`,
      parent_page_id: pageId,
      properties: [
        { name: 'Name', property_type: 'title' },
        {
          name: 'Status',
          property_type: 'select',
          options: { choices: ['accepted', 'verified'] },
        },
      ],
      tags: ['smoke', suffix],
      workspace_id: workspaceId,
    })).result, 'database/create');
    const databaseId = getString(database, 'id');
    let databaseRevision = getRevision(database, 'database/create');
    const databases = getPaginatedItems((await callTool(client, 'database', {
      action: 'list',
      limit: 50,
      workspace_id: workspaceId,
    })).result, 'database/list');
    assert(hasId(databases, databaseId), 'database/list did not return the created database');
    database = resultRecord((await callTool(client, 'database', {
      action: 'get',
      database_id: databaseId,
    })).result, 'database/get');
    databaseRevision = getRevision(database, 'database/get');
    database = resultRecord((await callTool(client, 'database', {
      action: 'update',
      database_id: databaseId,
      description: 'Verified structured agent decisions',
      revision: databaseRevision,
    })).result, 'database/update');
    databaseRevision = getRevision(database, 'database/update');

    const addPropertyMutation = resultRecord((await callTool(client, 'database', {
      action: 'property_add',
      database_id: databaseId,
      property: { name: 'Owner', property_type: 'text' },
      revision: databaseRevision,
    })).result, 'database/property_add');
    let ownerProperty = resultRecord(
      addPropertyMutation.property,
      'database/property_add result missing property'
    );
    databaseRevision = getDatabaseRevision(addPropertyMutation, 'database/property_add');
    const ownerPropertyId = getString(ownerProperty, 'id');
    let ownerPropertyRevision = getRevision(ownerProperty, 'database/property_add');
    database = resultRecord((await callTool(client, 'database', {
      action: 'get',
      database_id: databaseId,
    })).result, 'database/get after property_add');
    assert(
      getRevision(database, 'database/get after property_add') === databaseRevision,
      'database/property_add returned a stale database_revision'
    );

    const updatePropertyMutation = resultRecord((await callTool(client, 'database', {
      action: 'property_update',
      name: 'Owner Agent',
      property_id: ownerPropertyId,
      revision: ownerPropertyRevision,
    })).result, 'database/property_update');
    ownerProperty = resultRecord(
      updatePropertyMutation.property,
      'database/property_update result missing property'
    );
    databaseRevision = getDatabaseRevision(updatePropertyMutation, 'database/property_update');
    ownerPropertyRevision = getRevision(ownerProperty, 'database/property_update');
    const archivePropertyMutation = resultRecord((await callTool(client, 'database', {
      action: 'property_archive',
      property_id: ownerPropertyId,
      revision: ownerPropertyRevision,
    })).result, 'database/property_archive');
    ownerProperty = resultRecord(
      archivePropertyMutation.property,
      'database/property_archive result missing property'
    );
    databaseRevision = getDatabaseRevision(archivePropertyMutation, 'database/property_archive');
    ownerPropertyRevision = getRevision(ownerProperty, 'database/property_archive');
    const restorePropertyMutation = resultRecord((await callTool(client, 'database', {
      action: 'property_restore',
      property_id: ownerPropertyId,
      revision: ownerPropertyRevision,
    })).result, 'database/property_restore');
    ownerProperty = resultRecord(
      restorePropertyMutation.property,
      'database/property_restore result missing property'
    );
    databaseRevision = getDatabaseRevision(restorePropertyMutation, 'database/property_restore');
    ownerPropertyRevision = getRevision(ownerProperty, 'database/property_restore');

    database = resultRecord((await callTool(client, 'database', {
      action: 'archive',
      database_id: databaseId,
      revision: databaseRevision,
    })).result, 'database/archive');
    databaseRevision = getRevision(database, 'database/archive');
    database = resultRecord((await callTool(client, 'database', {
      action: 'restore',
      database_id: databaseId,
      revision: databaseRevision,
    })).result, 'database/restore');
    databaseRevision = getRevision(database, 'database/restore');

    let row = resultRecord((await callTool(client, 'row', {
      action: 'create',
      database_id: databaseId,
      importance: 0.95,
      tags: ['smoke', suffix],
      values: {
        Name: `Use PostgreSQL ${suffix}`,
        'Owner Agent': 'codex-smoke',
        Status: 'accepted',
      },
    })).result, 'row/create');
    const rowId = getString(row, 'id');
    let rowRevision = getRevision(row, 'row/create');
    row = resultRecord((await callTool(client, 'row', {
      action: 'get',
      row_id: rowId,
    })).result, 'row/get');
    rowRevision = getRevision(row, 'row/get');
    const rows = getPaginatedItems((await callTool(client, 'row', {
      action: 'query',
      database_id: databaseId,
      filters: [{ operator: 'contains', property: 'Name', value: suffix }],
      limit: 50,
    })).result, 'row/query');
    assert(hasId(rows, rowId), 'row/query did not return the created row');
    row = resultRecord((await callTool(client, 'row', {
      action: 'update',
      revision: rowRevision,
      row_id: rowId,
      values: { Status: 'verified' },
    })).result, 'row/update');
    rowRevision = getRevision(row, 'row/update');
    row = resultRecord((await callTool(client, 'row', {
      action: 'archive',
      revision: rowRevision,
      row_id: rowId,
    })).result, 'row/archive');
    rowRevision = getRevision(row, 'row/archive');
    row = resultRecord((await callTool(client, 'row', {
      action: 'restore',
      revision: rowRevision,
      row_id: rowId,
    })).result, 'row/restore');
    rowRevision = getRevision(row, 'row/restore');

    let link = resultRecord((await callTool(client, 'link', {
      action: 'create',
      from_id: pageId,
      from_type: 'page',
      link_type: 'supports',
      to_id: rowId,
      to_type: 'row',
      workspace_id: workspaceId,
    })).result, 'link/create');
    const linkId = getString(link, 'id');
    let linkRevision = getRevision(link, 'link/create');
    const links = getPaginatedItems((await callTool(client, 'link', {
      action: 'list',
      direction: 'both',
      include_archived: false,
      item_id: pageId,
      item_type: 'page',
      workspace_id: workspaceId,
    })).result, 'link/list');
    assert(hasId(links, linkId), 'link/list did not return the same-workspace link');
    link = resultRecord((await callTool(client, 'link', {
      action: 'archive',
      link_id: linkId,
      revision: linkRevision,
    })).result, 'link/archive');
    linkRevision = getRevision(link, 'link/archive');
    link = resultRecord((await callTool(client, 'link', {
      action: 'restore',
      link_id: linkId,
      revision: linkRevision,
    })).result, 'link/restore');
    linkRevision = getRevision(link, 'link/restore');

    const searchResult = resultRecord((await callTool(client, 'search', {
      limit: 20,
      mode: 'records',
      query: `Postgres agent knowledge ${suffix}`,
      scope: {
        kind: 'workspace',
        types: ['page', 'row'],
        workspace_id: workspaceId,
      },
    })).result, 'search');
    assert(searchResult.mode === 'records', 'record search returned the wrong mode');
    const searchItems = asArray(searchResult.records, 'search result missing records');
    assert(searchItems.length > 0, 'Postgres-native search returned no page or row matches');

    let run = resultRecord((await callTool(client, 'run', {
      action: 'start',
      agent_name: 'codex-smoke',
      metadata: { smoke_suffix: suffix },
      session_id: sessionId,
      title: `Verification run ${suffix}`,
      workspace_id: workspaceId,
    })).result, 'run/start');
    const runId = getString(run, 'id');
    run = resultRecord((await callTool(client, 'run', {
      action: 'get',
      run_id: runId,
    })).result, 'run/get');
    assert(run.status === 'running', 'run/get did not return a running run');
    assert(asArray(run.checkpoints, 'run/get missing checkpoints').length === 0, 'new run had checkpoints');
    assertBoundedPage(run.checkpoints_page, 'run/get checkpoints_page');
    const runs = getPaginatedItems((await callTool(client, 'run', {
      action: 'list',
      agent_name: 'codex-smoke',
      session_id: sessionId,
      status: ['running'],
      workspace_id: workspaceId,
    })).result, 'run/list');
    assert(hasId(runs, runId), 'run/list did not return the active run');
    const checkpointMutation = resultRecord((await callTool(client, 'run', {
      action: 'checkpoint',
      run_id: runId,
      state: { database_id: databaseId, page_id: pageId, row_id: rowId },
      summary: 'Eight-tool contract verified through search',
    })).result, 'run/checkpoint result was not an object');
    const checkpoint = resultRecord(
      checkpointMutation.checkpoint,
      'run/checkpoint result missing checkpoint'
    );
    run = resultRecord(checkpointMutation.run, 'run/checkpoint result missing run');
    assert(checkpoint.sequence === 1, 'run/checkpoint did not return sequence 1');
    assert(run.latest_checkpoint_sequence === 1, 'run/checkpoint did not advance its sequence');

    const finishMutation = resultRecord((await callTool(client, 'run', {
      action: 'finish',
      outcome: 'completed',
      result: { verified: true },
      run_id: runId,
    })).result, 'run/finish result was not an object');
    const latestCheckpoint = resultRecord(
      finishMutation.latest_checkpoint,
      'run/finish result missing latest_checkpoint'
    );
    run = resultRecord(finishMutation.run, 'run/finish result missing run');
    assert(latestCheckpoint.id === checkpoint.id, 'run/finish returned the wrong latest checkpoint');
    assert(run.status === 'completed', 'run/finish did not complete the run');

    const resume = resultRecord((await callTool(client, 'session', {
      action: 'resume',
      max_items: 20,
      session_id: sessionId,
      workspace_id: workspaceId,
    })).result, 'session/resume');
    assert(asArray(resume.recent_pages, 'session/resume missing recent_pages').length > 0, 'resume returned no pages');
    assert(asArray(resume.recent_runs, 'session/resume missing recent_runs').length > 0, 'resume returned no runs');

    await callTool(client, 'session', { action: 'close', session_id: sessionId });
    cleanupState.sessionClosed = true;
    assert(cleanupState.workspaceRevision !== null, 'workspace revision was lost before cleanup');
    const archivedWorkspace = resultRecord((await callTool(client, 'workspace', {
      action: 'archive',
      revision: cleanupState.workspaceRevision,
      workspace_id: workspaceId,
    })).result, 'workspace/archive cleanup');
    cleanupState.workspaceRevision = getRevision(archivedWorkspace, 'workspace/archive cleanup');
    cleanupState.workspaceArchived = true;

    const archivedWorkspaceWrite = await callToolEnvelope(client, 'page', {
      action: 'create',
      title: 'This write must not commit',
      workspace_id: workspaceId,
    });
    assert(!archivedWorkspaceWrite.ok, 'page/create wrote into an archived workspace');
    assert(
      archivedWorkspaceWrite.error?.code === 'NOT_FOUND',
      'archived workspace writes must return NOT_FOUND'
    );

    revisions.workspace = cleanupState.workspaceRevision;
    revisions.page = pageRevision;
    revisions.initial_block = initialBlockRevision;
    revisions.appended_block = appendedBlockRevision;
    revisions.database = databaseRevision;
    revisions.owner_property = ownerPropertyRevision;
    revisions.row = rowRevision;
    revisions.link = linkRevision;

    console.log(JSON.stringify({
      suffix,
      tools: toolNames,
      transport: { args, command },
      revisions,
      verified: {
        action_specific_schemas: true,
        database_and_properties: true,
        envelope_error_codes: true,
        stale_revision_conflict: true,
        links_archive_restore: true,
        pages_and_blocks: true,
        postgres_native_search: true,
        rows_archive_restore: true,
        runs: true,
        sessions: true,
        workspace_archived: true,
        workspace_archive_blocks_writes: true,
      },
    }, null, 2));
  } finally {
    await safeCleanup(client, cleanupState);
    await closeClient(client);
    await deleteSmokeWorkspace(databaseUrl, cleanupState.workspaceId);
  }
}

main().catch((error) => {
  console.error(`Live smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
