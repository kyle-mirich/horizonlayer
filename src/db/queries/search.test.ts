import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const assertSessionReadAccessMock = vi.fn();
const embedMock = vi.fn();
const vectorToSqlMock = vi.fn();

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

describe('search query layer', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    assertSessionReadAccessMock.mockReset().mockResolvedValue({ workspace_id: 'ws-1' });
    embedMock.mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
    vectorToSqlMock.mockReset().mockReturnValue('[0.1,0.2,0.3]');
  });

  it('returns no row hits when session scope is requested', async () => {
    const { search } = await import('./search.js');
    const results = await search({
      query: 'term',
      mode: 'grep',
      content_types: ['rows'],
      session_id: 'session-1',
    });

    expect(results).toEqual([]);
    expect(assertSessionReadAccessMock).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('scopes page search to the requested session', async () => {
    poolQueryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      expect(sql).toContain('p.session_id = $1');
      expect(values?.[0]).toBe('session-1');
      return {
        rows: [{
          id: 'page-1',
          score: 1,
          snippet: 'hit',
          tags: [],
          title: 'Page',
          workspace_id: 'ws-1',
        }],
      };
    });

    const { search } = await import('./search.js');
    const results = await search({
      query: 'term',
      mode: 'grep',
      content_types: ['pages'],
      session_id: 'session-1',
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('page-1');
  });

  it('searches page blocks in full_text mode', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      expect(sql).toContain("to_tsvector('english', b.content)");
      expect(sql).toContain("plainto_tsquery('english'");
      return {
        rows: [{
          id: 'page-1',
          score: 2,
          snippet: 'block hit',
          tags: [],
          title: 'Page',
          workspace_id: 'ws-1',
        }],
      };
    });

    const { search } = await import('./search.js');
    const results = await search({
      query: 'term',
      mode: 'full_text',
      content_types: ['pages'],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.snippet).toBe('block hit');
  });

  it('returns row hits in full_text mode', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      expect(sql).toContain('FROM database_rows r');
      expect(sql).toContain("to_tsvector('english', COALESCE(v.value_text");
      return {
        rows: [{
          database_id: 'db-1',
          id: 'row-1',
          score: 1,
          snippet: 'row hit',
          tags: [],
          title: 'Row',
          workspace_id: 'ws-1',
        }],
      };
    });

    const { search } = await import('./search.js');
    const results = await search({
      query: 'term',
      mode: 'full_text',
      content_types: ['rows'],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('row-1');
  });

  it('adds keyword scoring to row hybrid mode', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      expect(sql).toContain('FROM database_rows r');
      expect(sql).toContain("ts_rank(to_tsvector('english', COALESCE(v_score.value_text");
      expect(sql).toContain("plainto_tsquery('english'");
      return {
        rows: [{
          database_id: 'db-1',
          id: 'row-1',
          score: 1,
          snippet: 'row hit',
          tags: [],
          title: 'Row',
          workspace_id: 'ws-1',
        }],
      };
    });

    const { search } = await import('./search.js');
    const results = await search({
      query: 'term',
      mode: 'hybrid',
      content_types: ['rows'],
    });

    expect(embedMock).toHaveBeenCalledWith('term');
    expect(vectorToSqlMock).toHaveBeenCalledWith([0.1, 0.2, 0.3]);
    expect(results).toHaveLength(1);
  });
});
