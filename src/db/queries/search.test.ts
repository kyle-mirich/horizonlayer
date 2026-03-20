import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const assertSessionReadAccessMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    query: poolQueryMock,
  }),
}));

vi.mock('../../embeddings/index.js', () => ({
  embed: vi.fn(),
  vectorToSql: vi.fn(),
}));

vi.mock('./accessControl.js', () => ({
  assertSessionReadAccess: assertSessionReadAccessMock,
}));

describe('search query layer', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    assertSessionReadAccessMock.mockReset().mockResolvedValue({ workspace_id: 'ws-1' });
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
});
