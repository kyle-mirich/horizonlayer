import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const writeFileMock = vi.fn();
const assertWorkspaceReadAccessMock = vi.fn();
const assertWorkspaceWriteAccessMock = vi.fn();
const assertSessionReadAccessMock = vi.fn();
const assertSessionWriteAccessMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    query: poolQueryMock,
  }),
}));

vi.mock('./accessControl.js', () => ({
  assertSessionReadAccess: assertSessionReadAccessMock,
  assertSessionWriteAccess: assertSessionWriteAccessMock,
  assertWorkspaceReadAccess: assertWorkspaceReadAccessMock,
  assertWorkspaceWriteAccess: assertWorkspaceWriteAccessMock,
}));

vi.mock('node:fs/promises', () => ({
  writeFile: writeFileMock,
}));

describe('session query layer', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    writeFileMock.mockReset();
    assertWorkspaceReadAccessMock.mockReset().mockResolvedValue(undefined);
    assertWorkspaceWriteAccessMock.mockReset().mockResolvedValue(undefined);
    assertSessionReadAccessMock.mockReset().mockResolvedValue({ workspace_id: 'ws-1' });
    assertSessionWriteAccessMock.mockReset().mockResolvedValue({ workspace_id: 'ws-1' });
  });

  it('creates, lists, gets, and closes sessions', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO sessions')) {
        return { rows: [{ id: 'session-1', workspace_id: 'ws-1', title: 'Session' }] };
      }
      if (sql.includes('FROM sessions') && sql.includes('ORDER BY last_activity_at DESC')) {
        return { rows: [{ id: 'session-1', workspace_id: 'ws-1' }] };
      }
      if (sql.includes('SELECT s.*') && sql.includes('page_count')) {
        return { rows: [{ id: 'session-1', workspace_id: 'ws-1', page_count: 1, task_count: 2, run_count: 3 }] };
      }
      if (sql.includes("SET status = 'closed'")) {
        return { rows: [{ id: 'session-1', workspace_id: 'ws-1', status: 'closed' }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { closeSession, createSession, getSession, listSessions } = await import('./sessions.js');
    const created = await createSession({ workspace_id: 'ws-1', title: 'Session' });
    const listed = await listSessions({ workspace_id: 'ws-1', limit: 10, offset: 0 });
    const loaded = await getSession('session-1', { workspace_id: 'ws-1' });
    const closed = await closeSession('session-1');

    expect(assertWorkspaceWriteAccessMock).toHaveBeenCalledWith('ws-1', expect.any(Object));
    expect(assertWorkspaceReadAccessMock).toHaveBeenCalledWith('ws-1', expect.any(Object));
    expect(assertSessionReadAccessMock).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(assertSessionWriteAccessMock).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(created.id).toBe('session-1');
    expect(listed[0]?.id).toBe('session-1');
    expect(loaded?.task_count).toBe(2);
    expect(closed?.status).toBe('closed');
  });

  it('touches session activity timestamps', async () => {
    poolQueryMock.mockResolvedValue({ rowCount: 1, rows: [] });
    const { touchSession } = await import('./sessions.js');
    await touchSession('session-2');
    expect(poolQueryMock).toHaveBeenCalledWith(expect.stringContaining('SET last_activity_at = NOW()'), ['session-2']);
  });

  it('builds resume bundles from session-scoped pages, tasks, runs, and search hits', async () => {
    poolQueryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT s.*') && sql.includes('page_count')) {
        return {
          rows: [{
            id: 'session-1',
            workspace_id: 'ws-1',
            title: 'Session title',
            summary: 'resume me',
            page_count: 1,
            task_count: 1,
            run_count: 1,
          }],
        };
      }
      if (sql.includes('FROM pages p') && sql.includes('content_preview')) {
        return { rows: [{ id: 'page-1', title: 'Page', content_preview: 'hello', tags: [], importance: 0.5, parent_page_id: null, created_at: 'now', updated_at: 'now' }] };
      }
      if (sql.includes('FROM tasks') && sql.includes('session_id = $1')) {
        return { rows: [{ id: 'task-1', title: 'Task', status: 'ready', priority: 1, owner_agent_name: null, handoff_target_agent_name: null, blocker_reason: null, last_event_at: 'now', created_at: 'now', updated_at: 'now' }] };
      }
      if (sql.includes('FROM agent_runs r')) {
        return { rows: [{ id: 'run-1', session_id: 'session-1', task_id: null, parent_run_id: null, agent_name: 'agent', title: null, status: 'running', metadata: {}, result: {}, error_message: null, latest_checkpoint_sequence: 1, latest_checkpoint_at: 'now', started_at: 'now', finished_at: null, created_at: 'now', updated_at: 'now', latest_checkpoint: { id: 'cp-1', run_id: 'run-1', sequence: 1, summary: 'checkpoint', state: {}, metadata: {}, created_at: 'now' } }] };
      }
      if (sql.includes('ORDER BY score DESC')) {
        expect(values?.[0]).toBe('session-1');
        return { rows: [{ id: 'page-1', title: 'Page', score: 3, snippet: 'hello world', updated_at: 'now' }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { getSessionResumeBundle } = await import('./sessions.js');
    const result = await getSessionResumeBundle({ session_id: 'session-1', workspace_id: 'ws-1', max_items: 5, max_bytes: 10_000 });

    expect(result?.truncated).toBe(false);
    expect(result?.bundle?.session.id).toBe('session-1');
    expect(result?.bundle?.recent_pages[0]?.id).toBe('page-1');
    expect(result?.bundle?.open_and_recent_tasks[0]?.id).toBe('task-1');
    expect(result?.bundle?.recent_runs[0]?.latest_checkpoint?.id).toBe('cp-1');
    expect(result?.bundle?.search_hits[0]?.id).toBe('page-1');
  });

  it('writes oversized resume bundles to /tmp instead of returning them inline', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT s.*') && sql.includes('page_count')) {
        return {
          rows: [{
            id: 'session-1',
            workspace_id: 'ws-1',
            title: 'Session title',
            summary: 'resume me',
            page_count: 1,
            task_count: 0,
            run_count: 0,
          }],
        };
      }
      if (sql.includes('FROM pages p') && sql.includes('content_preview')) {
        return { rows: [{ id: 'page-1', title: 'Page', content_preview: 'x'.repeat(5000), tags: [], importance: 0.5, parent_page_id: null, created_at: 'now', updated_at: 'now' }] };
      }
      if (sql.includes('FROM tasks') && sql.includes('session_id = $1')) {
        return { rows: [] };
      }
      if (sql.includes('FROM agent_runs r')) {
        return { rows: [] };
      }
      if (sql.includes('ORDER BY score DESC')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    writeFileMock.mockResolvedValue(undefined);

    const { getSessionResumeBundle } = await import('./sessions.js');
    const result = await getSessionResumeBundle({ session_id: 'session-1', max_bytes: 100 });

    expect(result?.truncated).toBe(true);
    expect(result?.file_path).toMatch(/^\/tmp\/horizonlayer-session-session-1-\d+\.txt$/);
    expect(writeFileMock).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/horizonlayer-session-session-1-\d+\.txt$/), expect.any(String), 'utf8');
    expect(result?.bundle).toBeUndefined();
  });
});
