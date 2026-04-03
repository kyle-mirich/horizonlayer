import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServer } from '../mcp.js';

type Workspace = { id: string; name: string; description: string | null; icon: string | null };
type Session = { id: string; workspace_id: string; title: string; status: 'active' | 'closed'; last_activity_at: string };
type Page = { id: string; workspace_id: string; session_id: string | null; title: string; blocks: Array<{ id: string; content: string }> };
type Task = { id: string; workspace_id: string; session_id: string | null; title: string };
type Run = { id: string; workspace_id: string; session_id: string | null; agent_name: string; checkpoints: unknown[] };

let nowCounter = 0;
let nextId = 0;
let workspaces: Workspace[] = [];
let sessions: Session[] = [];
let pages: Page[] = [];
let tasks: Task[] = [];
let runs: Run[] = [];

function nextUuid(prefix: string) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function nextTimestamp() {
  nowCounter += 1;
  return new Date(2026, 0, 1, 0, 0, nowCounter).toISOString();
}

const createWorkspaceMock = vi.fn(async (name: string, description?: string, icon?: string) => {
  const workspace = { id: nextUuid('ws'), name, description: description ?? null, icon: icon ?? null };
  workspaces.push(workspace);
  return workspace;
});

const listWorkspacesMock = vi.fn(async () => workspaces);
const getWorkspaceMock = vi.fn(async (id: string) => workspaces.find((workspace) => workspace.id === id) ?? null);
const updateWorkspaceMock = vi.fn(async (id: string) => workspaces.find((workspace) => workspace.id === id) ?? null);
const deleteWorkspaceMock = vi.fn(async (id: string) => {
  workspaces = workspaces.filter((workspace) => workspace.id !== id);
  sessions = sessions.filter((session) => session.workspace_id !== id);
  pages = pages.filter((page) => page.workspace_id !== id);
  tasks = tasks.filter((task) => task.workspace_id !== id);
  runs = runs.filter((run) => run.workspace_id !== id);
  return true;
});

const createSessionMock = vi.fn(async ({ workspace_id, title }: { workspace_id: string; title?: string }) => {
  const session = {
    id: nextUuid('session'),
    workspace_id,
    title: title ?? 'Session',
    status: 'active' as const,
    last_activity_at: nextTimestamp(),
  };
  sessions.push(session);
  return session;
});

const listSessionsMock = vi.fn(async ({ workspace_id }: { workspace_id: string }) =>
  sessions
    .filter((session) => session.workspace_id === workspace_id)
    .slice()
    .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at))
);

const getSessionMock = vi.fn(async (sessionId: string) => {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) return null;
  return {
    ...session,
    page_count: pages.filter((page) => page.session_id === sessionId).length,
    task_count: tasks.filter((task) => task.session_id === sessionId).length,
    run_count: runs.filter((run) => run.session_id === sessionId).length,
  };
});

const getSessionResumeBundleMock = vi.fn(async ({ session_id }: { session_id: string }) => ({
  bytes: 10,
  bundle: {
    open_and_recent_tasks: tasks.filter((task) => task.session_id === session_id),
    recent_pages: pages.filter((page) => page.session_id === session_id),
    recent_runs: runs.filter((run) => run.session_id === session_id),
    search_hits: pages.filter((page) => page.session_id === session_id).map((page) => ({ id: page.id, title: page.title })),
    session: await getSessionMock(session_id),
  },
  max_bytes: 1024,
  truncated: false,
}));

const closeSessionMock = vi.fn(async (sessionId: string) => {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) return null;
  session.status = 'closed';
  session.last_activity_at = nextTimestamp();
  return session;
});

const createPageMock = vi.fn(async ({ workspace_id, session_id, title, blocks }: { workspace_id: string; session_id?: string; title: string; blocks?: Array<{ content?: string }> }) => {
  const page = {
    id: nextUuid('page'),
    workspace_id,
    session_id: session_id ?? null,
    title,
    blocks: (blocks ?? []).map((block) => ({ id: nextUuid('block'), content: block.content ?? '' })),
  };
  pages.push(page);
  const session = sessions.find((item) => item.id === session_id);
  if (session) session.last_activity_at = nextTimestamp();
  return page;
});

const getPageMock = vi.fn();
const listPagesMock = vi.fn();
const updatePageMock = vi.fn();
const appendPageBlocksMock = vi.fn();
const updatePageBlockMock = vi.fn();
const deletePageBlockMock = vi.fn();
const deletePageMock = vi.fn();

const createTaskMock = vi.fn(async ({ workspace_id, session_id, title }: { workspace_id: string; session_id?: string; title: string }) => {
  const task = { id: nextUuid('task'), workspace_id, session_id: session_id ?? null, title };
  tasks.push(task);
  const session = sessions.find((item) => item.id === session_id);
  if (session) session.last_activity_at = nextTimestamp();
  return task;
});

const getTaskMock = vi.fn();
const listTasksMock = vi.fn();
const claimTaskMock = vi.fn();
const heartbeatTaskMock = vi.fn();
const completeTaskMock = vi.fn();
const failTaskMock = vi.fn();
const handoffTaskMock = vi.fn();
const acknowledgeTaskMock = vi.fn();
const appendTaskEventMock = vi.fn();
const listInboxMock = vi.fn();
const acknowledgeInboxItemMock = vi.fn();

const startRunMock = vi.fn(async ({ workspace_id, session_id, agent_name }: { workspace_id: string; session_id?: string; agent_name: string }) => {
  const run = { id: nextUuid('run'), workspace_id, session_id: session_id ?? null, agent_name, checkpoints: [] };
  runs.push(run);
  const session = sessions.find((item) => item.id === session_id);
  if (session) session.last_activity_at = nextTimestamp();
  return run;
});

const getRunMock = vi.fn();
const listRunsMock = vi.fn();
const checkpointRunMock = vi.fn();
const completeRunMock = vi.fn();
const failRunMock = vi.fn();
const cancelRunMock = vi.fn();

const searchMock = vi.fn(async ({ session_id }: { session_id?: string }) =>
  pages
    .filter((page) => (session_id ? page.session_id === session_id : true))
    .map((page) => ({
      id: page.id,
      score: 1,
      snippet: page.blocks[0]?.content ?? '',
      tags: [],
      title: page.title,
      type: 'page' as const,
      workspace_id: page.workspace_id,
    }))
);

vi.mock('../db/queries/workspaces.js', () => ({
  createWorkspace: createWorkspaceMock,
  deleteWorkspace: deleteWorkspaceMock,
  getWorkspace: getWorkspaceMock,
  listWorkspaces: listWorkspacesMock,
  updateWorkspace: updateWorkspaceMock,
}));

vi.mock('../db/queries/sessions.js', () => ({
  closeSession: closeSessionMock,
  createSession: createSessionMock,
  getSession: getSessionMock,
  getSessionResumeBundle: getSessionResumeBundleMock,
  listSessions: listSessionsMock,
}));

vi.mock('../db/queries/pages.js', () => ({
  appendPageBlocks: appendPageBlocksMock,
  createPage: createPageMock,
  deletePage: deletePageMock,
  deletePageBlock: deletePageBlockMock,
  getPage: getPageMock,
  listPages: listPagesMock,
  updatePage: updatePageMock,
  updatePageBlock: updatePageBlockMock,
}));

vi.mock('../db/queries/tasks.js', () => ({
  acknowledgeInboxItem: acknowledgeInboxItemMock,
  acknowledgeTask: acknowledgeTaskMock,
  appendTaskEvent: appendTaskEventMock,
  claimTask: claimTaskMock,
  completeTask: completeTaskMock,
  createTask: createTaskMock,
  failTask: failTaskMock,
  getTask: getTaskMock,
  handoffTask: handoffTaskMock,
  heartbeatTask: heartbeatTaskMock,
  listInbox: listInboxMock,
  listTasks: listTasksMock,
}));

vi.mock('../db/queries/runs.js', () => ({
  cancelRun: cancelRunMock,
  checkpointRun: checkpointRunMock,
  completeRun: completeRunMock,
  failRun: failRunMock,
  getRun: getRunMock,
  listRuns: listRunsMock,
  startRun: startRunMock,
}));

vi.mock('../db/queries/search.js', () => ({
  search: searchMock,
}));

async function registerTools() {
  const tools = new Map<string, (params: Record<string, unknown>, context: { session?: unknown }) => Promise<{ content: Array<{ text: string }> }>>();
  const server = {
    addTool(definition: { name: string; execute: (params: Record<string, unknown>, context: { session?: unknown }) => Promise<{ content: Array<{ text: string }> }> }) {
      tools.set(definition.name, definition.execute);
    },
  } as unknown as AppServer;

  const [{ registerWorkspaceTools }, { registerPageTools }, { registerTaskTools }, { registerRunTools }, { registerSearchTools }] = await Promise.all([
    import('./workspaces.js'),
    import('./pages.js'),
    import('./tasks.js'),
    import('./runs.js'),
    import('./search.js'),
  ]);

  registerWorkspaceTools(server);
  registerPageTools(server);
  registerTaskTools(server);
  registerRunTools(server);
  registerSearchTools(server);
  return tools;
}

function parseResult(response: { content: Array<{ text: string }> }) {
  return JSON.parse(response.content[0].text) as { result: unknown };
}

describe('session flow', () => {
  beforeEach(() => {
    nowCounter = 0;
    nextId = 0;
    workspaces = [];
    sessions = [];
    pages = [];
    tasks = [];
    runs = [];
    vi.clearAllMocks();
  });

  it('keeps list/get/resume scoped to the selected session', async () => {
    const tools = await registerTools();
    const workspace = parseResult(await tools.get('workspace')!({
      action: 'create',
      name: 'Workspace',
    }, { session: undefined })).result as Workspace;

    const sessionA = parseResult(await tools.get('workspace')!({
      action: 'start_session',
      title: 'A',
      workspace_id: workspace.id,
    }, { session: undefined })).result as Session;

    await tools.get('page')!({
      action: 'append_text',
      content: 'A page',
      session_id: sessionA.id,
      workspace_id: workspace.id,
    }, { session: undefined });
    await tools.get('task')!({
      action: 'create',
      session_id: sessionA.id,
      title: 'Task A',
      workspace_id: workspace.id,
    }, { session: undefined });
    await tools.get('run')!({
      action: 'start',
      agent_name: 'agent-a',
      session_id: sessionA.id,
      workspace_id: workspace.id,
    }, { session: undefined });

    const sessionB = parseResult(await tools.get('workspace')!({
      action: 'start_session',
      title: 'B',
      workspace_id: workspace.id,
    }, { session: undefined })).result as Session;

    await tools.get('page')!({
      action: 'append_text',
      content: 'B page',
      session_id: sessionB.id,
      workspace_id: workspace.id,
    }, { session: undefined });
    await tools.get('task')!({
      action: 'create',
      session_id: sessionB.id,
      title: 'Task B',
      workspace_id: workspace.id,
    }, { session: undefined });
    await tools.get('run')!({
      action: 'start',
      agent_name: 'agent-b',
      session_id: sessionB.id,
      workspace_id: workspace.id,
    }, { session: undefined });

    const listed = parseResult(await tools.get('workspace')!({
      action: 'list_sessions',
      workspace_id: workspace.id,
    }, { session: undefined })).result as Session[];
    const sessionDetailsA = parseResult(await tools.get('workspace')!({
      action: 'get_session',
      session_id: sessionA.id,
      workspace_id: workspace.id,
    }, { session: undefined })).result as { page_count: number; task_count: number; run_count: number };
    const resumedA = parseResult(await tools.get('workspace')!({
      action: 'resume_session_context',
      session_id: sessionA.id,
      workspace_id: workspace.id,
    }, { session: undefined })).result as {
      bundle: {
        recent_pages: Array<{ title: string }>;
        open_and_recent_tasks: Array<{ title: string }>;
        recent_runs: Array<{ agent_name: string }>;
      };
    };

    expect(listed.map((session) => session.id)).toEqual([sessionB.id, sessionA.id]);
    expect(sessionDetailsA).toMatchObject({ page_count: 1, task_count: 1, run_count: 1 });
    expect(resumedA.bundle.recent_pages.map((page) => page.title)).toEqual([expect.stringContaining('Journal')]);
    expect(resumedA.bundle.open_and_recent_tasks.map((task) => task.title)).toEqual(['Task A']);
    expect(resumedA.bundle.recent_runs.map((run) => run.agent_name)).toEqual(['agent-a']);
  });
});
