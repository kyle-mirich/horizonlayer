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

describe('native search contract', () => {
  beforeEach(() => {
    poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
    requireDatabaseMock.mockReset().mockResolvedValue({
      workspace_id: 'ws-1',
      parent_page_id: null,
    });
    requireSessionMock.mockReset().mockResolvedValue({ workspace_id: 'ws-1' });
    requireActiveWorkspaceMock.mockReset().mockResolvedValue(undefined);
  });

  it('rejects a session outside the required workspace before search SQL', async () => {
    requireSessionMock.mockResolvedValueOnce({ workspace_id: 'ws-2' });

    const { search } = await import('./search.js');
    await expect(search({
      query: 'memory',
      workspace_id: 'ws-1',
      session_id: 'session-1',
    })).rejects.toThrow('session_id must belong to the requested workspace');

    expect(requireActiveWorkspaceMock).toHaveBeenCalledWith('ws-1');
    expect(requireSessionMock).toHaveBeenCalledWith('session-1');
    expect(requireDatabaseMock).not.toHaveBeenCalled();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('rejects a database outside the required workspace before search SQL', async () => {
    requireDatabaseMock.mockResolvedValueOnce({
      workspace_id: 'ws-2',
      parent_page_id: null,
    });

    const { search } = await import('./search.js');
    await expect(search({
      query: 'memory',
      workspace_id: 'ws-1',
      database_id: 'db-1',
    })).rejects.toThrow('database_id must belong to the requested workspace');

    expect(requireDatabaseMock).toHaveBeenCalledWith('db-1');
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('validates all direct-call input bounds before access or SQL', async () => {
    const { search } = await import('./search.js');

    await expect(
      // @ts-expect-error workspace_id is required by the public query contract.
      search({ query: 'memory' })
    ).rejects.toThrow('workspace_id is required');
    await expect(search({ query: '   ', workspace_id: 'ws-1' })).rejects.toThrow('query cannot be empty');
    await expect(search({ query: 'x'.repeat(1_001), workspace_id: 'ws-1' })).rejects.toThrow(
      'query cannot exceed 1000 characters'
    );
    await expect(search({ query: 'memory', workspace_id: 'ws-1', limit: 0 })).rejects.toThrow(
      'limit must be an integer between 1 and 100'
    );
    await expect(search({ query: 'memory', workspace_id: 'ws-1', limit: 101 })).rejects.toThrow(
      'limit must be an integer between 1 and 100'
    );
    await expect(search({ query: 'memory', workspace_id: 'ws-1', limit: 1.5 })).rejects.toThrow(
      'limit must be an integer between 1 and 100'
    );
    await expect(search({ query: 'memory', workspace_id: 'ws-1', min_importance: -0.01 })).rejects.toThrow(
      'min_importance must be a number between 0 and 1'
    );
    await expect(search({ query: 'memory', workspace_id: 'ws-1', min_importance: 1.01 })).rejects.toThrow(
      'min_importance must be a number between 0 and 1'
    );
    await expect(search({ query: 'memory', workspace_id: 'ws-1', min_importance: Number.NaN })).rejects.toThrow(
      'min_importance must be a number between 0 and 1'
    );
    await expect(search({ query: 'memory', workspace_id: 'ws-1', content_types: [] })).rejects.toThrow(
      'content_types must contain at least one item'
    );
    await expect(search({
      query: 'memory',
      workspace_id: 'ws-1',
      content_types: ['vectors'],
    } as never)).rejects.toThrow('content_types may only contain pages or rows');

    expect(requireActiveWorkspaceMock).not.toHaveBeenCalled();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('accepts trimmed queries and inclusive upper bounds', async () => {
    const query = 'x'.repeat(1_000);
    const { search } = await import('./search.js');

    await expect(search({
      query: ` ${query} `,
      workspace_id: 'ws-1',
      content_types: ['pages'],
      min_importance: 1,
      limit: 100,
    })).resolves.toEqual([]);

    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual(['ws-1', 1, query, 100]);
  });

  it('uses the matching content type when a scope filter omits content_types', async () => {
    const { search } = await import('./search.js');

    await expect(search({
      query: 'memory',
      workspace_id: 'ws-1',
      database_id: 'db-1',
    })).resolves.toEqual([]);

    expect(requireDatabaseMock).toHaveBeenCalledWith('db-1');
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('WITH row_documents AS');

    poolQueryMock.mockClear();
    await expect(search({
      query: 'memory',
      workspace_id: 'ws-1',
      session_id: 'session-1',
    })).resolves.toEqual([]);

    expect(requireSessionMock).toHaveBeenCalledWith('session-1');
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('WITH page_documents AS');
  });

  it('rejects mixed or incompatible scoped content types before access or SQL', async () => {
    const { search } = await import('./search.js');

    await expect(search({
      query: 'memory',
      workspace_id: 'ws-1',
      session_id: 'session-1',
      content_types: ['pages', 'rows'],
    })).rejects.toThrow('session_id can only be used with page search');
    await expect(search({
      query: 'memory',
      workspace_id: 'ws-1',
      database_id: 'db-1',
      content_types: ['pages'],
    })).rejects.toThrow('database_id can only be used with row search');
    await expect(search({
      query: 'memory',
      workspace_id: 'ws-1',
      session_id: 'session-1',
      database_id: 'db-1',
    })).rejects.toThrow('session_id and database_id cannot be combined');

    expect(requireActiveWorkspaceMock).not.toHaveBeenCalled();
    expect(requireSessionMock).not.toHaveBeenCalled();
    expect(requireDatabaseMock).not.toHaveBeenCalled();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

});
