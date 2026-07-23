import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());

vi.mock('../client.js', () => ({
  getPool: () => ({ query }),
}));

import {
  archiveWorkspace,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  restoreWorkspace,
  updateWorkspace,
} from './workspaces.js';

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    name: 'Workspace',
    description: null,
    icon: null,
    revision: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('workspace query coverage cases', () => {
  beforeEach(() => query.mockReset());

  it('normalizes optional create fields and supports archived read controls', async () => {
    query
      .mockResolvedValueOnce({ rows: [workspace({ description: 'Description', icon: 'icon' })] })
      .mockResolvedValueOnce({ rows: [workspace({ archived_at: 'now', page_count: 0, database_count: 0, session_count: 0 })] });

    await expect(createWorkspace({ name: ' New ', description: ' Description ', icon: ' icon ' }))
      .resolves.toMatchObject({ name: 'Workspace' });
    await expect(getWorkspace('ws-1', { include_archived: true })).resolves.toMatchObject({ archived_at: 'now' });
    expect(query.mock.calls[0]?.[1]).toEqual(['New', 'Description', 'icon']);
    expect(query.mock.calls[1]?.[1]).toEqual(['ws-1', true]);
  });

  it('updates all mutable fields, validates input, and detects a stale revision after the write misses', async () => {
    query.mockResolvedValueOnce({ rows: [workspace({ revision: 2 })] });
    await expect(updateWorkspace('ws-1', {
      revision: 1, name: ' Renamed ', description: ' ', icon: ' icon ',
    })).resolves.toMatchObject({ revision: 2 });
    expect(query.mock.calls[0]?.[1]).toEqual(['Renamed', null, 'icon', 'ws-1', 1]);

    await expect(updateWorkspace('ws-1', { revision: 1 })).rejects.toThrow('At least one workspace field');
    await expect(updateWorkspace('ws-1', { revision: 1, name: ' ' })).rejects.toThrow('cannot be empty');

    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql === undefined) return { rows: [] };
      if (String(sql).includes('UPDATE workspaces')) return { rows: [] };
      if (sql === 'SELECT revision FROM workspaces WHERE id = $1') return { rows: [{ revision: 2 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(updateWorkspace('ws-1', { revision: 1, icon: 'new' }))
      .rejects.toThrow('workspace ws-1 is at revision 2, not 1');
  });

  it('returns null for absent workspace reads and identifies duplicate archive lifecycle requests', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(getWorkspace('missing')).resolves.toBeNull();

    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql === undefined) return { rows: [] };
      if (String(sql).includes('UPDATE workspaces')) return { rows: [] };
      if (String(sql).includes('SELECT revision, archived_at')) return { rows: [{ revision: 1, archived_at: 'now' }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveWorkspace('ws-1', 1)).rejects.toThrow('workspace ws-1 is already archived');

    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql === undefined) return { rows: [] };
      if (String(sql).includes('UPDATE workspaces')) return { rows: [] };
      if (String(sql).includes('SELECT revision, archived_at')) return { rows: [{ revision: 1, archived_at: null }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(restoreWorkspace('ws-1', 1)).rejects.toThrow('workspace ws-1 is already restored');
  });

  it('uses bounded pagination with include-archived list scopes', async () => {
    query.mockResolvedValue({ rows: [workspace()] });
    await expect(listWorkspaces({ include_archived: true, limit: 101, offset: 1_000_000 })).resolves.toHaveLength(1);
    expect(query.mock.calls[0]?.[1]).toEqual([true, 101, 1_000_000]);
    await expect(listWorkspaces({ offset: -1 })).rejects.toThrow('Pagination value must be an integer');
  });
});
