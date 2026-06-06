import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServer } from '../mcp.js';

const ids = {
  page: '00000000-0000-0000-0000-00000000000a',
  run: '00000000-0000-0000-0000-000000000013',
  session: '00000000-0000-0000-0000-000000000014',
  task: '00000000-0000-0000-0000-000000000015',
  workspace: '00000000-0000-0000-0000-000000000001',
};

const workspaceMocks = {
  createWorkspace: vi.fn(),
};

const sessionMocks = {
  closeSession: vi.fn(),
  createSession: vi.fn(),
  getSessionResumeBundle: vi.fn(),
};

const pageMocks = {
  appendPageBlocks: vi.fn(),
  createPage: vi.fn(),
};

const taskMocks = {
  claimTask: vi.fn(),
  completeTask: vi.fn(),
  createTask: vi.fn(),
  failTask: vi.fn(),
  handoffTask: vi.fn(),
  heartbeatTask: vi.fn(),
  listTasks: vi.fn(),
};

const runMocks = {
  checkpointRun: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  startRun: vi.fn(),
};

const searchMock = vi.fn();

vi.mock('../db/queries/workspaces.js', () => workspaceMocks);
vi.mock('../db/queries/sessions.js', () => sessionMocks);
vi.mock('../db/queries/pages.js', () => pageMocks);
vi.mock('../db/queries/tasks.js', () => taskMocks);
vi.mock('../db/queries/runs.js', () => runMocks);
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

  const { registerCoreTools } = await import('./core.js');
  registerCoreTools(server);
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
  for (const group of [workspaceMocks, sessionMocks, pageMocks, taskMocks, runMocks]) {
    for (const mock of Object.values(group)) {
      mock.mockReset();
    }
  }
  searchMock.mockReset();
}

describe('core MCP tools', () => {
  beforeEach(() => {
    resetMocks();
    workspaceMocks.createWorkspace.mockResolvedValue({ id: ids.workspace, name: 'Workspace' });
    sessionMocks.createSession.mockResolvedValue({ id: ids.session, workspace_id: ids.workspace });
    sessionMocks.getSessionResumeBundle.mockResolvedValue({ bundle: { session: { id: ids.session } } });
    sessionMocks.closeSession.mockResolvedValue({ id: ids.session, status: 'closed' });
    pageMocks.createPage.mockResolvedValue({ id: ids.page, title: 'Journal' });
    pageMocks.appendPageBlocks.mockResolvedValue([{ id: 'block-1', content: 'note' }]);
    taskMocks.createTask.mockResolvedValue({ id: ids.task, title: 'Task' });
    taskMocks.listTasks.mockResolvedValue([{ id: ids.task, status: 'ready' }]);
    taskMocks.claimTask.mockResolvedValue({ id: ids.task, status: 'claimed' });
    taskMocks.heartbeatTask.mockResolvedValue({ id: ids.task, status: 'claimed' });
    taskMocks.completeTask.mockResolvedValue({ id: ids.task, status: 'done' });
    taskMocks.failTask.mockResolvedValue({ id: ids.task, status: 'failed' });
    taskMocks.handoffTask.mockResolvedValue({ id: ids.task, status: 'handoff_pending' });
    runMocks.startRun.mockResolvedValue({ id: ids.run, status: 'running' });
    runMocks.checkpointRun.mockResolvedValue({ id: ids.run, latest_checkpoint_sequence: 1 });
    runMocks.completeRun.mockResolvedValue({ id: ids.run, status: 'completed' });
    runMocks.failRun.mockResolvedValue({ id: ids.run, status: 'failed' });
    searchMock.mockResolvedValue([
      { id: ids.page, type: 'page', title: 'Hit' },
    ]);
  });

  it('registers the compact first-product tool surface', async () => {
    const tools = await buildTools();
    expect([...tools.keys()].sort()).toEqual(['coordination', 'memory', 'session']);
  });

  it('starts, resumes, and closes a session without exposing workspace CRUD', async () => {
    await expect(call('session', { action: 'start', workspace_name: 'Workspace', title: 'Triage' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(call('session', { action: 'resume', session_id: ids.session })).resolves.toMatchObject({
      ok: true,
    });
    await expect(call('session', { action: 'close', session_id: ids.session })).resolves.toMatchObject({
      ok: true,
    });

    expect(workspaceMocks.createWorkspace).toHaveBeenCalledWith('Workspace', undefined, undefined, undefined, { kind: 'system' });
    expect(sessionMocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Triage',
      workspace_id: ids.workspace,
    }));
  });

  it('stores and searches memory through one tool', async () => {
    await call('memory', {
      action: 'append',
      content: 'Queued follow-up',
      session_id: ids.session,
      tags: ['incident'],
      workspace_id: ids.workspace,
    });
    await expect(call('memory', { action: 'search', query: 'follow-up', workspace_id: ids.workspace, limit: 1 })).resolves.toMatchObject({
      meta: { limit: 1, total_available: 1 },
      ok: true,
    });

    expect(pageMocks.createPage).toHaveBeenCalledWith(expect.objectContaining({
      blocks: [{ block_type: 'text', content: 'Queued follow-up' }],
      session_id: ids.session,
      tags: ['incident'],
      workspace_id: ids.workspace,
    }));
    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({
      content_types: ['pages'],
      mode: 'hybrid',
      query: 'follow-up',
    }));
  });

  it('keeps durable task and run coordination in the core toolset', async () => {
    await call('coordination', { action: 'task_create', workspace_id: ids.workspace, title: 'Verify fix' });
    await call('coordination', { action: 'task_list', workspace_id: ids.workspace });
    await call('coordination', { action: 'task_claim', workspace_id: ids.workspace, agent_name: 'worker' });
    await call('coordination', { action: 'task_heartbeat', task_id: ids.task, agent_name: 'worker' });
    await call('coordination', { action: 'task_complete', task_id: ids.task, agent_name: 'worker', payload: { ok: true } });
    await call('coordination', { action: 'task_fail', task_id: ids.task, agent_name: 'worker', blocker_reason: 'blocked' });
    await call('coordination', { action: 'task_handoff', task_id: ids.task, agent_name: 'worker', target_agent_name: 'reviewer' });
    await call('coordination', { action: 'run_start', workspace_id: ids.workspace, agent_name: 'worker', task_id: ids.task });
    await call('coordination', { action: 'run_checkpoint', run_id: ids.run, agent_name: 'worker', summary: 'phase 1' });
    await call('coordination', { action: 'run_complete', run_id: ids.run, agent_name: 'worker', result: { ok: true } });
    await call('coordination', { action: 'run_fail', run_id: ids.run, agent_name: 'worker', error_message: 'failed' });

    expect(taskMocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Verify fix' }));
    expect(taskMocks.handoffTask).toHaveBeenCalledWith(expect.objectContaining({ target_agent_name: 'reviewer' }));
    expect(runMocks.checkpointRun).toHaveBeenCalledWith(expect.objectContaining({ summary: 'phase 1' }));
  });
});
