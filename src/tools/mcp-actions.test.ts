import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServer } from '../mcp.js';

const ids = {
  block: '00000000-0000-0000-0000-00000000000b',
  database: '00000000-0000-0000-0000-00000000000d',
  inbox: '00000000-0000-0000-0000-00000000001b',
  link: '00000000-0000-0000-0000-000000000011',
  page: '00000000-0000-0000-0000-00000000000a',
  row: '00000000-0000-0000-0000-000000000012',
  run: '00000000-0000-0000-0000-000000000013',
  session: '00000000-0000-0000-0000-000000000014',
  task: '00000000-0000-0000-0000-000000000015',
  workspace: '00000000-0000-0000-0000-000000000001',
};

const workspaceMocks = {
  createWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
};

const sessionMocks = {
  closeSession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  getSessionResumeBundle: vi.fn(),
  listSessions: vi.fn(),
};

const pageMocks = {
  appendPageBlocks: vi.fn(),
  createPage: vi.fn(),
  deletePage: vi.fn(),
  deletePageBlock: vi.fn(),
  getPage: vi.fn(),
  listPages: vi.fn(),
  updatePage: vi.fn(),
  updatePageBlock: vi.fn(),
};

const databaseMocks = {
  addDatabaseProperty: vi.fn(),
  createDatabase: vi.fn(),
  deleteDatabase: vi.fn(),
  getDatabase: vi.fn(),
  listDatabases: vi.fn(),
  updateDatabase: vi.fn(),
};

const rowMocks = {
  bulkCreateRows: vi.fn(),
  cleanupExpired: vi.fn(),
  countRows: vi.fn(),
  createRow: vi.fn(),
  deleteRow: vi.fn(),
  getRow: vi.fn(),
  getRowDatabaseId: vi.fn(),
  queryRows: vi.fn(),
  updateRow: vi.fn(),
};

const taskMocks = {
  acknowledgeInboxItem: vi.fn(),
  acknowledgeTask: vi.fn(),
  appendTaskEvent: vi.fn(),
  claimTask: vi.fn(),
  completeTask: vi.fn(),
  createTask: vi.fn(),
  failTask: vi.fn(),
  getTask: vi.fn(),
  handoffTask: vi.fn(),
  heartbeatTask: vi.fn(),
  listInbox: vi.fn(),
  listTasks: vi.fn(),
};

const runMocks = {
  cancelRun: vi.fn(),
  checkpointRun: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  getRun: vi.fn(),
  listRuns: vi.fn(),
  startRun: vi.fn(),
};

const linkMocks = {
  createLink: vi.fn(),
  deleteLink: vi.fn(),
  listLinks: vi.fn(),
};

const searchMock = vi.fn();

vi.mock('../db/queries/workspaces.js', () => workspaceMocks);
vi.mock('../db/queries/sessions.js', () => sessionMocks);
vi.mock('../db/queries/pages.js', () => pageMocks);
vi.mock('../db/queries/databases.js', () => databaseMocks);
vi.mock('../db/queries/rows.js', () => rowMocks);
vi.mock('../db/queries/tasks.js', () => taskMocks);
vi.mock('../db/queries/runs.js', () => runMocks);
vi.mock('../db/queries/links.js', () => linkMocks);
vi.mock('../db/queries/search.js', () => ({ search: searchMock }));

type ToolExecute = (params: Record<string, unknown>, context: { session?: unknown }) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

async function buildTools() {
  const tools = new Map<string, ToolExecute>();
  const server = {
    addTool(definition: { name: string; execute: ToolExecute }) {
      tools.set(definition.name, definition.execute);
    },
  } as unknown as AppServer;

  const [
    { registerWorkspaceTools },
    { registerPageTools },
    { registerDatabaseTools },
    { registerRowTools },
    { registerTaskTools },
    { registerRunTools },
    { registerLinkTools },
    { registerSearchTools },
  ] = await Promise.all([
    import('./workspaces.js'),
    import('./pages.js'),
    import('./databases.js'),
    import('./rows.js'),
    import('./tasks.js'),
    import('./runs.js'),
    import('./links.js'),
    import('./search.js'),
  ]);

  registerWorkspaceTools(server);
  registerPageTools(server);
  registerDatabaseTools(server);
  registerRowTools(server);
  registerTaskTools(server);
  registerRunTools(server);
  registerLinkTools(server);
  registerSearchTools(server);
  return tools;
}

function payload(response: { content: Array<{ text: string }> }) {
  return JSON.parse(response.content[0].text) as {
    action: string;
    error: { message: string } | null;
    meta: Record<string, unknown>;
    ok: boolean;
    result: unknown;
  };
}

async function call(toolName: string, params: Record<string, unknown>) {
  const tools = await buildTools();
  const tool = tools.get(toolName);
  if (!tool) throw new Error(`${toolName} tool was not registered`);
  return payload(await tool(params, { session: undefined }));
}

function resetMocks() {
  for (const group of [
    workspaceMocks,
    sessionMocks,
    pageMocks,
    databaseMocks,
    rowMocks,
    taskMocks,
    runMocks,
    linkMocks,
  ]) {
    for (const mock of Object.values(group)) {
      mock.mockReset();
    }
  }
  searchMock.mockReset();
}

describe('MCP tool action coverage', () => {
  beforeEach(() => {
    resetMocks();

    workspaceMocks.createWorkspace.mockResolvedValue({ id: ids.workspace, name: 'Workspace' });
    workspaceMocks.listWorkspaces.mockResolvedValue([
      { id: ids.workspace, name: 'One' },
      { id: '00000000-0000-0000-0000-000000000002', name: 'Two' },
    ]);
    workspaceMocks.getWorkspace.mockResolvedValue({ id: ids.workspace, name: 'Workspace' });
    workspaceMocks.updateWorkspace.mockResolvedValue({ id: ids.workspace, name: 'Updated' });
    workspaceMocks.deleteWorkspace.mockResolvedValue(true);

    sessionMocks.createSession.mockResolvedValue({ id: ids.session, workspace_id: ids.workspace });
    sessionMocks.listSessions.mockResolvedValue([{ id: ids.session }]);
    sessionMocks.getSession.mockResolvedValue({ id: ids.session });
    sessionMocks.getSessionResumeBundle.mockResolvedValue({ bundle: { session: { id: ids.session } } });
    sessionMocks.closeSession.mockResolvedValue({ id: ids.session, status: 'closed' });

    pageMocks.createPage.mockResolvedValue({ id: ids.page, title: 'Page' });
    pageMocks.getPage.mockResolvedValue({ id: ids.page, title: 'Page' });
    pageMocks.listPages.mockResolvedValue([{ id: ids.page, title: 'Page' }]);
    pageMocks.updatePage.mockResolvedValue({ id: ids.page, title: 'Updated' });
    pageMocks.appendPageBlocks.mockResolvedValue([{ id: ids.block, content: 'entry' }]);
    pageMocks.updatePageBlock.mockResolvedValue({ id: ids.block, content: 'updated' });
    pageMocks.deletePageBlock.mockResolvedValue(true);
    pageMocks.deletePage.mockResolvedValue(true);

    databaseMocks.createDatabase.mockResolvedValue({ id: ids.database, name: 'Database', properties: [] });
    databaseMocks.getDatabase.mockResolvedValue({
      id: ids.database,
      name: 'Database',
      properties: [{ id: 'prop-1', name: 'Title', property_type: 'title' }],
    });
    databaseMocks.listDatabases.mockResolvedValue([
      { id: ids.database, name: 'Database', properties: [] },
      { id: '00000000-0000-0000-0000-000000000022', name: 'Next', properties: [] },
    ]);
    databaseMocks.updateDatabase.mockResolvedValue({ id: ids.database, name: 'Updated', properties: [] });
    databaseMocks.deleteDatabase.mockResolvedValue(true);
    databaseMocks.addDatabaseProperty.mockResolvedValue({ id: 'prop-2', name: 'Status' });

    rowMocks.createRow.mockResolvedValue({ id: ids.row, values: { Title: 'A' } });
    rowMocks.getRow.mockResolvedValue({ id: ids.row, values: { Title: 'A' } });
    rowMocks.getRowDatabaseId.mockResolvedValue(ids.database);
    rowMocks.updateRow.mockResolvedValue({ id: ids.row, values: { Title: 'B' } });
    rowMocks.deleteRow.mockResolvedValue(true);
    rowMocks.queryRows.mockResolvedValue({ rows: [{ id: ids.row }], total: 2 });
    rowMocks.countRows.mockResolvedValue(2);
    rowMocks.bulkCreateRows.mockResolvedValue([{ id: ids.row }]);
    rowMocks.cleanupExpired.mockResolvedValue({ rows_deleted: 1 });

    taskMocks.createTask.mockResolvedValue({ id: ids.task, title: 'Task' });
    taskMocks.getTask.mockResolvedValue({ id: ids.task, title: 'Task' });
    taskMocks.listTasks.mockResolvedValue([{ id: ids.task }]);
    taskMocks.claimTask.mockResolvedValue({ id: ids.task, status: 'claimed' });
    taskMocks.heartbeatTask.mockResolvedValue({ id: ids.task, status: 'claimed' });
    taskMocks.completeTask.mockResolvedValue({ id: ids.task, status: 'done' });
    taskMocks.failTask.mockResolvedValue({ id: ids.task, status: 'failed' });
    taskMocks.handoffTask.mockResolvedValue({ id: ids.task, status: 'handoff_pending' });
    taskMocks.acknowledgeTask.mockResolvedValue({ id: ids.task, status: 'ready' });
    taskMocks.appendTaskEvent.mockResolvedValue({ id: 'event-1' });
    taskMocks.listInbox.mockResolvedValue([{ id: ids.inbox }]);
    taskMocks.acknowledgeInboxItem.mockResolvedValue({ id: ids.inbox, read_at: '2026-01-01T00:00:00.000Z' });

    runMocks.startRun.mockResolvedValue({ id: ids.run, status: 'running' });
    runMocks.getRun.mockResolvedValue({ id: ids.run, status: 'running' });
    runMocks.listRuns.mockResolvedValue([{ id: ids.run }]);
    runMocks.checkpointRun.mockResolvedValue({ id: ids.run, checkpoints: [{ id: 'checkpoint-1' }] });
    runMocks.completeRun.mockResolvedValue({ id: ids.run, status: 'completed' });
    runMocks.failRun.mockResolvedValue({ id: ids.run, status: 'failed' });
    runMocks.cancelRun.mockResolvedValue({ id: ids.run, status: 'cancelled' });

    linkMocks.createLink.mockResolvedValue({ id: ids.link, from_id: ids.page, to_id: ids.row });
    linkMocks.listLinks.mockResolvedValue([{ id: ids.link }]);
    linkMocks.deleteLink.mockResolvedValue(true);

    searchMock.mockResolvedValue([
      { id: ids.page, type: 'page', title: 'Hit' },
      { id: ids.row, type: 'row', title: 'Row' },
    ]);
  });

  it('executes every workspace action and not-found path', async () => {
    await expect(call('workspace', { action: 'create', name: 'Workspace', expires_in_days: 1 })).resolves.toMatchObject({ ok: true });
    await expect(call('workspace', { action: 'create_session', name: 'Workspace', title: 'Session' })).resolves.toMatchObject({ ok: true });
    await expect(call('workspace', { action: 'list', limit: 1, offset: 1 })).resolves.toMatchObject({ meta: { total: 2 } });
    await expect(call('workspace', { action: 'get', id: ids.workspace })).resolves.toMatchObject({ ok: true });
    await expect(call('workspace', { action: 'update', id: ids.workspace, name: 'Updated' })).resolves.toMatchObject({ ok: true });
    await expect(call('workspace', { action: 'delete', id: ids.workspace })).resolves.toMatchObject({ result: { success: true } });
    await expect(call('workspace', { action: 'start_session', workspace_id: ids.workspace })).resolves.toMatchObject({ ok: true });
    await expect(call('workspace', { action: 'list_sessions', workspace_id: ids.workspace, limit: 5 })).resolves.toMatchObject({ meta: { limit: 5 } });
    await expect(call('workspace', { action: 'get_session', session_id: ids.session })).resolves.toMatchObject({ ok: true });
    await expect(call('workspace', { action: 'resume_session_context', session_id: ids.session, max_items: 3 })).resolves.toMatchObject({ ok: true });
    await expect(call('workspace', { action: 'close_session', session_id: ids.session })).resolves.toMatchObject({ ok: true });

    workspaceMocks.getWorkspace.mockResolvedValueOnce(null);
    await expect(call('workspace', { action: 'get', id: ids.workspace })).resolves.toMatchObject({
      error: { message: `Workspace ${ids.workspace} not found` },
      ok: false,
    });
  });

  it('executes every page action including block mutations', async () => {
    await call('page', { action: 'create', workspace_id: ids.workspace, title: 'Page', blocks: [{ block_type: 'paragraph', content: 'Body' }] });
    await call('page', { action: 'get', id: ids.page, session_id: ids.session });
    await call('page', { action: 'update', id: ids.page, title: 'Updated' });
    await call('page', { action: 'append_blocks', page_id: ids.page, blocks: [{ block_type: 'text', content: 'More' }] });
    await call('page', { action: 'append_text', page_id: ids.page, content: 'Entry' });
    await call('page', { action: 'append_text', workspace_id: ids.workspace, content: 'Journal' });
    await call('page', { action: 'list', workspace_id: ids.workspace, limit: 5, offset: 1 });
    await call('page', { action: 'block_update', block_id: ids.block, content: 'Updated' });
    await call('page', { action: 'block_delete', block_id: ids.block });
    await expect(call('page', { action: 'delete', id: ids.page })).resolves.toMatchObject({ result: { success: true } });

    expect(pageMocks.createPage).toHaveBeenCalledWith(expect.objectContaining({
      blocks: [{ block_type: 'text', content: 'Body' }],
    }));
  });

  it('executes database actions, aliases, previews, pagination, and projection', async () => {
    await call('database', {
      action: 'create',
      workspace_id: ids.workspace,
      name: 'Database',
      properties: [{ name: 'Title', type: 'title' }],
    });
    await call('database', { action: 'get', id: ids.database, fields: ['id'] });
    await expect(call('database', { action: 'list', cursor: Buffer.from(JSON.stringify({ offset: 1 })).toString('base64'), limit: 1 })).resolves.toMatchObject({
      meta: { total: 2 },
    });
    await call('database', { action: 'add_property', database_id: ids.database, name: 'Status', type: 'text' });
    await call('database', { action: 'update', id: ids.database, name: 'Updated', dry_run: true });
    await call('database', { action: 'delete', id: ids.database, validate_only: true });
    await call('database', { op: 'list' });

    expect(databaseMocks.updateDatabase).not.toHaveBeenCalled();
    expect(databaseMocks.deleteDatabase).not.toHaveBeenCalled();
  });

  it('executes row actions, property loading, aliases, previews, and normalized filters', async () => {
    await call('row', { action: 'create', database_id: ids.database, values: { Title: 'A' } });
    await call('row', { action: 'get', id: ids.row });
    await call('row', { action: 'update', id: ids.row, database_id: ids.database, values: { Title: 'B' } });
    await call('row', { action: 'delete', id: ids.row });
    await expect(call('row', {
      action: 'query',
      database_id: ids.database,
      filters: [{ property: 'Title', operator: 'equals', value: 'A' }],
      limit: 1,
      cursor: Buffer.from(JSON.stringify({ offset: 1 })).toString('base64'),
    })).resolves.toMatchObject({ meta: { total: 2 } });
    await call('row', { action: 'count', database_id: ids.database, filters: [{ property: 'Title', operator: 'not_equals', value: 'B' }] });
    await call('row', { action: 'bulk_create', database_id: ids.database, rows: [{ values: { Title: 'C' } }] });
    await call('row', { action: 'cleanup_expired', dry_run: true });
    await call('row', { op: 'cleanup_expired' });

    expect(rowMocks.queryRows).toHaveBeenCalledWith(expect.objectContaining({
      filters: [{ property: 'Title', operator: 'eq', value: 'A' }],
      offset: 1,
    }));
  });

  it('executes all task coordination actions and error paths', async () => {
    await call('task', { action: 'create', workspace_id: ids.workspace, title: 'Task', depends_on_task_ids: [ids.task] });
    await call('task', { action: 'get', id: ids.task });
    await call('task', { action: 'list', workspace_id: ids.workspace, status: ['ready'], limit: 5 });
    await call('task', { action: 'claim', workspace_id: ids.workspace, agent_name: 'agent' });
    await call('task', { action: 'heartbeat', id: ids.task, agent_name: 'agent' });
    await call('task', { action: 'complete', id: ids.task, agent_name: 'agent', payload: { ok: true } });
    await call('task', { action: 'fail', id: ids.task, agent_name: 'agent', blocker_reason: 'blocked' });
    await call('task', { action: 'handoff', id: ids.task, agent_name: 'agent', target_agent_name: 'reviewer' });
    await call('task', { action: 'ack', id: ids.task, agent_name: 'reviewer' });
    await call('task', { action: 'append_event', id: ids.task, event_type: 'note', agent_name: 'agent' });
    await call('task', { action: 'inbox_list', workspace_id: ids.workspace, agent_name: 'reviewer', unread_only: true });
    await call('task', { action: 'inbox_ack', inbox_id: ids.inbox, agent_name: 'reviewer' });

    taskMocks.claimTask.mockResolvedValueOnce(null);
    await expect(call('task', { action: 'claim', workspace_id: ids.workspace, agent_name: 'agent' })).resolves.toMatchObject({
      error: { message: 'No claimable task found' },
    });
  });

  it('executes all run lifecycle actions and not-found handling', async () => {
    await call('run', { action: 'start', workspace_id: ids.workspace, agent_name: 'agent', title: 'Run' });
    await call('run', { action: 'get', id: ids.run, session_id: ids.session });
    await call('run', { action: 'list', workspace_id: ids.workspace, agent_name: 'agent', limit: 5 });
    await call('run', { action: 'checkpoint', id: ids.run, agent_name: 'agent', summary: 'Checkpoint' });
    await call('run', { action: 'complete', id: ids.run, agent_name: 'agent', result: { ok: true } });
    await call('run', { action: 'fail', id: ids.run, agent_name: 'agent', error_message: 'failed' });
    await call('run', { action: 'cancel', id: ids.run, agent_name: 'agent' });

    runMocks.getRun.mockResolvedValueOnce(null);
    await expect(call('run', { action: 'get', id: ids.run })).resolves.toMatchObject({
      error: { message: `Run ${ids.run} not found` },
    });
  });

  it('executes link actions, inferred create, previews, and not-found handling', async () => {
    await call('link', { from_type: 'page', from_id: ids.page, to_type: 'row', to_id: ids.row, link_type: 'supports' });
    await call('link', { action: 'list', item_type: 'page', item_id: ids.page, direction: 'both' });
    await call('link', { action: 'delete', link_id: ids.link, dry_run: true });

    linkMocks.deleteLink.mockResolvedValueOnce(false);
    await expect(call('link', { action: 'delete', link_id: ids.link })).resolves.toMatchObject({
      error: { message: `Link ${ids.link} not found` },
    });
  });

  it('executes search aliases, type shortcuts, database row scoping, and missing query errors', async () => {
    await expect(call('search', { q: 'memory', type: 'page', limit: 1, offset: 1 })).resolves.toMatchObject({
      meta: { limit: 1, offset: 1, total_available: 2 },
    });
    await call('search', { query: 'rows', database_id: ids.database });
    await expect(call('search', {})).resolves.toMatchObject({
      error: { message: 'query (or q) is required' },
      ok: false,
    });

    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ content_types: ['rows'] }));
  });
});
