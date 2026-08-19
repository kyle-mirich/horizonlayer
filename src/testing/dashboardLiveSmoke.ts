import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { config } from '../config.js';
import { closePool, getPool } from '../db/client.js';
import { initializeDatabase } from '../db/initialize.js';
import { createDashboardHttpServer } from '../dashboard/http.js';
import { disposeEmbeddingProvider } from '../search/embedder.js';
import { createAppServer } from '../server.js';
import {
  asArray,
  asRecord,
  assert,
  getPaginatedItems,
  getRevision,
  getString,
  type JsonObject,
} from './mcpClient.js';

const DASHBOARD_HOST = '127.0.0.1';
const DASHBOARD_TOOLS = ['database', 'page', 'row', 'search', 'workspace'] as const;

type DashboardTool = typeof DASHBOARD_TOOLS[number];

interface HttpJsonResponse {
  body: JsonObject;
  requestId: string;
  status: number;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function sameStrings(actual: Iterable<string>, expected: Iterable<string>): boolean {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

function hasId(records: JsonObject[], id: string): boolean {
  return records.some((record) => record.id === id);
}

function positiveInteger(value: unknown, label: string): number {
  assert(
    typeof value === 'number' && Number.isInteger(value) && value > 0,
    `${label} must be a positive integer`
  );
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      assert(address != null && typeof address === 'object', 'Dashboard smoke did not bind a TCP socket');
      assert(
        address.address === DASHBOARD_HOST,
        `Dashboard smoke bound ${address.address}, not literal ${DASHBOARD_HOST}`
      );
      resolve(address.port);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: DASHBOARD_HOST, port: 0 });
  });
}

function closeHttpServer(server: Server | null): Promise<void> {
  if (!server?.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

function assertCommonHttpContract(response: Response, label: string): string {
  const contentType = response.headers.get('content-type');
  assert(
    contentType?.startsWith('application/json') === true,
    `${label} did not return JSON content`
  );
  assert(response.headers.get('cache-control') === 'no-store', `${label} was unexpectedly cacheable`);
  assert(
    response.headers.get('x-content-type-options') === 'nosniff',
    `${label} did not include dashboard security headers`
  );
  const requestId = response.headers.get('x-request-id');
  assert(requestId != null && requestId.length > 0, `${label} did not return X-Request-Id`);
  return requestId;
}

async function requestJson(
  baseUrl: string,
  path: string,
  init?: RequestInit
): Promise<HttpJsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      origin: baseUrl,
      'sec-fetch-site': 'same-origin',
      ...init?.headers,
    },
  });
  const requestId = assertCommonHttpContract(response, path);
  const body = asRecord(await response.json(), `${path} did not return a JSON object`);
  return { body, requestId, status: response.status };
}

function assertEnvelopeShape(body: JsonObject, label: string): void {
  assert(
    sameStrings(Object.keys(body), ['action', 'error', 'meta', 'ok', 'result']),
    `${label} did not return the canonical tool envelope`
  );
  assert(typeof body.ok === 'boolean', `${label} envelope missing boolean ok`);
  asRecord(body.meta, `${label} envelope missing meta object`);
}

async function callTool(
  baseUrl: string,
  tool: DashboardTool,
  expectedAction: string,
  input: JsonObject
): Promise<unknown> {
  const response = await requestJson(baseUrl, `/api/tools/${tool}`, {
    body: JSON.stringify(input),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert(response.status === 200, `${tool}/${expectedAction} returned HTTP ${response.status}`);
  assertEnvelopeShape(response.body, `${tool}/${expectedAction}`);
  assert(response.body.ok === true, `${tool}/${expectedAction} returned a failed envelope`);
  assert(
    response.body.action === expectedAction,
    `${tool}/${expectedAction} envelope advertised action ${String(response.body.action)}`
  );
  assert(response.body.error === null, `${tool}/${expectedAction} returned an error on success`);
  assert(response.body.result !== undefined, `${tool}/${expectedAction} omitted result`);
  return response.body.result;
}

async function assertNotFoundEnvelope(baseUrl: string): Promise<void> {
  const response = await requestJson(baseUrl, '/api/tools/workspace', {
    body: JSON.stringify({ action: 'get', workspace_id: randomUUID() }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert(response.status === 404, `workspace/get missing record returned HTTP ${response.status}`);
  assertEnvelopeShape(response.body, 'workspace/get missing record');
  assert(response.body.ok === false, 'workspace/get missing record returned a successful envelope');
  assert(response.body.action === 'get', 'workspace/get missing record returned the wrong action');
  assert(response.body.result === null, 'workspace/get missing record returned a result');
  const error = asRecord(response.body.error, 'workspace/get missing record omitted error details');
  assert(error.code === 'NOT_FOUND', 'workspace/get missing record did not return NOT_FOUND');
  assert(error.retryable === false, 'workspace/get NOT_FOUND was unexpectedly retryable');
}

async function assertStatus(baseUrl: string): Promise<void> {
  const response = await requestJson(baseUrl, '/api/status');
  assert(response.status === 200, `/api/status returned HTTP ${response.status}`);
  assert(response.body.database === 'connected', '/api/status did not verify PostgreSQL connectivity');
  assert(response.body.version === config.server.version, '/api/status returned the wrong version');

  const mcp = asRecord(response.body.mcp, '/api/status omitted MCP status');
  assert(mcp.available === true, '/api/status reported MCP unavailable');
  assert(mcp.command === 'horizonlayer', '/api/status returned the wrong MCP command');

  const rag = asRecord(response.body.rag, '/api/status omitted RAG status');
  assert(rag.enabled === config.rag.enabled, '/api/status returned the wrong RAG state');
  const tools = asArray(response.body.tools, '/api/status omitted dashboard tools');
  assert(
    sameStrings(tools.map(String), DASHBOARD_TOOLS),
    `/api/status returned unexpected tools: ${tools.map(String).join(', ')}`
  );
}

async function deleteSmokeWorkspace(workspaceId: string | null): Promise<void> {
  if (!workspaceId) return;
  const result = await getPool().query<{ id: string }>(
    'DELETE FROM workspaces WHERE id = $1 RETURNING id',
    [workspaceId]
  );
  assert(
    result.rows[0]?.id === workspaceId,
    `Dashboard smoke cleanup did not delete workspace ${workspaceId}`
  );
}

async function main(): Promise<void> {
  assert(
    process.env.DATABASE_URL,
    'DATABASE_URL is required for the dashboard bridge smoke test'
  );

  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const searchToken = `silverpine${suffix}`;
  let failure: Error | null = null;
  let httpServer: Server | null = null;
  let workspaceId: string | null = null;
  let pageId = '';
  let databaseId = '';
  let rowId = '';

  try {
    await initializeDatabase();
    const appServer = createAppServer({ catalogMode: 'legacy' });
    httpServer = createDashboardHttpServer({
      appServer,
      databaseHealth: async () => {
        const result = await getPool().query<{ healthy: number }>('SELECT 1 AS healthy');
        return result.rows[0]?.healthy === 1;
      },
      ragEnabled: config.rag.enabled,
      version: config.server.version,
    });
    const port = await listen(httpServer);
    const baseUrl = `http://${DASHBOARD_HOST}:${port}`;

    await assertStatus(baseUrl);
    await assertNotFoundEnvelope(baseUrl);

    let workspace = asRecord(await callTool(baseUrl, 'workspace', 'create', {
      action: 'create',
      description: 'Ephemeral dashboard HTTP bridge smoke workspace',
      name: `Dashboard bridge ${suffix}`,
    }), 'workspace/create result was not an object');
    workspaceId = getString(workspace, 'id');
    let workspaceRevision = getRevision(workspace, 'workspace/create');

    const workspaces = getPaginatedItems(await callTool(baseUrl, 'workspace', 'list', {
      action: 'list',
      limit: 50,
    }), 'workspace/list');
    assert(hasId(workspaces, workspaceId), 'workspace/list did not return the created workspace');
    workspace = asRecord(await callTool(baseUrl, 'workspace', 'get', {
      action: 'get',
      workspace_id: workspaceId,
    }), 'workspace/get result was not an object');
    workspaceRevision = getRevision(workspace, 'workspace/get');
    workspace = asRecord(await callTool(baseUrl, 'workspace', 'update', {
      action: 'update',
      description: 'Verified through the production dashboard HTTP bridge',
      revision: workspaceRevision,
      workspace_id: workspaceId,
    }), 'workspace/update result was not an object');
    workspaceRevision = getRevision(workspace, 'workspace/update');

    let page = asRecord(await callTool(baseUrl, 'page', 'create', {
      action: 'create',
      blocks: [{ block_type: 'heading', content: `Durable knowledge ${searchToken}` }],
      importance: 0.9,
      tags: ['dashboard-smoke', suffix],
      title: `Bridge page ${searchToken}`,
      workspace_id: workspaceId,
    }), 'page/create result was not an object');
    pageId = getString(page, 'id');
    let pageRevision = getRevision(page, 'page/create');
    const initialBlock = asRecord(
      asArray(page.blocks, 'page/create omitted blocks')[0],
      'page/create returned an invalid block'
    );
    const initialBlockId = getString(initialBlock, 'id');
    let initialBlockRevision = getRevision(initialBlock, 'page/create block');

    page = asRecord(await callTool(baseUrl, 'page', 'get', {
      action: 'get',
      page_id: pageId,
    }), 'page/get result was not an object');
    pageRevision = getRevision(page, 'page/get');
    const pages = getPaginatedItems(await callTool(baseUrl, 'page', 'list', {
      action: 'list',
      limit: 50,
      workspace_id: workspaceId,
    }), 'page/list');
    assert(hasId(pages, pageId), 'page/list did not return the created page');

    page = asRecord(await callTool(baseUrl, 'page', 'update', {
      action: 'update',
      page_id: pageId,
      revision: pageRevision,
      tags: ['dashboard-smoke', 'http-verified', suffix],
    }), 'page/update result was not an object');
    pageRevision = getRevision(page, 'page/update');

    const appendMutation = asRecord(await callTool(baseUrl, 'page', 'append', {
      action: 'append',
      blocks: [{ block_type: 'callout', content: `Appended over HTTP ${searchToken}` }],
      page_id: pageId,
      revision: pageRevision,
    }), 'page/append result was not an object');
    pageRevision = positiveInteger(appendMutation.page_revision, 'page/append page_revision');
    let appendedBlock = asRecord(
      asArray(appendMutation.blocks, 'page/append omitted blocks')[0],
      'page/append returned an invalid block'
    );
    const appendedBlockId = getString(appendedBlock, 'id');
    let appendedBlockRevision = getRevision(appendedBlock, 'page/append block');

    const updateBlockMutation = asRecord(await callTool(baseUrl, 'page', 'block_update', {
      action: 'block_update',
      block_id: initialBlockId,
      content: `Updated PostgreSQL knowledge ${searchToken}`,
      revision: initialBlockRevision,
    }), 'page/block_update result was not an object');
    initialBlockRevision = getRevision(
      asRecord(updateBlockMutation.block, 'page/block_update omitted block'),
      'page/block_update block'
    );
    pageRevision = positiveInteger(
      updateBlockMutation.page_revision,
      'page/block_update page_revision'
    );

    const archiveBlockMutation = asRecord(await callTool(baseUrl, 'page', 'block_archive', {
      action: 'block_archive',
      block_id: appendedBlockId,
      revision: appendedBlockRevision,
    }), 'page/block_archive result was not an object');
    appendedBlock = asRecord(archiveBlockMutation.block, 'page/block_archive omitted block');
    appendedBlockRevision = getRevision(appendedBlock, 'page/block_archive block');
    pageRevision = positiveInteger(
      archiveBlockMutation.page_revision,
      'page/block_archive page_revision'
    );

    const restoreBlockMutation = asRecord(await callTool(baseUrl, 'page', 'block_restore', {
      action: 'block_restore',
      block_id: appendedBlockId,
      revision: appendedBlockRevision,
    }), 'page/block_restore result was not an object');
    appendedBlock = asRecord(restoreBlockMutation.block, 'page/block_restore omitted block');
    getRevision(appendedBlock, 'page/block_restore block');
    pageRevision = positiveInteger(
      restoreBlockMutation.page_revision,
      'page/block_restore page_revision'
    );

    page = asRecord(await callTool(baseUrl, 'page', 'get', {
      action: 'get',
      page_id: pageId,
    }), 'page/get after block mutations result was not an object');
    const visibleBlocks = asArray(page.blocks, 'page/get after block mutations omitted blocks')
      .map((block) => asRecord(block, 'page/get returned an invalid block'));
    assert(hasId(visibleBlocks, initialBlockId), 'page/get did not return the updated block');
    assert(hasId(visibleBlocks, appendedBlockId), 'page/get did not return the restored block');
    assert(
      visibleBlocks.find((block) => block.id === initialBlockId)?.revision === initialBlockRevision,
      'page/get returned a stale updated block revision'
    );

    page = asRecord(await callTool(baseUrl, 'page', 'archive', {
      action: 'archive',
      page_id: pageId,
      revision: pageRevision,
    }), 'page/archive result was not an object');
    pageRevision = getRevision(page, 'page/archive');
    page = asRecord(await callTool(baseUrl, 'page', 'restore', {
      action: 'restore',
      page_id: pageId,
      revision: pageRevision,
    }), 'page/restore result was not an object');
    getRevision(page, 'page/restore');

    let database = asRecord(await callTool(baseUrl, 'database', 'create', {
      action: 'create',
      description: 'Structured dashboard bridge smoke data',
      name: `Bridge database ${suffix}`,
      parent_page_id: pageId,
      properties: [
        { name: 'Name', property_type: 'title' },
        {
          name: 'Status',
          options: { choices: ['accepted', 'verified'] },
          property_type: 'select',
        },
      ],
      tags: ['dashboard-smoke', suffix],
      workspace_id: workspaceId,
    }), 'database/create result was not an object');
    databaseId = getString(database, 'id');
    let databaseRevision = getRevision(database, 'database/create');

    const databases = getPaginatedItems(await callTool(baseUrl, 'database', 'list', {
      action: 'list',
      limit: 50,
      workspace_id: workspaceId,
    }), 'database/list');
    assert(hasId(databases, databaseId), 'database/list did not return the created database');
    database = asRecord(await callTool(baseUrl, 'database', 'get', {
      action: 'get',
      database_id: databaseId,
    }), 'database/get result was not an object');
    databaseRevision = getRevision(database, 'database/get');
    database = asRecord(await callTool(baseUrl, 'database', 'update', {
      action: 'update',
      database_id: databaseId,
      description: 'Updated through the dashboard HTTP bridge',
      revision: databaseRevision,
    }), 'database/update result was not an object');
    databaseRevision = getRevision(database, 'database/update');

    const addPropertyMutation = asRecord(await callTool(baseUrl, 'database', 'property_add', {
      action: 'property_add',
      database_id: databaseId,
      property: { name: 'Owner', property_type: 'text' },
      revision: databaseRevision,
    }), 'database/property_add result was not an object');
    let ownerProperty = asRecord(
      addPropertyMutation.property,
      'database/property_add omitted property'
    );
    const ownerPropertyId = getString(ownerProperty, 'id');
    let ownerPropertyRevision = getRevision(ownerProperty, 'database/property_add property');
    databaseRevision = positiveInteger(
      addPropertyMutation.database_revision,
      'database/property_add database_revision'
    );

    const updatePropertyMutation = asRecord(await callTool(baseUrl, 'database', 'property_update', {
      action: 'property_update',
      name: 'Owner Agent',
      property_id: ownerPropertyId,
      revision: ownerPropertyRevision,
    }), 'database/property_update result was not an object');
    ownerProperty = asRecord(
      updatePropertyMutation.property,
      'database/property_update omitted property'
    );
    ownerPropertyRevision = getRevision(ownerProperty, 'database/property_update property');
    databaseRevision = positiveInteger(
      updatePropertyMutation.database_revision,
      'database/property_update database_revision'
    );

    const archivePropertyMutation = asRecord(await callTool(baseUrl, 'database', 'property_archive', {
      action: 'property_archive',
      property_id: ownerPropertyId,
      revision: ownerPropertyRevision,
    }), 'database/property_archive result was not an object');
    ownerProperty = asRecord(
      archivePropertyMutation.property,
      'database/property_archive omitted property'
    );
    ownerPropertyRevision = getRevision(ownerProperty, 'database/property_archive property');
    databaseRevision = positiveInteger(
      archivePropertyMutation.database_revision,
      'database/property_archive database_revision'
    );

    const restorePropertyMutation = asRecord(await callTool(baseUrl, 'database', 'property_restore', {
      action: 'property_restore',
      property_id: ownerPropertyId,
      revision: ownerPropertyRevision,
    }), 'database/property_restore result was not an object');
    ownerProperty = asRecord(
      restorePropertyMutation.property,
      'database/property_restore omitted property'
    );
    getRevision(ownerProperty, 'database/property_restore property');
    databaseRevision = positiveInteger(
      restorePropertyMutation.database_revision,
      'database/property_restore database_revision'
    );

    database = asRecord(await callTool(baseUrl, 'database', 'get', {
      action: 'get',
      database_id: databaseId,
    }), 'database/get after property restore result was not an object');
    const properties = asArray(database.properties, 'database/get omitted properties')
      .map((property) => asRecord(property, 'database/get returned an invalid property'));
    assert(
      properties.some((property) => property.id === ownerPropertyId && property.name === 'Owner Agent'),
      'database/get did not return the restored, renamed property'
    );

    database = asRecord(await callTool(baseUrl, 'database', 'archive', {
      action: 'archive',
      database_id: databaseId,
      revision: databaseRevision,
    }), 'database/archive result was not an object');
    databaseRevision = getRevision(database, 'database/archive');
    database = asRecord(await callTool(baseUrl, 'database', 'restore', {
      action: 'restore',
      database_id: databaseId,
      revision: databaseRevision,
    }), 'database/restore result was not an object');
    getRevision(database, 'database/restore');

    let row = asRecord(await callTool(baseUrl, 'row', 'create', {
      action: 'create',
      database_id: databaseId,
      importance: 0.95,
      tags: ['dashboard-smoke', suffix],
      values: {
        Name: `Bridge record ${searchToken}`,
        'Owner Agent': 'codex-dashboard-smoke',
        Status: 'accepted',
      },
    }), 'row/create result was not an object');
    rowId = getString(row, 'id');
    let rowRevision = getRevision(row, 'row/create');
    row = asRecord(await callTool(baseUrl, 'row', 'get', {
      action: 'get',
      row_id: rowId,
    }), 'row/get result was not an object');
    rowRevision = getRevision(row, 'row/get');

    const rows = getPaginatedItems(await callTool(baseUrl, 'row', 'query', {
      action: 'query',
      database_id: databaseId,
      filters: [{ operator: 'contains', property: 'Name', value: searchToken }],
      limit: 50,
    }), 'row/query');
    assert(hasId(rows, rowId), 'row/query did not return the created row');

    row = asRecord(await callTool(baseUrl, 'row', 'update', {
      action: 'update',
      revision: rowRevision,
      row_id: rowId,
      values: { Status: 'verified' },
    }), 'row/update result was not an object');
    rowRevision = getRevision(row, 'row/update');
    row = asRecord(await callTool(baseUrl, 'row', 'archive', {
      action: 'archive',
      revision: rowRevision,
      row_id: rowId,
    }), 'row/archive result was not an object');
    rowRevision = getRevision(row, 'row/archive');
    row = asRecord(await callTool(baseUrl, 'row', 'restore', {
      action: 'restore',
      revision: rowRevision,
      row_id: rowId,
    }), 'row/restore result was not an object');
    getRevision(row, 'row/restore');

    const search = asRecord(await callTool(baseUrl, 'search', 'search', {
      format: 'full',
      limit: 20,
      mode: 'records',
      query: searchToken,
      scope: {
        kind: 'workspace',
        types: ['page', 'row'],
        workspace_id: workspaceId,
      },
    }), 'search result was not an object');
    assert(search.mode === 'records', 'records search returned the wrong mode');
    const records = asArray(search.records, 'records search omitted records')
      .map((record) => asRecord(record, 'records search returned an invalid record'));
    assert(
      records.some((record) => record.id === pageId && record.type === 'page'),
      'records search did not return the page'
    );
    assert(
      records.some((record) => record.id === rowId && record.type === 'row'),
      'records search did not return the row'
    );

    workspace = asRecord(await callTool(baseUrl, 'workspace', 'archive', {
      action: 'archive',
      revision: workspaceRevision,
      workspace_id: workspaceId,
    }), 'workspace/archive result was not an object');
    workspaceRevision = getRevision(workspace, 'workspace/archive');
    workspace = asRecord(await callTool(baseUrl, 'workspace', 'restore', {
      action: 'restore',
      revision: workspaceRevision,
      workspace_id: workspaceId,
    }), 'workspace/restore result was not an object');
    getRevision(workspace, 'workspace/restore');
  } catch (error) {
    failure = asError(error);
  } finally {
    const cleanup = async (label: string, work: () => Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        if (!failure) failure = new Error(`${label}: ${errorMessage(error)}`);
        else console.error(`Dashboard smoke cleanup failed (${label}): ${errorMessage(error)}`);
      }
    };

    await cleanup('close HTTP server', () => closeHttpServer(httpServer));
    await cleanup('delete isolated workspace', () => deleteSmokeWorkspace(workspaceId));
    await cleanup('dispose embedding provider', () => disposeEmbeddingProvider());
    await cleanup('close PostgreSQL pool', () => closePool());
  }

  if (failure) throw failure;

  console.log(JSON.stringify({
    database: 'postgresql',
    ok: true,
    records_search: ['page', 'row'],
    transport: 'dashboard-http',
    verified: ['workspace', 'page', 'block', 'database', 'property', 'row'],
  }, null, 2));
}

main().catch((error) => {
  console.error(`Dashboard bridge smoke failed: ${errorMessage(error)}`);
  process.exit(1);
});
