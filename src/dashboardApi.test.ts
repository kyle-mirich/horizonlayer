import { beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceMocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  closeSession: vi.fn(),
  createSession: vi.fn(),
  getSessionResumeBundle: vi.fn(),
  listSessions: vi.fn(),
}));

const pageMocks = vi.hoisted(() => ({
  appendPageBlocks: vi.fn(),
  createPage: vi.fn(),
  listPages: vi.fn(),
}));

const searchMocks = vi.hoisted(() => ({
  search: vi.fn(),
}));

const taskMocks = vi.hoisted(() => ({
  claimTask: vi.fn(),
  completeTask: vi.fn(),
  createTask: vi.fn(),
  failTask: vi.fn(),
  handoffTask: vi.fn(),
  heartbeatTask: vi.fn(),
  listTasks: vi.fn(),
}));

const runMocks = vi.hoisted(() => ({
  checkpointRun: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  listRuns: vi.fn(),
  startRun: vi.fn(),
}));

const httpMocks = vi.hoisted(() => ({
  close: vi.fn(),
  createServer: vi.fn(),
  handler: null as null | ((request: unknown, response: unknown) => Promise<void>),
  listen: vi.fn(),
  off: vi.fn(),
  once: vi.fn(),
}));

vi.mock('./db/queries/workspaces.js', () => workspaceMocks);
vi.mock('./db/queries/sessions.js', () => sessionMocks);
vi.mock('./db/queries/pages.js', () => pageMocks);
vi.mock('./db/queries/search.js', () => searchMocks);
vi.mock('./db/queries/tasks.js', () => taskMocks);
vi.mock('./db/queries/runs.js', () => runMocks);
vi.mock('node:http', () => ({
  default: {
    createServer: httpMocks.createServer,
  },
}));

describe('dashboard API routing', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mockGroup of [
      workspaceMocks,
      sessionMocks,
      pageMocks,
      searchMocks,
      taskMocks,
      runMocks,
    ]) {
      for (const mock of Object.values(mockGroup)) {
        mock.mockReset();
      }
    }
    httpMocks.handler = null;
    httpMocks.once.mockReset();
    httpMocks.off.mockReset();
    httpMocks.listen.mockReset();
    httpMocks.close.mockReset();
    httpMocks.createServer.mockReset().mockImplementation((handler) => {
      httpMocks.handler = handler;
      return {
        close: httpMocks.close.mockImplementation((callback) => callback?.()),
        listen: httpMocks.listen.mockImplementation((_port, _host, callback) => callback?.()),
        off: httpMocks.off,
        once: httpMocks.once,
      };
    });
  });

  it('returns a health payload without touching the database', async () => {
    const { executeDashboardApiRequest } = await import('./dashboardApi.js');

    const response = await executeDashboardApiRequest({
      method: 'GET',
      pathname: '/api/health',
      query: new URLSearchParams(),
    });

    expect(response).toEqual({
      body: {
        ok: true,
        service: 'horizonlayer-dashboard-api',
      },
      status: 200,
    });
    expect(workspaceMocks.listWorkspaces).not.toHaveBeenCalled();
  });

  it('aggregates the dashboard around a workspace', async () => {
    workspaceMocks.getWorkspace.mockResolvedValue({ id: 'workspace-1', name: 'Main' });
    sessionMocks.listSessions.mockResolvedValue([{ id: 'session-1', title: 'Triage' }]);
    pageMocks.listPages.mockResolvedValue([{ id: 'page-1', title: 'Note' }]);
    taskMocks.listTasks.mockResolvedValue([{ id: 'task-1', status: 'ready' }]);
    runMocks.listRuns.mockResolvedValue([{ id: 'run-1', status: 'running' }]);

    const { executeDashboardApiRequest } = await import('./dashboardApi.js');
    const response = await executeDashboardApiRequest({
      method: 'GET',
      pathname: '/api/dashboard',
      query: new URLSearchParams({ workspace_id: 'workspace-1' }),
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      result: {
        pages: [{ id: 'page-1', title: 'Note' }],
        runs: [{ id: 'run-1', status: 'running' }],
        sessions: [{ id: 'session-1', title: 'Triage' }],
        tasks: [{ id: 'task-1', status: 'ready' }],
        workspace: { id: 'workspace-1', name: 'Main' },
      },
    });
    expect(taskMocks.listTasks).toHaveBeenCalledWith({
      workspace_id: 'workspace-1',
      limit: 100,
    });
  });

  it('lists workspaces, sessions, tasks, and runs with query filters', async () => {
    workspaceMocks.listWorkspaces.mockResolvedValue([{ id: 'workspace-1', name: 'Main' }]);
    sessionMocks.listSessions.mockResolvedValue([{ id: 'session-1', title: 'Plan' }]);
    taskMocks.listTasks.mockResolvedValue([{ id: 'task-1', status: 'ready' }]);
    runMocks.listRuns.mockResolvedValue([{ id: 'run-1', status: 'running' }]);

    const { executeDashboardApiRequest } = await import('./dashboardApi.js');

    await expect(executeDashboardApiRequest({
      method: 'GET',
      pathname: '/api/workspaces',
      query: new URLSearchParams(),
    })).resolves.toMatchObject({
      body: { result: [{ id: 'workspace-1', name: 'Main' }] },
      status: 200,
    });

    await executeDashboardApiRequest({
      method: 'GET',
      pathname: '/api/sessions',
      query: new URLSearchParams({ limit: '2', workspace_id: 'workspace-1' }),
    });
    await executeDashboardApiRequest({
      method: 'GET',
      pathname: '/api/tasks',
      query: new URLSearchParams({
        limit: '3',
        session_id: 'session-1',
        status: 'ready,blocked',
        workspace_id: 'workspace-1',
      }),
    });
    await executeDashboardApiRequest({
      method: 'GET',
      pathname: '/api/runs',
      query: new URLSearchParams({
        limit: '4',
        session_id: 'session-1',
        status: 'running,failed',
        workspace_id: 'workspace-1',
      }),
    });

    expect(sessionMocks.listSessions).toHaveBeenCalledWith({
      limit: 2,
      workspace_id: 'workspace-1',
    });
    expect(taskMocks.listTasks).toHaveBeenCalledWith({
      limit: 3,
      session_id: 'session-1',
      status: ['ready', 'blocked'],
      workspace_id: 'workspace-1',
    });
    expect(runMocks.listRuns).toHaveBeenCalledWith({
      limit: 4,
      session_id: 'session-1',
      status: ['running', 'failed'],
      workspace_id: 'workspace-1',
    });
  });

  it('returns required query errors before list handlers run', async () => {
    const { executeDashboardApiRequest } = await import('./dashboardApi.js');

    for (const pathname of ['/api/dashboard', '/api/sessions', '/api/tasks', '/api/runs']) {
      const response = await executeDashboardApiRequest({
        method: 'GET',
        pathname,
        query: new URLSearchParams(),
      });

      expect(response).toMatchObject({
        body: { error: { message: 'workspace_id is required' }, ok: false },
        status: 400,
      });
    }

    expect(workspaceMocks.getWorkspace).not.toHaveBeenCalled();
    expect(sessionMocks.listSessions).not.toHaveBeenCalled();
    expect(taskMocks.listTasks).not.toHaveBeenCalled();
    expect(runMocks.listRuns).not.toHaveBeenCalled();
  });

  it('creates core workflow records through query-layer operations', async () => {
    workspaceMocks.createWorkspace.mockResolvedValue({ id: 'workspace-1', name: 'Main' });
    sessionMocks.createSession.mockResolvedValue({ id: 'session-1', workspace_id: 'workspace-1' });
    pageMocks.createPage.mockResolvedValue({ id: 'page-1', title: 'Decision', blocks: [] });
    taskMocks.createTask.mockResolvedValue({ id: 'task-1', title: 'Ship app' });
    runMocks.startRun.mockResolvedValue({ id: 'run-1', status: 'running', checkpoints: [] });

    const { executeDashboardApiRequest } = await import('./dashboardApi.js');

    await expect(executeDashboardApiRequest({
      body: { name: 'Main' },
      method: 'POST',
      pathname: '/api/workspaces',
      query: new URLSearchParams(),
    })).resolves.toMatchObject({ body: { result: { id: 'workspace-1' } }, status: 201 });

    await expect(executeDashboardApiRequest({
      body: { title: 'Triage', workspace_id: 'workspace-1' },
      method: 'POST',
      pathname: '/api/sessions',
      query: new URLSearchParams(),
    })).resolves.toMatchObject({ body: { result: { id: 'session-1' } }, status: 201 });

    await expect(executeDashboardApiRequest({
      body: { content: 'A useful note', session_id: 'session-1', title: 'Decision', workspace_id: 'workspace-1' },
      method: 'POST',
      pathname: '/api/memory',
      query: new URLSearchParams(),
    })).resolves.toMatchObject({ body: { result: { id: 'page-1' } }, status: 201 });

    await expect(executeDashboardApiRequest({
      body: { title: 'Ship app', workspace_id: 'workspace-1' },
      method: 'POST',
      pathname: '/api/tasks',
      query: new URLSearchParams(),
    })).resolves.toMatchObject({ body: { result: { id: 'task-1' } }, status: 201 });

    await expect(executeDashboardApiRequest({
      body: { agent_name: 'codex', title: 'Build pass', workspace_id: 'workspace-1' },
      method: 'POST',
      pathname: '/api/runs',
      query: new URLSearchParams(),
    })).resolves.toMatchObject({ body: { result: { id: 'run-1' } }, status: 201 });

    expect(pageMocks.createPage).toHaveBeenCalledWith({
      access: { kind: 'system' },
      blocks: [{ block_type: 'text', content: 'A useful note' }],
      session_id: 'session-1',
      tags: undefined,
      title: 'Decision',
      workspace_id: 'workspace-1',
    });
  });

  it('lists memory pages and delegates search queries to hybrid search', async () => {
    pageMocks.listPages.mockResolvedValue([{ id: 'page-1', title: 'Journal' }]);
    searchMocks.search.mockResolvedValue([{ id: 'page-2', title: 'Decision', score: 0.7 }]);

    const { executeDashboardApiRequest } = await import('./dashboardApi.js');

    await expect(executeDashboardApiRequest({
      method: 'GET',
      pathname: '/api/memory',
      query: new URLSearchParams({ limit: '7', session_id: 'session-1', workspace_id: 'workspace-1' }),
    })).resolves.toMatchObject({
      body: { result: [{ id: 'page-1', title: 'Journal' }] },
      status: 200,
    });

    await expect(executeDashboardApiRequest({
      method: 'GET',
      pathname: '/api/memory',
      query: new URLSearchParams({ query: 'ship decision', session_id: 'session-1', workspace_id: 'workspace-1' }),
    })).resolves.toMatchObject({
      body: { result: [{ id: 'page-2', title: 'Decision', score: 0.7 }] },
      status: 200,
    });

    expect(pageMocks.listPages).toHaveBeenCalledWith({
      limit: 7,
      session_id: 'session-1',
      workspace_id: 'workspace-1',
    });
    expect(searchMocks.search).toHaveBeenCalledWith({
      access: { kind: 'system' },
      content_types: ['pages'],
      limit: 50,
      mode: 'hybrid',
      query: 'ship decision',
      session_id: 'session-1',
      workspace_id: 'workspace-1',
    });
  });

  it('appends memory to an existing page without requiring a workspace id', async () => {
    pageMocks.appendPageBlocks.mockResolvedValue([{ id: 'block-1', content: 'More context' }]);

    const { executeDashboardApiRequest } = await import('./dashboardApi.js');
    const response = await executeDashboardApiRequest({
      body: { content: 'More context', page_id: 'page-1', session_id: 'session-1' },
      method: 'POST',
      pathname: '/api/memory',
      query: new URLSearchParams(),
    });

    expect(response).toMatchObject({
      body: { result: [{ id: 'block-1', content: 'More context' }] },
      status: 201,
    });
    expect(pageMocks.appendPageBlocks).toHaveBeenCalledWith(
      'page-1',
      [{ block_type: 'text', content: 'More context' }],
      { kind: 'system' },
      undefined,
      'session-1'
    );
    expect(pageMocks.createPage).not.toHaveBeenCalled();
  });

  it('rejects new memory without a workspace id when no page id is provided', async () => {
    const { executeDashboardApiRequest } = await import('./dashboardApi.js');

    const response = await executeDashboardApiRequest({
      body: { content: 'Loose note' },
      method: 'POST',
      pathname: '/api/memory',
      query: new URLSearchParams(),
    });

    expect(response).toMatchObject({
      body: {
        error: { message: 'workspace_id is required when page_id is not provided' },
        ok: false,
      },
      status: 400,
    });
    expect(pageMocks.createPage).not.toHaveBeenCalled();
  });

  it('resumes and closes sessions through session routes', async () => {
    sessionMocks.getSessionResumeBundle.mockResolvedValue({
      bundle: { recommended_next_actions: ['Claim ready task'] },
      session: { id: 'session-1' },
    });
    sessionMocks.closeSession.mockResolvedValue({ id: 'session-1', status: 'closed' });

    const { executeDashboardApiRequest } = await import('./dashboardApi.js');

    await expect(executeDashboardApiRequest({
      method: 'GET',
      pathname: '/api/sessions/session-1/resume',
      query: new URLSearchParams({ max_items: '5', workspace_id: 'workspace-1' }),
    })).resolves.toMatchObject({
      body: { result: { session: { id: 'session-1' } } },
      status: 200,
    });

    await expect(executeDashboardApiRequest({
      body: undefined,
      method: 'POST',
      pathname: '/api/sessions/session-1/close',
      query: new URLSearchParams(),
    })).resolves.toMatchObject({
      body: { result: { id: 'session-1', status: 'closed' } },
      status: 200,
    });

    expect(sessionMocks.getSessionResumeBundle).toHaveBeenCalledWith({
      access: { kind: 'system' },
      max_items: 5,
      session_id: 'session-1',
      workspace_id: 'workspace-1',
    });
    expect(sessionMocks.closeSession).toHaveBeenCalledWith('session-1', { kind: 'system' });
  });

  it('returns not found for missing session resume and close targets', async () => {
    sessionMocks.getSessionResumeBundle.mockResolvedValue(null);
    sessionMocks.closeSession.mockResolvedValue(null);

    const { executeDashboardApiRequest } = await import('./dashboardApi.js');

    await expect(executeDashboardApiRequest({
      method: 'GET',
      pathname: '/api/sessions/missing-session/resume',
      query: new URLSearchParams(),
    })).resolves.toMatchObject({
      body: { error: { message: 'Session missing-session not found' }, ok: false },
      status: 404,
    });

    await expect(executeDashboardApiRequest({
      method: 'POST',
      pathname: '/api/sessions/missing-session/close',
      query: new URLSearchParams(),
    })).resolves.toMatchObject({
      body: { error: { message: 'Session missing-session not found' }, ok: false },
      status: 404,
    });
  });

  it('routes task lifecycle actions with the expected agent payloads', async () => {
    taskMocks.claimTask.mockResolvedValue({ id: 'task-1', status: 'claimed' });
    taskMocks.heartbeatTask.mockResolvedValue({ id: 'task-1', status: 'claimed' });
    taskMocks.completeTask.mockResolvedValue({ id: 'task-1', status: 'done' });
    taskMocks.failTask.mockResolvedValue({ id: 'task-1', status: 'blocked' });
    taskMocks.handoffTask.mockResolvedValue({ id: 'task-1', status: 'handoff_pending' });

    const { executeDashboardApiRequest } = await import('./dashboardApi.js');

    await executeDashboardApiRequest({
      body: { agent_name: 'codex', lease_seconds: 120, workspace_id: 'workspace-1' },
      method: 'POST',
      pathname: '/api/tasks/task-1/claim',
      query: new URLSearchParams(),
    });
    await executeDashboardApiRequest({
      body: { agent_name: 'codex', payload: { phase: 'working' } },
      method: 'POST',
      pathname: '/api/tasks/task-1/heartbeat',
      query: new URLSearchParams(),
    });
    await executeDashboardApiRequest({
      body: { agent_name: 'codex', payload: { ok: true } },
      method: 'POST',
      pathname: '/api/tasks/task-1/complete',
      query: new URLSearchParams(),
    });
    await executeDashboardApiRequest({
      body: { agent_name: 'codex', blocker_reason: 'Needs review', payload: { failed: true } },
      method: 'POST',
      pathname: '/api/tasks/task-1/fail',
      query: new URLSearchParams(),
    });
    await executeDashboardApiRequest({
      body: { actor_agent_name: 'codex', target_agent_name: 'reviewer' },
      method: 'POST',
      pathname: '/api/tasks/task-1/handoff',
      query: new URLSearchParams(),
    });

    expect(taskMocks.claimTask).toHaveBeenCalledWith({
      access: { kind: 'system' },
      agent_name: 'codex',
      lease_seconds: 120,
      task_id: 'task-1',
      workspace_id: 'workspace-1',
    });
    expect(taskMocks.heartbeatTask).toHaveBeenCalledWith({
      access: { kind: 'system' },
      agent_name: 'codex',
      payload: { phase: 'working' },
      task_id: 'task-1',
    });
    expect(taskMocks.completeTask).toHaveBeenCalledWith({
      access: { kind: 'system' },
      agent_name: 'codex',
      payload: { ok: true },
      task_id: 'task-1',
    });
    expect(taskMocks.failTask).toHaveBeenCalledWith({
      access: { kind: 'system' },
      agent_name: 'codex',
      blocker_reason: 'Needs review',
      payload: { failed: true },
      task_id: 'task-1',
    });
    expect(taskMocks.handoffTask).toHaveBeenCalledWith({
      access: { kind: 'system' },
      actor_agent_name: 'codex',
      target_agent_name: 'reviewer',
      task_id: 'task-1',
    });
  });

  it('routes run checkpoint and finish actions', async () => {
    runMocks.checkpointRun.mockResolvedValue({ id: 'checkpoint-1', sequence: 1 });
    runMocks.completeRun.mockResolvedValue({ id: 'run-1', status: 'completed' });
    runMocks.failRun.mockResolvedValue({ id: 'run-1', status: 'failed' });

    const { executeDashboardApiRequest } = await import('./dashboardApi.js');

    await expect(executeDashboardApiRequest({
      body: { agent_name: 'codex', state: { step: 1 }, summary: 'Checkpointed' },
      method: 'POST',
      pathname: '/api/runs/run-1/checkpoints',
      query: new URLSearchParams(),
    })).resolves.toMatchObject({ status: 201 });

    await executeDashboardApiRequest({
      body: { agent_name: 'codex', result: { ok: true } },
      method: 'POST',
      pathname: '/api/runs/run-1/complete',
      query: new URLSearchParams(),
    });
    await executeDashboardApiRequest({
      body: { agent_name: 'codex', error_message: 'Stopped', result: { ok: false } },
      method: 'POST',
      pathname: '/api/runs/run-1/fail',
      query: new URLSearchParams(),
    });

    expect(runMocks.checkpointRun).toHaveBeenCalledWith({
      access: { kind: 'system' },
      agent_name: 'codex',
      run_id: 'run-1',
      state: { step: 1 },
      summary: 'Checkpointed',
    });
    expect(runMocks.completeRun).toHaveBeenCalledWith({
      access: { kind: 'system' },
      agent_name: 'codex',
      result: { ok: true },
      run_id: 'run-1',
    });
    expect(runMocks.failRun).toHaveBeenCalledWith({
      access: { kind: 'system' },
      agent_name: 'codex',
      error_message: 'Stopped',
      result: { ok: false },
      run_id: 'run-1',
    });
  });

  it('returns validation errors for missing required fields', async () => {
    const { executeDashboardApiRequest } = await import('./dashboardApi.js');

    const response = await executeDashboardApiRequest({
      body: { title: 'Missing workspace' },
      method: 'POST',
      pathname: '/api/tasks',
      query: new URLSearchParams(),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { message: expect.stringContaining('workspace_id') },
      ok: false,
    });
    expect(taskMocks.createTask).not.toHaveBeenCalled();
  });

  it('wraps unexpected query errors in a 500 response', async () => {
    workspaceMocks.listWorkspaces.mockRejectedValue(new Error('database unavailable'));

    const { executeDashboardApiRequest } = await import('./dashboardApi.js');
    const response = await executeDashboardApiRequest({
      method: 'GET',
      pathname: '/api/workspaces',
      query: new URLSearchParams(),
    });

    expect(response).toEqual({
      body: { error: { message: 'database unavailable' }, ok: false },
      status: 500,
    });
  });

  it('serves JSON through the HTTP handler and closes cleanly', async () => {
    workspaceMocks.createWorkspace.mockResolvedValue({ id: 'workspace-1', name: 'Main' });

    const { startDashboardApiServer } = await import('./dashboardApi.js');
    const server = await startDashboardApiServer({ host: '127.0.0.1', port: 3737 });

    expect(server.url).toBe('http://127.0.0.1:3737');
    expect(httpMocks.listen).toHaveBeenCalledWith(3737, '127.0.0.1', expect.any(Function));
    expect(httpMocks.handler).toBeDefined();

    async function callHandler(request: {
      body?: string;
      headers?: Record<string, string>;
      method?: string;
      url?: string;
    }) {
      const writeHead = vi.fn();
      const end = vi.fn();
      const fakeRequest = {
        headers: request.headers ?? { host: '127.0.0.1:3737' },
        method: request.method,
        url: request.url,
        async *[Symbol.asyncIterator]() {
          if (request.body !== undefined) {
            yield Buffer.from(request.body);
          }
        },
      };
      const fakeResponse = { end, writeHead };

      await httpMocks.handler?.(fakeRequest, fakeResponse);

      return {
        body: JSON.parse(String(end.mock.calls[0]?.[0] ?? '{}')) as unknown,
        end,
        status: writeHead.mock.calls[0]?.[0] as number,
        writeHead,
      };
    }

    await expect(callHandler({
      method: 'GET',
      url: '/api/health',
    })).resolves.toMatchObject({
      body: { ok: true, service: 'horizonlayer-dashboard-api' },
      status: 200,
    });

    await expect(callHandler({
      method: 'OPTIONS',
      url: '/api/health',
    })).resolves.toMatchObject({
      body: { ok: true },
      status: 204,
    });

    await expect(callHandler({
      body: JSON.stringify({ name: 'Main' }),
      method: 'POST',
      url: '/api/workspaces',
    })).resolves.toMatchObject({
      body: { ok: true, result: { id: 'workspace-1', name: 'Main' } },
      status: 201,
    });
    expect(workspaceMocks.createWorkspace).toHaveBeenCalledWith(
      'Main',
      undefined,
      undefined,
      undefined,
      { kind: 'system' }
    );

    await expect(callHandler({
      body: '{bad json',
      method: 'POST',
      url: '/api/workspaces',
    })).resolves.toMatchObject({
      body: { ok: false },
      status: 500,
    });

    await expect(server.close()).resolves.toBeUndefined();
    expect(httpMocks.close).toHaveBeenCalled();
  });

  it('returns not found and method errors for unsupported requests', async () => {
    const { executeDashboardApiRequest } = await import('./dashboardApi.js');

    await expect(executeDashboardApiRequest({
      method: 'GET',
      pathname: '/api/unknown',
      query: new URLSearchParams(),
    })).resolves.toMatchObject({
      body: { error: { message: 'Not found' }, ok: false },
      status: 404,
    });

    await expect(executeDashboardApiRequest({
      method: 'DELETE',
      pathname: '/api/tasks/task-1',
      query: new URLSearchParams(),
    })).resolves.toMatchObject({
      body: { error: { message: 'Method not allowed' }, ok: false },
      status: 405,
    });
  });
});
