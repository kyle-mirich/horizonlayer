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

const workspaceScope = {
  kind: 'workspace' as const,
  workspace_id: 'ws-1',
  types: ['page' as const],
  session_id: null,
  database_id: null,
};

describe('canonical record search contract', () => {
  beforeEach(() => {
    poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
    requireSessionMock.mockReset().mockResolvedValue({ workspace_id: 'ws-1' });
    requireActiveWorkspaceMock.mockReset().mockResolvedValue(undefined);
  });

  it('validates direct-call bounds before search SQL', async () => {
    const { searchRecords } = await import('./search.js');

    await expect(searchRecords({ query: '   ', scope: workspaceScope })).rejects.toThrow(
      'query cannot be empty'
    );
    await expect(searchRecords({ query: 'x'.repeat(1_001), scope: workspaceScope })).rejects.toThrow(
      'query cannot exceed 1000 characters'
    );
    await expect(searchRecords({ query: 'memory', scope: workspaceScope, limit: 0 })).rejects.toThrow(
      'limit must be an integer between 1 and 50'
    );
    await expect(searchRecords({ query: 'memory', scope: workspaceScope, limit: 51 })).rejects.toThrow(
      'limit must be an integer between 1 and 50'
    );
    await expect(searchRecords({ query: 'memory', scope: workspaceScope, limit: 1.5 })).rejects.toThrow(
      'limit must be an integer between 1 and 50'
    );
    await expect(searchRecords({
      query: 'memory', scope: workspaceScope, min_importance: Number.NaN,
    })).rejects.toThrow('min_importance must be a number between 0 and 1');
    await expect(searchRecords({
      query: 'memory', scope: workspaceScope, min_importance: 1.01,
    })).rejects.toThrow('min_importance must be a number between 0 and 1');

    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('accepts trimmed queries and inclusive upper bounds with lookahead', async () => {
    const query = 'x'.repeat(1_000);
    const { searchRecords } = await import('./search.js');

    await expect(searchRecords({
      query: ` ${query} `,
      scope: workspaceScope,
      min_importance: 1,
      limit: 50,
    })).resolves.toEqual({ records: [], truncated: false });

    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual(['ws-1', 1, query, 500, 51]);
  });

  it('rejects invalid direct workspace scope selectors before access', async () => {
    const { resolveSearchScope } = await import('./search.js');

    await expect(resolveSearchScope({
      kind: 'workspace', workspace_id: 'ws-1', types: [],
    })).rejects.toThrow('Workspace search types must contain at least one item');
    await expect(resolveSearchScope({
      kind: 'workspace', workspace_id: 'ws-1', types: ['vector' as never],
    })).rejects.toThrow('Workspace search types may only contain page or row');
    await expect(resolveSearchScope({ kind: 'unsupported' } as never)).rejects.toThrow(
      'Unsupported search scope: unsupported'
    );

    expect(requireActiveWorkspaceMock).not.toHaveBeenCalled();
    expect(requireSessionMock).not.toHaveBeenCalled();
  });

  it('rejects archived or missing database scopes before record search', async () => {
    const { resolveSearchScope } = await import('./search.js');
    poolQueryMock.mockResolvedValueOnce({ rows: [] });

    await expect(resolveSearchScope({ kind: 'database', database_id: 'db-1' })).rejects.toThrow(
      'Database db-1 not found'
    );

    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('d.archived_at IS NULL');
    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('w.archived_at IS NULL');
  });
});
