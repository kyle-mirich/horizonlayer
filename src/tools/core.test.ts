import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { toJsonSchema } from 'xsschema';
import type { AppServer } from '../mcp.js';

const ids = {
  block: '00000000-0000-0000-0000-000000000015',
  database: '00000000-0000-0000-0000-000000000011',
  link: '00000000-0000-0000-0000-000000000016',
  page: '00000000-0000-0000-0000-00000000000a',
  property: '00000000-0000-0000-0000-000000000017',
  row: '00000000-0000-0000-0000-000000000012',
  run: '00000000-0000-0000-0000-000000000013',
  session: '00000000-0000-0000-0000-000000000014',
  workspace: '00000000-0000-0000-0000-000000000001',
};

const workspaceMocks = {
  archiveWorkspace: vi.fn(), createWorkspace: vi.fn(), getWorkspace: vi.fn(),
  listWorkspaces: vi.fn(), restoreWorkspace: vi.fn(), updateWorkspace: vi.fn(),
};
const sessionMocks = {
  closeSession: vi.fn(), createSession: vi.fn(), listSessions: vi.fn(), resumeSession: vi.fn(),
};
const pageMocks = {
  appendPageBlocks: vi.fn(), archivePage: vi.fn(), archivePageBlock: vi.fn(), createPage: vi.fn(),
  getPage: vi.fn(), listPages: vi.fn(), restorePage: vi.fn(), restorePageBlock: vi.fn(),
  updatePage: vi.fn(), updatePageBlock: vi.fn(),
};
const databaseMocks = {
  addDatabaseProperty: vi.fn(), archiveDatabase: vi.fn(), archiveDatabaseProperty: vi.fn(),
  createDatabase: vi.fn(), getDatabase: vi.fn(), listDatabases: vi.fn(), restoreDatabase: vi.fn(),
  restoreDatabaseProperty: vi.fn(), updateDatabase: vi.fn(), updateDatabaseProperty: vi.fn(),
};
const rowMocks = {
  archiveRow: vi.fn(), createRow: vi.fn(), getRow: vi.fn(), queryRows: vi.fn(),
  restoreRow: vi.fn(), updateRow: vi.fn(),
};
const linkMocks = {
  archiveLink: vi.fn(), createLink: vi.fn(), listLinks: vi.fn(), restoreLink: vi.fn(),
};
const runMocks = {
  checkpointRun: vi.fn(), finishRun: vi.fn(), getRun: vi.fn(), listRuns: vi.fn(), startRun: vi.fn(),
};
const searchMocks = {
  resolveSearchScope: vi.fn(),
  searchRecords: vi.fn(),
};
const searchRagMock = vi.fn();

vi.mock('../db/queries/workspaces.js', () => workspaceMocks);
vi.mock('../db/queries/sessions.js', () => sessionMocks);
vi.mock('../db/queries/pages.js', () => pageMocks);
vi.mock('../db/queries/databases.js', () => databaseMocks);
vi.mock('../db/queries/rows.js', () => rowMocks);
vi.mock('../db/queries/links.js', () => linkMocks);
vi.mock('../db/queries/runs.js', () => runMocks);
vi.mock('../db/queries/search.js', () => searchMocks);
vi.mock('../search/rag.js', () => ({ searchRag: searchRagMock }));

type ToolResponse = { content: Array<{ text: string }>; isError?: boolean };
type ToolDefinition = {
  name: string;
  parameters: z.ZodTypeAny;
  execute: (params: never) => Promise<ToolResponse>;
};

async function buildTools() {
  const tools = new Map<string, ToolDefinition>();
  const server = {
    addTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
  } as unknown as AppServer;
  const { registerCoreTools } = await import('./core.js');
  registerCoreTools(server);
  return tools;
}

function payload(response: ToolResponse) {
  return JSON.parse(response.content[0].text) as {
    action: string;
    error: { code: string; message: string; retryable: boolean } | null;
    meta: Record<string, unknown>;
    ok: boolean;
    result: unknown;
  };
}

async function call(toolName: string, input: Record<string, unknown>) {
  const definition = (await buildTools()).get(toolName);
  if (!definition) throw new Error(`${toolName} tool was not registered`);
  const parsed = definition.parameters.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join(', '));
  return payload(await definition.execute(parsed.data as never));
}

function resetMocks() {
  for (const group of [workspaceMocks, sessionMocks, pageMocks, databaseMocks, rowMocks, linkMocks, runMocks]) {
    for (const mock of Object.values(group)) mock.mockReset();
  }
  searchMocks.resolveSearchScope.mockReset();
  searchMocks.searchRecords.mockReset();
  searchRagMock.mockReset();
}

describe('agent-first core MCP contract', () => {
  beforeEach(() => {
    resetMocks();
    workspaceMocks.createWorkspace.mockResolvedValue({ id: ids.workspace, revision: 1 });
    workspaceMocks.listWorkspaces.mockResolvedValue([{ id: ids.workspace, revision: 1 }]);
    workspaceMocks.getWorkspace.mockResolvedValue({ id: ids.workspace, revision: 1 });
    workspaceMocks.updateWorkspace.mockResolvedValue({ id: ids.workspace, revision: 2 });
    workspaceMocks.archiveWorkspace.mockResolvedValue({ id: ids.workspace, revision: 2, archived_at: 'now' });
    workspaceMocks.restoreWorkspace.mockResolvedValue({ id: ids.workspace, revision: 3, archived_at: null });
    sessionMocks.createSession.mockResolvedValue({ id: ids.session, workspace_id: ids.workspace });
    sessionMocks.listSessions.mockResolvedValue([{ id: ids.session }]);
    sessionMocks.resumeSession.mockResolvedValue({ session: { id: ids.session }, truncated: false });
    sessionMocks.closeSession.mockResolvedValue({ id: ids.session, status: 'closed' });
    pageMocks.createPage.mockResolvedValue({ id: ids.page, revision: 1, blocks: [] });
    pageMocks.getPage.mockResolvedValue({ id: ids.page, revision: 1, blocks: [] });
    pageMocks.listPages.mockResolvedValue([{ id: ids.page, revision: 1 }]);
    pageMocks.updatePage.mockResolvedValue({ id: ids.page, revision: 2 });
    pageMocks.appendPageBlocks.mockResolvedValue({
      blocks: [{ id: ids.block, revision: 1 }],
      page_revision: 3,
    });
    pageMocks.updatePageBlock.mockResolvedValue({
      block: { id: ids.block, revision: 2 },
      page_revision: 4,
    });
    pageMocks.archivePage.mockResolvedValue({ id: ids.page, revision: 2, archived_at: 'now' });
    pageMocks.restorePage.mockResolvedValue({ id: ids.page, revision: 3, archived_at: null });
    pageMocks.archivePageBlock.mockResolvedValue({
      block: { id: ids.block, revision: 2, archived_at: 'now' },
      page_revision: 5,
    });
    pageMocks.restorePageBlock.mockResolvedValue({
      block: { id: ids.block, revision: 3, archived_at: null },
      page_revision: 6,
    });
    databaseMocks.createDatabase.mockResolvedValue({ id: ids.database, revision: 1, properties: [] });
    databaseMocks.listDatabases.mockResolvedValue([{ id: ids.database, revision: 1 }]);
    databaseMocks.getDatabase.mockResolvedValue({ id: ids.database, revision: 1, properties: [] });
    databaseMocks.updateDatabase.mockResolvedValue({ id: ids.database, revision: 2 });
    databaseMocks.archiveDatabase.mockResolvedValue({ id: ids.database, revision: 2 });
    databaseMocks.restoreDatabase.mockResolvedValue({ id: ids.database, revision: 3 });
    databaseMocks.addDatabaseProperty.mockResolvedValue({
      database_revision: 2,
      property: { id: ids.property, revision: 1 },
    });
    databaseMocks.updateDatabaseProperty.mockResolvedValue({
      database_revision: 3,
      property: { id: ids.property, revision: 2 },
    });
    databaseMocks.archiveDatabaseProperty.mockResolvedValue({
      database_revision: 4,
      property: { id: ids.property, revision: 3 },
    });
    databaseMocks.restoreDatabaseProperty.mockResolvedValue({
      database_revision: 5,
      property: { id: ids.property, revision: 4 },
    });
    rowMocks.createRow.mockResolvedValue({ id: ids.row, revision: 1, values: { Name: 'Decision' } });
    rowMocks.getRow.mockResolvedValue({ id: ids.row, revision: 1, values: { Name: 'Decision' } });
    rowMocks.queryRows.mockResolvedValue({ rows: [{ id: ids.row, revision: 1 }], total: 1 });
    rowMocks.updateRow.mockResolvedValue({ id: ids.row, revision: 2 });
    rowMocks.archiveRow.mockResolvedValue({ id: ids.row, revision: 2 });
    rowMocks.restoreRow.mockResolvedValue({ id: ids.row, revision: 3 });
    linkMocks.createLink.mockResolvedValue({ id: ids.link });
    linkMocks.listLinks.mockResolvedValue([{ id: ids.link }]);
    linkMocks.archiveLink.mockResolvedValue({ id: ids.link, archived_at: 'now' });
    linkMocks.restoreLink.mockResolvedValue({ id: ids.link, archived_at: null });
    searchMocks.resolveSearchScope.mockResolvedValue({
      kind: 'workspace',
      workspace_id: ids.workspace,
      types: ['page', 'row'],
      session_id: null,
      database_id: null,
    });
    searchMocks.searchRecords.mockResolvedValue({
      records: [{ id: ids.page, type: 'page', title: 'Hit', revision: 1 }],
      truncated: false,
    });
    searchRagMock.mockResolvedValue({
      chunks: [{
        rank: 1,
        score: 0.9,
        text: 'Evidence',
        citation: {
          type: 'page', id: ids.page, workspace_id: ids.workspace,
          part: 'block',
          title: 'Hit', revision: 1, updated_at: '2026-01-01T00:00:00.000Z',
          block_id: ids.block, block_revision: 1, block_type: 'text',
          block_position: 0, char_start: 0, char_end: 8,
        },
      }],
      truncated: false,
    });
    runMocks.startRun.mockResolvedValue({ id: ids.run, status: 'running' });
    runMocks.getRun.mockResolvedValue({ id: ids.run, status: 'running' });
    runMocks.listRuns.mockResolvedValue([{ id: ids.run, status: 'running' }]);
    runMocks.checkpointRun.mockResolvedValue({ id: ids.run, latest_checkpoint_sequence: 1 });
    runMocks.finishRun.mockResolvedValue({ id: ids.run, status: 'completed' });
  });

  it('registers eight bounded domain tools and no task orchestration', async () => {
    expect([...(await buildTools()).keys()].sort()).toEqual([
      'database', 'link', 'page', 'row', 'run', 'search', 'session', 'workspace',
    ]);
  });

  it('advertises action-specific required fields and rejects unrelated fields', async () => {
    const pageTool = (await buildTools()).get('page');
    const schema = await toJsonSchema(pageTool!.parameters);
    const append = (schema.anyOf as Array<Record<string, unknown>>).find((branch) =>
      JSON.stringify(branch).includes('"const":"append"')
    ) as { required: string[] };
    expect(append.required).toEqual(expect.arrayContaining(['action', 'page_id', 'revision', 'blocks']));

    await expect(call('page', { action: 'append', page_id: ids.page, blocks: [{ content: 'x' }] }))
      .rejects.toThrow();
    await expect(call('page', { action: 'get', page_id: ids.page, title: 'ignored' }))
      .rejects.toThrow();
    await expect(call('row', {
      action: 'query', database_id: ids.database,
      filters: [{ property: 'Name', operator: 'contains' }],
    })).rejects.toThrow();
  });

  it('encodes dependent search, link, row sort, finish, and checkpoint fields', async () => {
    await expect(call('search', {
      query: 'x', scope: { kind: 'workspace', workspace_id: ids.workspace },
    })).rejects.toThrow();
    await expect(call('search', {
      mode: 'records', query: 'x', workspace_id: ids.workspace,
    })).rejects.toThrow();
    await expect(call('search', {
      mode: 'records', query: 'x',
      scope: { kind: 'session', session_id: ids.session, database_id: ids.database },
    })).rejects.toThrow();
    await expect(call('search', {
      mode: 'records', query: 'x', scope: { kind: 'session', session_id: ids.session },
    })).resolves.toMatchObject({ ok: true });

    await expect(call('link', {
      action: 'list', workspace_id: ids.workspace, item_type: 'page',
    })).rejects.toThrow();
    await expect(call('link', {
      action: 'list', workspace_id: ids.workspace, direction: 'from',
    })).rejects.toThrow();
    await expect(call('link', {
      action: 'list', workspace_id: ids.workspace, item_type: 'page', item_id: ids.page,
    })).resolves.toMatchObject({ ok: true });

    await expect(call('row', {
      action: 'query', database_id: ids.database, sort_direction: 'desc',
    })).rejects.toThrow();
    await expect(call('row', {
      action: 'query', database_id: ids.database, sort_by: 'Name', sort_direction: 'desc',
    })).resolves.toMatchObject({ ok: true });

    await expect(call('run', {
      action: 'checkpoint', run_id: ids.run,
    })).rejects.toThrow();
    await expect(call('run', {
      action: 'checkpoint', run_id: ids.run, state: { cursor: 3 },
    })).resolves.toMatchObject({ ok: true });
    await expect(call('run', {
      action: 'finish', run_id: ids.run, outcome: 'completed', error_message: 'nope',
    })).rejects.toThrow();
    await expect(call('run', {
      action: 'finish', run_id: ids.run, outcome: 'failed', error_message: 'boom',
    })).resolves.toMatchObject({ ok: true });
  });

  it('rejects every empty update while accepting each update family with a mutable field', async () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['workspace', { action: 'update', workspace_id: ids.workspace, revision: 1 }, { name: 'Renamed' }],
      ['page', { action: 'update', page_id: ids.page, revision: 1 }, { importance: 0.8 }],
      ['page', { action: 'block_update', block_id: ids.block, revision: 1 }, { content: '' }],
      ['database', { action: 'update', database_id: ids.database, revision: 1 }, { description: null }],
      ['database', { action: 'property_update', property_id: ids.property, revision: 1 }, { name: 'Renamed' }],
      ['row', { action: 'update', row_id: ids.row, revision: 1 }, { tags: [] }],
    ];

    for (const [toolName, base, mutation] of cases) {
      await expect(call(toolName, base)).rejects.toThrow();
      await expect(call(toolName, { ...base, ...mutation })).resolves.toMatchObject({ ok: true });
    }
  });

  it('caps every public read window at fifty', async () => {
    await expect(call('workspace', { action: 'list', limit: 51 })).rejects.toThrow();
    await expect(call('page', { action: 'get', page_id: ids.page, block_limit: 51 })).rejects.toThrow();
    await expect(call('session', {
      action: 'resume', session_id: ids.session, workspace_id: ids.workspace, max_items: 51,
    })).rejects.toThrow();
    await expect(call('search', {
      mode: 'records', query: 'bounded', limit: 51,
      scope: { kind: 'workspace', workspace_id: ids.workspace },
    })).rejects.toThrow();
    await expect(call('search', {
      mode: 'rag', query: 'bounded', limit: 21,
      scope: { kind: 'workspace', workspace_id: ids.workspace },
    })).rejects.toThrow();
    await expect(call('run', {
      action: 'get', run_id: ids.run, checkpoint_limit: 51,
    })).rejects.toThrow();

    await expect(call('page', {
      action: 'append', page_id: ids.page, revision: 1,
      blocks: Array.from({ length: 100 }, () => ({ content: '' })),
    })).resolves.toMatchObject({ ok: true });
  });

  it('bounds all agent-authored arrays, text, and arbitrary JSON records', async () => {
    await expect(call('page', {
      action: 'create', workspace_id: ids.workspace, title: 'x', tags: Array(51).fill('tag'),
    })).rejects.toThrow();
    await expect(call('page', {
      action: 'create', workspace_id: ids.workspace, title: 'x',
      blocks: [{ content: 'x'.repeat(16_385) }],
    })).rejects.toThrow();
    await expect(call('session', {
      action: 'start', workspace_id: ids.workspace, metadata: { data: 'x'.repeat(8_192) },
    })).rejects.toThrow();
    await expect(call('database', {
      action: 'create', workspace_id: ids.workspace, name: 'x',
      properties: [{ name: 'Status', property_type: 'select', options: { choices: ['x'.repeat(201)] } }],
    })).rejects.toThrow();
    await expect(call('row', {
      action: 'create', database_id: ids.database, values: { Name: 'x'.repeat(32_768) },
    })).rejects.toThrow();
    await expect(call('row', {
      action: 'query', database_id: ids.database,
      filters: [{ property: 'Name', operator: 'eq', value: 'x'.repeat(8_192) }],
    })).rejects.toThrow();
    await expect(call('run', {
      action: 'checkpoint', run_id: ids.run, state: { data: 'x'.repeat(32_768) },
    })).rejects.toThrow();
    await expect(call('run', {
      action: 'finish', run_id: ids.run, outcome: 'completed', result: { data: 'x'.repeat(32_768) },
    })).rejects.toThrow();
  });

  it('supports the canonical workspace, session, page, search, and run flow', async () => {
    await expect(call('workspace', { action: 'list', limit: 10 })).resolves.toMatchObject({ ok: true });
    await expect(call('workspace', { action: 'create', name: 'Project' })).resolves.toMatchObject({ ok: true });
    await expect(call('session', { action: 'start', workspace_id: ids.workspace, title: 'Implement' })).resolves.toMatchObject({ ok: true });
    await expect(call('page', {
      action: 'create', workspace_id: ids.workspace, title: 'Architecture',
      blocks: [{ content: 'Postgres-native search' }],
    })).resolves.toMatchObject({ ok: true });
    await expect(call('search', {
      mode: 'records',
      query: 'native search',
      scope: { kind: 'workspace', workspace_id: ids.workspace },
    })).resolves.toMatchObject({
      ok: true,
      result: { mode: 'records', records: [{ id: ids.page }], truncated: false },
    });
    await expect(call('run', { action: 'start', workspace_id: ids.workspace, agent_name: 'codex' })).resolves.toMatchObject({ ok: true });
    await expect(call('run', { action: 'checkpoint', run_id: ids.run, summary: 'core frozen' })).resolves.toMatchObject({ ok: true });
    await expect(call('run', { action: 'finish', run_id: ids.run, outcome: 'completed' })).resolves.toMatchObject({ ok: true });

    expect(workspaceMocks.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ name: 'Project' }));
    expect(sessionMocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: ids.workspace }));
    expect(pageMocks.createPage).toHaveBeenCalledWith(expect.objectContaining({
      blocks: [{ block_type: 'text', content: 'Postgres-native search' }],
    }));
    expect(searchMocks.resolveSearchScope).toHaveBeenCalledWith({
      kind: 'workspace', workspace_id: ids.workspace,
    });
    expect(searchMocks.searchRecords).toHaveBeenCalledWith(expect.objectContaining({
      query: 'native search',
      scope: expect.objectContaining({ workspace_id: ids.workspace }),
    }));
    expect(runMocks.startRun).not.toHaveBeenCalledWith(expect.objectContaining({ task_id: expect.anything() }));
  });

  it('routes rag mode explicitly and preserves dependency failures', async () => {
    await expect(call('search', {
      mode: 'rag',
      query: 'semantic evidence',
      scope: { kind: 'database', database_id: ids.database },
    })).resolves.toMatchObject({
      ok: true,
      meta: { limit: 8 },
      result: { mode: 'rag', chunks: [{ rank: 1 }], truncated: false },
    });
    expect(searchRagMock).toHaveBeenCalledWith(expect.objectContaining({
      query: 'semantic evidence',
      scope: expect.objectContaining({ workspace_id: ids.workspace }),
    }));
    expect(searchMocks.searchRecords).not.toHaveBeenCalled();

    searchRagMock.mockRejectedValueOnce(Object.assign(new Error('RAG is disabled'), {
      code: 'DEPENDENCY_UNAVAILABLE',
      retryable: true,
    }));
    await expect(call('search', {
      mode: 'rag',
      query: 'semantic evidence',
      scope: { kind: 'workspace', workspace_id: ids.workspace },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'DEPENDENCY_UNAVAILABLE', retryable: true },
    });
  });

  it('uses revisions for knowledge mutations and archive/restore', async () => {
    await call('page', { action: 'update', page_id: ids.page, revision: 1, title: 'Updated' });
    const appended = await call('page', {
      action: 'append', page_id: ids.page, revision: 2, blocks: [{ content: 'detail' }],
    });
    await call('page', { action: 'archive', page_id: ids.page, revision: 3 });
    await call('page', { action: 'restore', page_id: ids.page, revision: 4 });

    expect(pageMocks.updatePage).toHaveBeenCalledWith(ids.page, expect.objectContaining({ revision: 1 }));
    expect(pageMocks.appendPageBlocks).toHaveBeenCalledWith(
      ids.page,
      [{ block_type: 'text', content: 'detail' }],
      expect.objectContaining({ revision: 2 })
    );
    expect(pageMocks.archivePage).toHaveBeenCalledWith(ids.page, 3);
    expect(pageMocks.restorePage).toHaveBeenCalledWith(ids.page, 4);
    expect(appended.result).toMatchObject({ page_revision: 3, blocks: [{ id: ids.block }] });
  });

  it('keeps title defaults in the query layer and separates row/link operations', async () => {
    await call('database', { action: 'create', workspace_id: ids.workspace, name: 'Decisions' });
    await call('row', { action: 'create', database_id: ids.database, values: { Name: 'Use Postgres' } });
    await call('link', {
      action: 'create', workspace_id: ids.workspace,
      from_type: 'page', from_id: ids.page, to_type: 'row', to_id: ids.row,
    });

    expect(databaseMocks.createDatabase).toHaveBeenCalledWith(expect.not.objectContaining({
      properties: expect.anything(),
    }));
    expect(rowMocks.createRow).toHaveBeenCalledWith(expect.objectContaining({ database_id: ids.database }));
    expect(linkMocks.createLink).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: ids.workspace }));
  });

  it('returns honest pagination and stable error codes', async () => {
    workspaceMocks.listWorkspaces.mockResolvedValueOnce(Array.from({ length: 3 }, (_, index) => ({ id: `ws-${index}` })));
    const listed = await call('workspace', { action: 'list', limit: 2, offset: 4 });
    expect(listed.result).toMatchObject({
      items: [{ id: 'ws-0' }, { id: 'ws-1' }],
      page: { has_more: true, limit: 2, next_offset: 6, offset: 4 },
    });
    expect(workspaceMocks.listWorkspaces).toHaveBeenCalledWith(expect.objectContaining({ limit: 3, offset: 4 }));

    pageMocks.getPage.mockResolvedValueOnce(null);
    await expect(call('page', { action: 'get', page_id: ids.page })).resolves.toMatchObject({
      error: { code: 'NOT_FOUND', retryable: false },
      ok: false,
    });
  });
});
