import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const requireActiveWorkspaceMock = vi.fn();
const requireSessionMock = vi.fn();
const requireActiveSessionMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    query: poolQueryMock,
  }),
}));

vi.mock('./scopeGuards.js', () => ({
  requireActiveSession: requireActiveSessionMock,
  requireActiveWorkspace: requireActiveWorkspaceMock,
  requireSession: requireSessionMock,
}));

describe('session query layer', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    requireActiveWorkspaceMock.mockReset().mockResolvedValue(undefined);
    requireSessionMock.mockReset().mockResolvedValue({ workspace_id: 'ws-1' });
    requireActiveSessionMock.mockReset().mockResolvedValue({ workspace_id: 'ws-1' });
  });

  it('creates, lists, gets, and closes sessions', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO sessions')) {
        return { rows: [{ id: 'session-1', workspace_id: 'ws-1', title: 'Session' }] };
      }
      if (sql.includes('FROM sessions') && sql.includes('ORDER BY last_activity_at DESC')) {
        return { rows: [{ id: 'session-1', workspace_id: 'ws-1' }] };
      }
      if (sql.includes('SELECT s.id') && sql.includes('page_count')) {
        return { rows: [{ id: 'session-1', workspace_id: 'ws-1', page_count: 1, run_count: 3 }] };
      }
      if (sql.includes("SET status = 'closed'")) {
        return { rows: [{ id: 'session-1', workspace_id: 'ws-1', status: 'closed' }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { closeSession, createSession, getSession, listSessions } = await import('./sessions.js');
    const created = await createSession({ workspace_id: 'ws-1', title: 'Session' });
    const listed = await listSessions({
      workspace_id: 'ws-1',
      status: ['active'],
      limit: 10,
      offset: 0,
    });
    const loaded = await getSession('session-1', { workspace_id: 'ws-1' });
    const closed = await closeSession('session-1');

    expect(requireActiveWorkspaceMock).toHaveBeenCalledWith('ws-1');
    expect(requireSessionMock).toHaveBeenCalledWith('session-1');
    expect(requireActiveSessionMock).toHaveBeenCalledWith('session-1');
    expect(created.id).toBe('session-1');
    expect(listed[0]?.id).toBe('session-1');
    expect(loaded?.run_count).toBe(3);
    expect(closed?.status).toBe('closed');

    const listCall = poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('ORDER BY last_activity_at DESC'));
    expect(String(listCall?.[0])).toContain('LIMIT $3 OFFSET $4');
    expect(listCall?.[1]).toEqual(['ws-1', ['active'], 10, 0]);
    const getSql = String(poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('page_count'))?.[0]);
    expect(getSql).not.toContain('s.*');
    expect(getSql).toContain('archived_at IS NULL');
    const closeSql = String(poolQueryMock.mock.calls.find(([sql]) => String(sql).includes("SET status = 'closed'"))?.[0]);
    expect(closeSql).toContain("status = 'active'");
  });

  it('allows the internal lookahead limit and rejects invalid session pagination', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const { listSessions } = await import('./sessions.js');

    await expect(listSessions({ workspace_id: 'ws-1', limit: 101 })).resolves.toEqual([]);
    await expect(listSessions({ workspace_id: 'ws-1', limit: 102 })).rejects.toThrow(
      'limit must be an integer between 0 and 101'
    );
    await expect(listSessions({ workspace_id: 'ws-1', offset: -1 })).rejects.toThrow(
      'offset must be an integer between 0 and 1000000'
    );
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual(['ws-1', null, 101, 0]);
  });

  it('creates sessions with default titles and JSON metadata', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ id: 'session-1', workspace_id: 'ws-1', title: 'Session default' }],
    });

    const { createSession } = await import('./sessions.js');
    await createSession({
      metadata: { agent: 'codex', fresh: true },
      summary: 'Fresh context resume',
      workspace_id: 'ws-1',
    });

    const values = poolQueryMock.mock.calls[0]?.[1] as unknown[];
    expect(String(values[1])).toMatch(/^Session \d{4}-/);
    expect(values).toEqual([
      'ws-1',
      expect.stringMatching(/^Session \d{4}-/),
      'Fresh context resume',
      JSON.stringify({ agent: 'codex', fresh: true }),
    ]);
  });

  it('rejects sessions that belong to a different requested workspace', async () => {
    const { getSession } = await import('./sessions.js');

    await expect(getSession('session-1', { workspace_id: 'ws-2' })).rejects.toThrow(
      'Session belongs to workspace ws-1, not ws-2'
    );

    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('touches session activity timestamps', async () => {
    poolQueryMock.mockResolvedValue({ rowCount: 1, rows: [] });
    const { touchSession } = await import('./sessions.js');
    await touchSession('session-2');
    expect(poolQueryMock).toHaveBeenCalledWith(expect.stringContaining('SET last_activity_at = NOW()'), ['session-2']);
    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain("status = 'active'");
  });

  it('does not touch activity when no session id is provided', async () => {
    const { touchSession } = await import('./sessions.js');

    await touchSession(null);
    await touchSession(undefined);

    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('touches session activity through a provided queryable', async () => {
    const queryable = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };

    const { touchSession } = await import('./sessions.js');
    await touchSession('session-2', queryable);

    expect(queryable.query).toHaveBeenCalledWith(expect.stringContaining('SET last_activity_at = NOW()'), ['session-2']);
    expect(String(queryable.query.mock.calls[0]?.[0])).toContain("status = 'active'");
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('returns null when a session cannot be loaded for resume', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });

    const { resumeSession } = await import('./sessions.js');
    await expect(resumeSession({ session_id: 'missing-session' })).resolves.toBeNull();

    expect(poolQueryMock).toHaveBeenCalledTimes(1);
  });

  it('builds resume bundles from session-scoped pages, runs, and search hits', async () => {
    poolQueryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT s.id') && sql.includes('page_count')) {
        return {
          rows: [{
            id: 'session-1',
            workspace_id: 'ws-1',
            title: 'Session title',
            summary: 'resume me',
            page_count: 1,
            run_count: 1,
          }],
        };
      }
      if (sql.includes('FROM pages p') && sql.includes('content_preview')) {
        return { rows: [{ id: 'page-1', title: 'Page', content_preview: 'hello', tags: [], importance: 0.5, parent_page_id: null, created_at: 'now', updated_at: 'now' }] };
      }
      if (sql.includes('FROM agent_runs r')) {
        return { rows: [{ id: 'run-1', workspace_id: 'ws-1', session_id: 'session-1', agent_name: 'agent', title: null, status: 'running', metadata: {}, result: {}, error_message: null, latest_checkpoint_sequence: 1, latest_checkpoint_at: 'now', started_at: 'now', finished_at: null, created_at: 'now', updated_at: 'now', latest_checkpoint: { id: 'cp-1', run_id: 'run-1', sequence: 1, summary: 'checkpoint', state: {}, metadata: {}, created_at: 'now' } }] };
      }
      if (sql.includes('ORDER BY score DESC')) {
        expect(values?.[0]).toBe('session-1');
        return { rows: [{ id: 'page-1', title: 'Page', score: 3, snippet: 'hello world', updated_at: 'now' }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { resumeSession } = await import('./sessions.js');
    const result = await resumeSession({ session_id: 'session-1', workspace_id: 'ws-1', max_items: 5 });

    expect(result?.truncated).toBe(false);
    expect(result?.session.id).toBe('session-1');
    expect(result?.recent_pages[0]?.id).toBe('page-1');
    expect(result?.recent_runs[0]?.latest_checkpoint?.id).toBe('cp-1');
    expect(result?.search_hits[0]?.id).toBe('page-1');

    const pageCall = poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('content_preview'));
    expect(String(pageCall?.[0])).toContain('p.archived_at IS NULL');
    expect(String(pageCall?.[0])).toContain('archived_at IS NULL');
    expect(pageCall?.[1]).toEqual(['session-1', 6]);
    const runCall = poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('FROM agent_runs r'));
    expect(String(runCall?.[0])).not.toMatch(/task_id|parent_run_id|SELECT r\.\*/);
    expect(runCall?.[1]).toEqual(['session-1', 6]);
    const searchCall = poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('ORDER BY score DESC'));
    expect(String(searchCall?.[0])).toContain('p.archived_at IS NULL');
    expect(String(searchCall?.[0])).toContain('b.archived_at IS NULL');
    expect(String(searchCall?.[0])).toContain('STRPOS(LOWER(p.title), LOWER($2)) > 0');
    expect(searchCall?.[1]).toEqual(['session-1', 'resume me', 6]);
  });

  it('reports omitted resume records per collection and marks the bundle truncated', async () => {
    poolQueryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT s.id') && sql.includes('page_count')) {
        return {
          rows: [{
            id: 'session-1',
            workspace_id: 'ws-1',
            title: 'Session title',
            summary: 'resume me',
            metadata: {},
            page_count: 3,
            run_count: 3,
          }],
        };
      }
      if (sql.includes('FROM pages p') && sql.includes('content_preview')) {
        expect(values).toEqual(['session-1', 3]);
        return {
          rows: Array.from({ length: 3 }, (_, index) => ({
            id: `page-${index + 1}`,
            title: `Page ${index + 1}`,
            content_preview: 'preview',
            tags: [],
            importance: 0.5,
            parent_page_id: null,
            created_at: 'now',
            updated_at: 'now',
          })),
        };
      }
      if (sql.includes('FROM agent_runs r')) {
        expect(values).toEqual(['session-1', 3]);
        return {
          rows: Array.from({ length: 3 }, (_, index) => ({
            id: `run-${index + 1}`,
            workspace_id: 'ws-1',
            session_id: 'session-1',
            agent_name: 'agent',
            title: null,
            status: 'running',
            metadata: {},
            result: {},
            error_message: null,
            latest_checkpoint_sequence: 0,
            latest_checkpoint_at: null,
            started_at: 'now',
            finished_at: null,
            created_at: 'now',
            updated_at: 'now',
            latest_checkpoint: null,
          })),
        };
      }
      if (sql.includes('ORDER BY score DESC')) {
        expect(values).toEqual(['session-1', 'resume me', 3]);
        return {
          rows: Array.from({ length: 3 }, (_, index) => ({
            id: `hit-${index + 1}`,
            title: `Hit ${index + 1}`,
            score: 3 - index,
            snippet: 'match',
            updated_at: 'now',
          })),
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { resumeSession } = await import('./sessions.js');
    const result = await resumeSession({ session_id: 'session-1', max_items: 2 });

    expect(result).toMatchObject({
      truncated: true,
      collection_status: {
        recent_pages: { complete: false, has_more: true, limit: 2, returned: 2 },
        recent_runs: { complete: false, has_more: true, limit: 2, returned: 2 },
        search_hits: { complete: false, has_more: true, limit: 2, returned: 2 },
      },
    });
    expect(result?.recent_pages).toHaveLength(2);
    expect(result?.recent_runs).toHaveLength(2);
    expect(result?.search_hits).toHaveLength(2);
  });

  it('skips resume search when both session summary and title are blank', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT s.id') && sql.includes('page_count')) {
        return {
          rows: [{
            id: 'session-1',
            workspace_id: 'ws-1',
            title: '   ',
            summary: '  ',
            page_count: 0,
            run_count: 0,
          }],
        };
      }
      if (sql.includes('FROM pages p') && sql.includes('content_preview')) {
        return { rows: [] };
      }
      if (sql.includes('FROM agent_runs r')) {
        return { rows: [] };
      }
      if (sql.includes('ORDER BY score DESC')) {
        throw new Error('search should not run for blank resume query');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { resumeSession } = await import('./sessions.js');
    const result = await resumeSession({ session_id: 'session-1' });

    expect(result?.truncated).toBe(false);
    expect(result?.search_hits).toEqual([]);
  });

  it('returns a stable direct shape and marks truncated page previews', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT s.id') && sql.includes('page_count')) {
        return {
          rows: [{
            id: 'session-1',
            workspace_id: 'ws-1',
            title: 'Session title',
            summary: 'resume me',
            page_count: 1,
            run_count: 0,
          }],
        };
      }
      if (sql.includes('FROM pages p') && sql.includes('content_preview')) {
        return { rows: [{ id: 'page-1', title: 'Page', content_preview: 'x'.repeat(5000), tags: [], importance: 0.5, parent_page_id: null, created_at: 'now', updated_at: 'now' }] };
      }
      if (sql.includes('FROM agent_runs r')) {
        return { rows: [] };
      }
      if (sql.includes('ORDER BY score DESC')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { resumeSession } = await import('./sessions.js');
    const result = await resumeSession({ session_id: 'session-1' });

    expect(result?.truncated).toBe(true);
    expect(result?.recent_pages[0]?.content_preview.length ?? 0).toBeLessThan(5000);
    expect(result).toEqual(expect.objectContaining({
      recent_pages: expect.any(Array),
      recent_runs: expect.any(Array),
      search_hits: expect.any(Array),
      session: expect.objectContaining({ id: 'session-1' }),
    }));
  });

  it('bounds checkpoint state and text in the stable resume result', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT s.id') && sql.includes('page_count')) {
        return {
          rows: [{
            id: 'session-1',
            workspace_id: 'ws-1',
            title: 'Session title',
            summary: 'resume me',
            metadata: {},
            page_count: 1,
            run_count: 1,
          }],
        };
      }
      if (sql.includes('FROM pages p') && sql.includes('content_preview')) {
        return { rows: [{ id: 'page-1', title: 'Page', content_preview: 'page '.repeat(800), tags: [], importance: 0.5, parent_page_id: null, created_at: 'now', updated_at: 'now' }] };
      }
      if (sql.includes('FROM agent_runs r')) {
        return {
          rows: [{
            id: 'run-1',
            workspace_id: 'ws-1',
            session_id: 'session-1',
            agent_name: 'agent',
            title: null,
            status: 'running',
            metadata: { verbose: 'run metadata should survive at run level' },
            result: {},
            error_message: null,
            latest_checkpoint_sequence: 3,
            latest_checkpoint_at: 'now',
            started_at: 'now',
            finished_at: null,
            created_at: 'now',
            updated_at: 'now',
            latest_checkpoint: {
              id: 'cp-1',
              run_id: 'run-1',
              sequence: 3,
              summary: 'checkpoint '.repeat(500),
              state: { large: 'x'.repeat(9_000) },
              metadata: { large: 'x'.repeat(5_000) },
              created_at: 'now',
            },
          }],
        };
      }
      if (sql.includes('ORDER BY score DESC')) {
        return { rows: [{ id: 'page-1', title: 'Page', score: 3, snippet: 'snippet '.repeat(500), updated_at: 'now' }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { resumeSession } = await import('./sessions.js');
    const result = await resumeSession({ session_id: 'session-1' });

    expect(result?.truncated).toBe(true);
    expect(result?.recent_runs[0]?.latest_checkpoint?.summary?.endsWith('...')).toBe(true);
    expect(result?.recent_runs[0]?.latest_checkpoint?.state).toEqual({ _truncated: true });
    expect(result?.recent_runs[0]?.latest_checkpoint?.metadata).toEqual({ _truncated: true });
    expect(result?.search_hits[0]?.snippet.endsWith('...')).toBe(true);
  });

  it('always returns session and bounded collections even with oversized page content', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT s.id') && sql.includes('page_count')) {
        return {
          rows: [{
            id: 'session-1',
            workspace_id: 'ws-1',
            title: 'Session title',
            summary: 'resume me',
            metadata: {},
            page_count: 1,
            run_count: 0,
          }],
        };
      }
      if (sql.includes('FROM pages p') && sql.includes('content_preview')) {
        return { rows: [{ id: 'page-1', title: 'page title '.repeat(1000), content_preview: 'content '.repeat(1000), tags: [], importance: 0.5, parent_page_id: null, created_at: 'now', updated_at: 'now' }] };
      }
      if (sql.includes('FROM agent_runs r')) {
        return { rows: [] };
      }
      if (sql.includes('ORDER BY score DESC')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { resumeSession } = await import('./sessions.js');
    const result = await resumeSession({ session_id: 'session-1' });

    expect(result?.session.id).toBe('session-1');
    expect(result?.recent_pages).toHaveLength(1);
    expect(result?.recent_pages[0]?.content_preview.endsWith('...')).toBe(true);
    expect(result?.recent_runs).toEqual([]);
    expect(result?.search_hits).toEqual([]);
    expect(result?.truncated).toBe(true);
  });

  it('bounds oversized session metadata without changing the result shape', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT s.id') && sql.includes('page_count')) {
        return {
          rows: [{
            id: 'session-1',
            workspace_id: 'ws-1',
            title: 'Session title',
            summary: 'resume me',
            metadata: { large: 'x'.repeat(5000) },
            page_count: 999,
            run_count: 999,
          }],
        };
      }
      if (sql.includes('FROM pages p') && sql.includes('content_preview')) {
        return { rows: [{ id: 'page-1', title: 'Page', content_preview: 'x'.repeat(5000), tags: [], importance: 0.5, parent_page_id: null, created_at: 'now', updated_at: 'now' }] };
      }
      if (sql.includes('FROM agent_runs r')) {
        return { rows: [] };
      }
      if (sql.includes('ORDER BY score DESC')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { resumeSession } = await import('./sessions.js');
    const result = await resumeSession({ session_id: 'session-1' });

    expect(result?.session.metadata).toEqual({ _truncated: true });
    expect(result?.recent_pages).toHaveLength(1);
    expect(result?.recent_runs).toEqual([]);
    expect(result?.search_hits).toEqual([]);
    expect(result?.truncated).toBe(true);
  });
});
