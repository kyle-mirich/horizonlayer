import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const requireSessionMock = vi.fn();
const requireActiveWorkspaceMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({ query: poolQueryMock }),
}));

vi.mock('./scopeGuards.js', () => ({
  requireActiveWorkspace: requireActiveWorkspaceMock,
  requireSession: requireSessionMock,
}));

function pageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'page-1',
    workspace_id: 'ws-1',
    session_id: 'session-1',
    parent_page_id: 'parent-1',
    title: 'Durable memory',
    tags: ['agent'],
    importance: 0.7,
    revision: 3,
    created_at: '2026-01-01T00:00:00.000Z',
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
    importance: 0.8,
    revision: 4,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-03T00:00:00.000Z',
    score: 0.9,
    snippet: 'Row body',
    ...overrides,
  };
}

describe('canonical record search SQL', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    requireSessionMock.mockReset().mockResolvedValue({ workspace_id: 'ws-1' });
    requireActiveWorkspaceMock.mockReset().mockResolvedValue(undefined);
  });

  it('resolves strict workspace, session, and database scopes', async () => {
    const { resolveSearchScope } = await import('./search.js');

    await expect(resolveSearchScope({
      kind: 'workspace',
      workspace_id: 'ws-1',
      types: ['row', 'page', 'row'],
    })).resolves.toEqual({
      kind: 'workspace',
      workspace_id: 'ws-1',
      types: ['row', 'page'],
      session_id: null,
      database_id: null,
    });
    await expect(resolveSearchScope({ kind: 'session', session_id: 'session-1' })).resolves.toEqual({
      kind: 'session',
      workspace_id: 'ws-1',
      types: ['page'],
      session_id: 'session-1',
      database_id: null,
    });
    poolQueryMock.mockResolvedValueOnce({ rows: [{ workspace_id: 'ws-1' }] });
    await expect(resolveSearchScope({ kind: 'database', database_id: 'db-1' })).resolves.toEqual({
      kind: 'database',
      workspace_id: 'ws-1',
      types: ['row'],
      session_id: null,
      database_id: 'db-1',
    });

    expect(requireActiveWorkspaceMock).toHaveBeenCalledWith('ws-1');
    expect(requireSessionMock).toHaveBeenCalledWith('session-1');
    expect(poolQueryMock.mock.calls[0]?.[0]).toContain('d.archived_at IS NULL');
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual(['db-1']);
  });

  it('parameterizes session-scoped page search and returns canonical summaries', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [pageRow({ score: '0.75', snippet: null, tags: null })],
    });

    const { searchRecords } = await import('./search.js');
    await expect(searchRecords({
      query: '  durable agents  ',
      scope: {
        kind: 'session', workspace_id: 'ws-1', types: ['page'],
        session_id: 'session-1', database_id: null,
      },
      tags: ['agent'],
      min_importance: 0.4,
      limit: 7,
    })).resolves.toEqual({
      records: [{
        id: 'page-1',
        type: 'page',
        title: 'Durable memory',
        score: 0.75,
        snippet: 'Durable memory',
        workspace_id: 'ws-1',
        session_id: 'session-1',
        parent_page_id: 'parent-1',
        database_id: null,
        tags: [],
        importance: 0.7,
        revision: 3,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      }],
      truncated: false,
    });

    const [sql, values] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('WITH candidate_matches AS MATERIALIZED');
    expect(sql).toContain("to_tsvector('simple', p.title)");
    expect(sql).toContain('p.title % $5');
    expect(sql).toContain('FROM blocks b');
    expect(sql).toContain('b.content % $5');
    expect(sql).toContain('FROM candidates c');
    expect(sql).toContain('JOIN pages p ON p.id = c.id');
    expect(sql).toContain('p.id = CASE');
    expect(sql).toContain('LEFT(c.snippet, 400) AS snippet');
    expect(sql).not.toContain('string_agg');
    expect(sql).toContain('p.workspace_id = $1');
    expect(sql).toContain('p.archived_at IS NULL');
    expect(sql).toContain('w.id = p.workspace_id');
    expect(sql).toContain('w.archived_at IS NULL');
    expect(sql).toContain('b.archived_at IS NULL');
    expect(sql).toContain('p.session_id = $2');
    expect(sql).toContain('p.tags && $3');
    expect(sql).toContain('p.importance >= $4');
    expect(sql).toContain("websearch_to_tsquery('simple', $5)");
    expect(sql).toContain('LIMIT $6');
    expect(sql).toContain('LIMIT $7');
    expect(sql).not.toContain('durable agents');
    expect(values).toEqual(['ws-1', 'session-1', ['agent'], 0.4, 'durable agents', 80, 8]);
  });

  it('parameterizes database-scoped row search across active properties', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [rowResult({ score: '0.9', title: null, snippet: null, tags: null })],
    });

    const { searchRecords } = await import('./search.js');
    await expect(searchRecords({
      query: 'research',
      scope: {
        kind: 'database', workspace_id: 'ws-1', types: ['row'],
        session_id: null, database_id: 'db-1',
      },
      tags: ['agent'],
      min_importance: 0.2,
      limit: 8,
    })).resolves.toEqual({
      records: [expect.objectContaining({
        id: 'row-1',
        type: 'row',
        title: '(untitled row)',
        snippet: '',
        revision: 4,
        database_id: 'db-1',
        parent_page_id: null,
      })],
      truncated: false,
    });

    const [sql, values] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('WITH candidate_matches AS MATERIALIZED');
    expect(sql).toContain('FROM database_row_values v');
    expect(sql).toContain('database_row_value_search_text(');
    expect(sql).toContain('v.value_date');
    expect(sql).toContain('v.value_text % $5');
    expect(sql).toContain("to_tsvector('simple', p.name)");
    expect(sql).toContain('p.name % $5');
    expect(sql).toContain('FROM database_properties p');
    expect(sql).toContain('JOIN database_row_values v ON v.property_id = p.id');
    expect(sql).toContain('FROM candidates c');
    expect(sql).toContain('JOIN database_rows r ON r.id = c.id');
    expect(sql).toContain('r.id = CASE');
    expect(sql).toContain('LEFT(c.snippet, 400) AS snippet');
    expect(sql).not.toContain('string_agg');
    expect(sql).toContain('d.workspace_id = $1');
    expect(sql).toContain('d.archived_at IS NULL');
    expect(sql).toContain('w.id = d.workspace_id');
    expect(sql).toContain('w.archived_at IS NULL');
    expect(sql).toContain('r.archived_at IS NULL');
    expect(sql).toContain('r.database_id = $2');
    expect(sql).toContain('p.database_id = r.database_id');
    expect(sql).toContain('p.archived_at IS NULL');
    expect(sql).toContain("websearch_to_tsquery('simple', $5)");
    expect(sql).not.toContain('session_id');
    expect(values).toEqual(['ws-1', 'db-1', ['agent'], 0.2, 'research', 90, 9]);
  });

  it('merges both record types, globally ranks them, and reports lookahead truncation', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('JOIN pages p ON p.id = c.id')) {
        return {
          rows: [pageRow({
            score: '0.8',
            created_at: new Date('2026-01-01T00:00:00.000Z'),
            updated_at: new Date('2026-01-04T00:00:00.000Z'),
          })],
        };
      }
      if (sql.includes('JOIN database_rows r ON r.id = c.id')) {
        return {
          rows: [rowResult({
            score: '0.8',
            created_at: new Date('2026-01-01T00:00:00.000Z'),
            updated_at: new Date('2026-01-05T00:00:00.000Z'),
          })],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const { searchRecords } = await import('./search.js');
    await expect(searchRecords({
      query: 'agent memory',
      scope: {
        kind: 'workspace', workspace_id: 'ws-1', types: ['page', 'row'],
        session_id: null, database_id: null,
      },
      limit: 1,
    })).resolves.toEqual({
      records: [expect.objectContaining({
        id: 'row-1',
        type: 'row',
        score: 0.8,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-05T00:00:00.000Z',
      })],
      truncated: true,
    });

    expect(poolQueryMock).toHaveBeenCalledTimes(2);
    expect(poolQueryMock.mock.calls.map(([, values]) => values)).toEqual([
      ['ws-1', 'agent memory', 50, 2],
      ['ws-1', 'agent memory', 50, 2],
    ]);
  });
});
