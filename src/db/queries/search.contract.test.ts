import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const embedMock = vi.fn();
const vectorToSqlMock = vi.fn();
const assertSessionReadAccessMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    query: poolQueryMock,
  }),
}));

vi.mock('../../embeddings/index.js', () => ({
  embed: embedMock,
  vectorToSql: vectorToSqlMock,
}));

vi.mock('./accessControl.js', () => ({
  assertSessionReadAccess: assertSessionReadAccessMock,
}));

function mockSearchRows() {
  poolQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM pages p')) {
      return {
        rows: [
          {
            id: 'page-1',
            title: 'Page hit',
            workspace_id: 'ws-1',
            tags: ['tag'],
            score: 0.8,
            snippet: 'Page snippet with many words '.repeat(20),
          },
        ],
      };
    }
    if (sql.includes('FROM database_rows r')) {
      return {
        rows: [
          {
            id: 'row-1',
            database_id: 'db-1',
            workspace_id: 'ws-1',
            tags: ['tag'],
            score: 0.9,
            title: null,
            snippet: null,
          },
        ],
      };
    }
    throw new Error(`Unexpected search SQL: ${sql}`);
  });
}

describe('search query modes', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    embedMock.mockReset();
    vectorToSqlMock.mockReset();
    assertSessionReadAccessMock.mockReset();
    embedMock.mockResolvedValue([0.1, 0.2, 0.3]);
    vectorToSqlMock.mockReturnValue('[0.1,0.2,0.3]');
    assertSessionReadAccessMock.mockResolvedValue({ workspace_id: 'ws-1' });
    mockSearchRows();
  });

  it.each(['full_text', 'grep', 'regex'] as const)('searches pages and rows in %s mode without embeddings', async (mode) => {
    const { search } = await import('./search.js');
    const results = await search({
      query: mode === 'regex' ? 'Page|Row' : 'Page',
      mode,
      workspace_id: 'ws-1',
      session_id: 'session-1',
      tags: ['tag'],
      min_importance: 0.2,
      limit: 5,
    });

    expect(results.map((item) => item.type)).toEqual(['row', 'page']);
    expect(results[1]?.snippet.length).toBeLessThanOrEqual(201);
    expect(embedMock).not.toHaveBeenCalled();
    expect(assertSessionReadAccessMock).toHaveBeenCalledWith('session-1', { kind: 'system' });
  });

  it.each(['similarity', 'similarity_recency', 'similarity_importance', 'hybrid'] as const)(
    'searches vector-backed pages and rows in %s mode',
    async (mode) => {
      const { search } = await import('./search.js');
      const results = await search({
        query: 'semantic memory',
        mode,
        content_types: ['pages', 'rows'],
        workspace_id: 'ws-1',
        tags: ['tag'],
        min_importance: 0.1,
        limit: 2,
      });

      expect(results).toHaveLength(2);
      expect(embedMock).toHaveBeenCalledWith('semantic memory');
      expect(vectorToSqlMock).toHaveBeenCalledWith([0.1, 0.2, 0.3]);
    }
  );

  it('skips page search when database_id scopes results to rows', async () => {
    const { search } = await import('./search.js');
    const results = await search({
      query: 'row only',
      mode: 'grep',
      content_types: ['pages', 'rows'],
      database_id: 'db-1',
      limit: 5,
    });

    expect(results).toEqual([
      {
        id: 'row-1',
        type: 'row',
        title: '(untitled row)',
        score: 0.9,
        snippet: '',
        workspace_id: 'ws-1',
        tags: ['tag'],
      },
    ]);
    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('FROM database_rows r');
  });

  it('rejects invalid and oversized regex queries before SQL execution', async () => {
    const { search } = await import('./search.js');

    await expect(search({ query: '[', mode: 'regex' })).rejects.toThrow('Invalid regex query');
    await expect(search({ query: 'a'.repeat(513), mode: 'regex' })).rejects.toThrow('Regex query cannot exceed 512 characters');
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('rejects sessions outside the requested workspace', async () => {
    assertSessionReadAccessMock.mockResolvedValueOnce({ workspace_id: 'other-ws' });
    const { search } = await import('./search.js');

    await expect(search({
      query: 'memory',
      mode: 'grep',
      workspace_id: 'ws-1',
      session_id: 'session-1',
    })).rejects.toThrow('session_id must belong to the requested workspace');
  });
});
