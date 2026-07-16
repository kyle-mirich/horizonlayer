import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const requireDatabaseMock = vi.fn();
const requireSessionMock = vi.fn();
const requireActiveWorkspaceMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({ query: poolQueryMock }),
}));

vi.mock('./scopeGuards.js', () => ({
  requireActiveWorkspace: requireActiveWorkspaceMock,
  requireDatabase: requireDatabaseMock,
  requireSession: requireSessionMock,
}));

function pageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'page-1',
    workspace_id: 'ws-1',
    session_id: 'session-1',
    title: 'Durable memory',
    tags: ['agent'],
    updated_at: '2026-01-02T00:00:00.000Z',
    score: 0.75,
    snippet: 'Page body',
    ...overrides,
  };
}

function rowResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    workspace_id: 'ws-1',
    database_id: 'db-1',
    title: 'Research item',
    tags: ['agent'],
    updated_at: '2026-01-03T00:00:00.000Z',
    score: 0.9,
    snippet: 'Row body',
    ...overrides,
  };
}

describe('native search SQL', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    requireDatabaseMock.mockReset().mockResolvedValue({
      workspace_id: 'ws-1',
      parent_page_id: null,
    });
    requireSessionMock.mockReset().mockResolvedValue({ workspace_id: 'ws-1' });
    requireActiveWorkspaceMock.mockReset().mockResolvedValue(undefined);
  });

  it('parameterizes workspace-scoped page and active-block FTS/trigram search', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [pageRow({ score: '0.75', snippet: null, tags: null })],
    });

    const { search } = await import('./search.js');
    await expect(search({
      query: '  durable agents  ',
      workspace_id: 'ws-1',
      content_types: ['pages'],
      session_id: 'session-1',
      tags: ['agent'],
      min_importance: 0.4,
      limit: 7,
    })).resolves.toEqual([
      {
        id: 'page-1',
        type: 'page',
        title: 'Durable memory',
        score: 0.75,
        snippet: 'Durable memory',
        workspace_id: 'ws-1',
        session_id: 'session-1',
        database_id: null,
        tags: [],
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ]);

    expect(requireActiveWorkspaceMock).toHaveBeenCalledWith('ws-1');
    expect(requireSessionMock).toHaveBeenCalledWith('session-1');
    const [sql, values] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('WITH page_documents AS');
    expect(sql).toContain('p.workspace_id = $1');
    expect(sql).toContain('p.archived_at IS NULL');
    expect(sql).toContain('b.archived_at IS NULL');
    expect(sql).toContain('p.session_id = $2');
    expect(sql).toContain('p.tags && $3');
    expect(sql).toContain('p.importance >= $4');
    expect(sql).toContain("to_tsvector('simple', title || ' ' || body)");
    expect(sql).toContain("websearch_to_tsquery('simple', $5)");
    expect(sql).toContain('similarity(title, $5)');
    expect(sql).toContain('STRPOS(LOWER(title), LOWER($5)) > 0');
    expect(sql).toContain('STRPOS(LOWER(body), LOWER($5)) > 0');
    expect(sql).toContain('LIMIT $6');
    expect(sql).not.toContain('durable agents');
    expect(sql).toContain('ts_rank_cd');
    expect(values).toEqual(['ws-1', 'session-1', ['agent'], 0.4, 'durable agents', 7]);
  });

  it('parameterizes database-scoped row search across active properties only', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [rowResult({ score: '0.9', title: null, snippet: null, tags: null })],
    });

    const { search } = await import('./search.js');
    await expect(search({
      query: 'research',
      workspace_id: 'ws-1',
      database_id: 'db-1',
      tags: ['agent'],
      min_importance: 0.2,
      limit: 8,
    })).resolves.toEqual([
      {
        id: 'row-1',
        type: 'row',
        title: '(untitled row)',
        score: 0.9,
        snippet: '',
        workspace_id: 'ws-1',
        session_id: null,
        database_id: 'db-1',
        tags: [],
        updated_at: '2026-01-03T00:00:00.000Z',
      },
    ]);

    expect(requireDatabaseMock).toHaveBeenCalledWith('db-1');
    expect(requireSessionMock).not.toHaveBeenCalled();
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    const [sql, values] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('WITH row_documents AS');
    expect(sql).toContain('d.workspace_id = $1');
    expect(sql).toContain('d.archived_at IS NULL');
    expect(sql).toContain('r.archived_at IS NULL');
    expect(sql).toContain('r.database_id = $2');
    expect(sql).toContain('r.tags && $3');
    expect(sql).toContain('r.importance >= $4');
    expect(sql).toContain('p.database_id = r.database_id');
    expect(sql).toContain('p.archived_at IS NULL');
    expect(sql).toContain('FILTER (WHERE p.id IS NOT NULL)');
    expect(sql).toContain("websearch_to_tsquery('simple', $5)");
    expect(sql).toContain('similarity(body, $5)');
    expect(sql).toContain('LIMIT $6');
    expect(sql).not.toContain('session_id');
    expect(sql).not.toContain('research');
    expect(sql).toContain('ts_rank_cd');
    expect(values).toEqual(['ws-1', 'db-1', ['agent'], 0.2, 'research', 8]);
  });

  it('searches both content types by default and globally normalizes, ranks, and limits results', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH page_documents AS')) {
        return { rows: [pageRow({ score: '0.8', updated_at: '2026-01-04T00:00:00.000Z' })] };
      }
      if (sql.includes('WITH row_documents AS')) {
        return { rows: [rowResult({ score: '0.8', updated_at: '2026-01-05T00:00:00.000Z' })] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const { search } = await import('./search.js');
    await expect(search({
      query: 'agent memory',
      workspace_id: 'ws-1',
      limit: 1,
    })).resolves.toEqual([
      expect.objectContaining({ id: 'row-1', type: 'row', score: 0.8 }),
    ]);

    expect(poolQueryMock).toHaveBeenCalledTimes(2);
    expect(poolQueryMock.mock.calls.map(([, values]) => values)).toEqual([
      ['ws-1', 'agent memory', 1],
      ['ws-1', 'agent memory', 1],
    ]);
  });

  it('deduplicates content type selectors instead of issuing duplicate SQL', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });

    const { search } = await import('./search.js');
    await search({
      query: 'memory',
      workspace_id: 'ws-1',
      content_types: ['pages', 'pages'],
    });

    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('WITH page_documents AS');
  });
});
