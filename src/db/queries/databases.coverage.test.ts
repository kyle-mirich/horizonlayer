import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  connect: vi.fn(),
  lockActivePageForChildWrite: vi.fn(),
  poolQuery: vi.fn(),
  release: vi.fn(),
  requireActivePage: vi.fn(),
  requireActiveWorkspace: vi.fn(),
  requireDatabase: vi.fn(),
}));

vi.mock('../client.js', () => ({
  getPool: () => ({ connect: mocks.connect, query: mocks.poolQuery }),
}));

vi.mock('./scopeGuards.js', () => ({
  lockActivePageForChildWrite: mocks.lockActivePageForChildWrite,
  requireActivePage: mocks.requireActivePage,
  requireActiveWorkspace: mocks.requireActiveWorkspace,
  requireDatabase: mocks.requireDatabase,
}));

import {
  addDatabaseProperty,
  archiveDatabase,
  archiveDatabaseProperty,
  createDatabase,
  getDatabase,
  listDatabases,
  normalizePropertyOptions,
  restoreDatabase,
  restoreDatabaseProperty,
  updateDatabase,
  updateDatabaseProperty,
} from './databases.js';

function database(overrides: Record<string, unknown> = {}) {
  return {
    id: 'db-1',
    workspace_id: 'ws-1',
    parent_page_id: null,
    name: 'Projects',
    description: null,
    tags: [],
    revision: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function property(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prop-1',
    database_id: 'db-1',
    name: 'Status',
    property_type: 'select',
    options: { choices: ['Open', 'Closed'] },
    position: 1,
    revision: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function setClientHandler(handler: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>) {
  mocks.clientQuery.mockImplementation(handler);
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
}

describe('database query coverage cases', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
    mocks.lockActivePageForChildWrite.mockResolvedValue({ workspace_id: 'ws-1' });
    mocks.requireActivePage.mockResolvedValue({ workspace_id: 'ws-1' });
    mocks.requireActiveWorkspace.mockResolvedValue(undefined);
    mocks.requireDatabase.mockResolvedValue({ workspace_id: 'ws-1', parent_page_id: null });
  });

  it('strictly normalizes choices and rejects unsupported option shapes', () => {
    expect(normalizePropertyOptions('select', { choices: [' Open ', 'Closed'] })).toEqual({
      choices: ['Open', 'Closed'],
    });
    expect(normalizePropertyOptions('multi_select', {})).toEqual({});
    expect(normalizePropertyOptions('text', {})).toEqual({});
    expect(() => normalizePropertyOptions('select', null)).toThrow('must be an object');
    expect(() => normalizePropertyOptions('select', { values: [] })).toThrow('exactly { choices: string[] }');
    expect(() => normalizePropertyOptions('select', { choices: Array.from({ length: 101 }, () => 'x') }))
      .toThrow('cannot exceed 100');
    expect(() => normalizePropertyOptions('select', { choices: [''] })).toThrow('must be non-empty strings');
    expect(() => normalizePropertyOptions('select', { choices: ['Open', ' open '] })).toThrow('Duplicate property choice');
    expect(() => normalizePropertyOptions('text', { choices: ['Open'] })).toThrow('does not accept options');
  });

  it('creates a collision-free default title and rolls back post-lock validation failures', async () => {
    let insertCount = 0;
    setClientHandler(async (sql, values) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('INSERT INTO databases')) return { rows: [database()] };
      if (sql.includes('INSERT INTO database_properties')) {
        insertCount += 1;
        return { rows: [property({ id: `prop-${insertCount}`, name: values?.[1], property_type: values?.[2] })] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(createDatabase({
      workspace_id: 'ws-1',
      name: ' New ',
      description: '  ',
      properties: [{ name: ' Title ', property_type: 'text' }],
    })).resolves.toMatchObject({ properties: [{ name: 'Title 2' }, { name: 'Title' }] });
    const inserts = mocks.clientQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO database_properties'));
    expect(inserts.map(([, values]) => values?.[1])).toEqual(['Title 2', 'Title']);
    expect(mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO databases'))?.[1])
      .toEqual(['ws-1', null, 'New', null, []]);

    mocks.clientQuery.mockReset();
    mocks.lockActivePageForChildWrite.mockResolvedValueOnce({ workspace_id: 'other-workspace' });
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(createDatabase({
      workspace_id: 'ws-1', name: 'Bad parent', parent_page_id: 'page-1',
    })).rejects.toThrow('workspace_id must match the parent page workspace');
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('returns null for missing reads and applies all mutable database fields in one update', async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [database({ revision: 2, name: 'Renamed', description: null, tags: ['a'] })] });

    await expect(getDatabase('missing')).resolves.toBeNull();
    await expect(updateDatabase('db-1', {
      revision: 1,
      name: ' Renamed ',
      description: '  ',
      tags: ['a'],
    })).resolves.toMatchObject({ revision: 2, name: 'Renamed' });
    expect(mocks.poolQuery.mock.calls[1]?.[1]).toEqual(['Renamed', null, ['a'], 'db-1', 1]);
    await expect(updateDatabase('db-1', { revision: 1 })).rejects.toThrow('At least one database field');
  });

  it('lists default tag scopes and distinguishes already-archived and already-restored transitions', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [database()] });
    await expect(listDatabases({ workspace_id: 'ws-1', tags: [] })).resolves.toHaveLength(1);
    expect(mocks.poolQuery.mock.calls[0]?.[1]).toEqual(['ws-1', false, null, 50, 0]);

    mocks.poolQuery.mockReset();
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE databases')) return { rows: [] };
      if (sql.includes('SELECT revision, archived_at')) return { rows: [{ revision: 1, archived_at: '2026-01-02' }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveDatabase('db-1', 1)).rejects.toThrow('database db-1 is already archived');

    mocks.poolQuery.mockReset();
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE databases')) return { rows: [] };
      if (sql.includes('SELECT revision, archived_at')) return { rows: [{ revision: 1, archived_at: null }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(restoreDatabase('db-1', 1)).rejects.toThrow('database db-1 is already restored');
  });

  it('validates update and pagination arguments and reports a lost update revision', async () => {
    await expect(listDatabases({ workspace_id: 'ws-1', limit: 102 })).rejects.toThrow('between 0 and 101');
    await expect(updateDatabase('db-1', { revision: 0, name: 'No' })).rejects.toThrow('positive integer');
    await expect(updateDatabase('db-1', { revision: 1, name: '   ' })).rejects.toThrow('cannot be empty');

    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE databases')) return { rows: [] };
      if (sql === 'SELECT revision FROM databases WHERE id = $1') return { rows: [{ revision: 2 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(updateDatabase('db-1', { revision: 1, name: 'Renamed' }))
      .rejects.toThrow('database db-1 is at revision 2, not 1');
  });

  it('adds a property at the next position and rejects duplicate active names', async () => {
    setClientHandler(async (sql, values) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('UPDATE databases') && sql.includes('RETURNING id, revision')) return { rows: [{ id: 'db-1', revision: 2 }] };
      if (sql.includes('LOWER(BTRIM(name))')) return { rows: [] };
      if (sql.includes('COUNT(*)::int')) return { rows: [{ count: 2 }] };
      if (sql.includes('SELECT MAX(position)')) return { rows: [{ max_position: 4 }] };
      if (sql.includes('INSERT INTO database_properties')) return { rows: [property({ name: values?.[1], position: values?.[4] })] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(addDatabaseProperty('db-1', {
      database_revision: 1,
      name: ' Priority ',
      property_type: 'select',
      options: { choices: ['Low', 'High'] },
    })).resolves.toMatchObject({ database_revision: 2, property: { name: 'Priority', position: 5 } });

    mocks.clientQuery.mockReset();
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('UPDATE databases') && sql.includes('RETURNING id, revision')) return { rows: [{ id: 'db-1', revision: 2 }] };
      if (sql.includes('LOWER(BTRIM(name))')) return { rows: [{ id: 'duplicate' }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(addDatabaseProperty('db-1', {
      database_revision: 1, name: 'Priority', property_type: 'text',
    })).rejects.toThrow('already exists in database');
  });

  it('enforces title uniqueness and the active-property capacity before adding a property', async () => {
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('UPDATE databases') && sql.includes('RETURNING id, revision')) return { rows: [{ id: 'db-1', revision: 2 }] };
      if (sql.includes('LOWER(BTRIM(name))')) return { rows: [] };
      if (sql.includes("property_type = 'title'")) return { rows: [{ id: 'existing-title' }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(addDatabaseProperty('db-1', {
      database_revision: 1, name: 'Another title', property_type: 'title',
    })).rejects.toThrow('only one title property');

    mocks.clientQuery.mockReset();
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('UPDATE databases') && sql.includes('RETURNING id, revision')) return { rows: [{ id: 'db-1', revision: 2 }] };
      if (sql.includes('LOWER(BTRIM(name))')) return { rows: [] };
      if (sql.includes('COUNT(*)::int')) return { rows: [{ count: 100 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(addDatabaseProperty('db-1', {
      database_revision: 1, name: 'Overflow', property_type: 'text',
    })).rejects.toThrow('at most 100 active properties');
  });

  it('updates choices only when existing values stay valid and bumps the parent revision', async () => {
    setClientHandler(async (sql, values) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'db-1', archived_at: null, workspace_archived_at: null }] };
      if (sql.includes('WHERE id = $1\n     FOR UPDATE')) return { rows: [property({ property_type: 'multi_select' })] };
      if (sql.includes('id <> $2')) return { rows: [] };
      if (sql.includes('SELECT EXISTS')) return { rows: [{ invalid: false }] };
      if (sql.includes('UPDATE database_properties')) return { rows: [property({ revision: 2, name: values?.[0] })] };
      if (sql.includes('UPDATE databases')) return { rows: [{ revision: 3 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(updateDatabaseProperty('prop-1', {
      revision: 1,
      name: ' Labels ',
      options: { choices: ['A', 'B'] },
    })).resolves.toMatchObject({ database_revision: 3, property: { name: 'Labels', revision: 2 } });
    const valueCheck = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('SELECT EXISTS'));
    expect(String(valueCheck?.[0])).toContain('jsonb_array_elements_text');
  });

  it('returns null for a missing property parent and detects a lost property update revision', async () => {
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(updateDatabaseProperty('missing', { revision: 1, name: 'Name' })).resolves.toBeNull();

    mocks.clientQuery.mockReset();
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'db-1', archived_at: null, workspace_archived_at: null }] };
      if (sql.includes('WHERE id = $1\n     FOR UPDATE')) return { rows: [property()] };
      if (sql.includes('id <> $2')) return { rows: [] };
      if (sql.includes('UPDATE database_properties')) return { rows: [] };
      if (sql === 'SELECT revision FROM database_properties WHERE id = $1') return { rows: [{ revision: 2 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(updateDatabaseProperty('prop-1', { revision: 1, name: 'Renamed' }))
      .rejects.toThrow('database property prop-1 is at revision 2, not 1');
  });

  it('rejects unchanged type updates and returns null when a locked property is absent or archived', async () => {
    await expect(updateDatabaseProperty('prop-1', { revision: 1, property_type: 'text' } as never))
      .rejects.toThrow('type cannot be changed');
    await expect(updateDatabaseProperty('prop-1', { revision: 1 })).rejects.toThrow('At least one property field');

    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'db-1', archived_at: null, workspace_archived_at: null }] };
      if (sql.includes('WHERE id = $1\n     FOR UPDATE')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(updateDatabaseProperty('missing', { revision: 1, name: 'Name' })).resolves.toBeNull();

    mocks.clientQuery.mockReset();
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'db-1', archived_at: null, workspace_archived_at: null }] };
      if (sql.includes('WHERE id = $1\n     FOR UPDATE')) return { rows: [property({ archived_at: 'now' })] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(updateDatabaseProperty('prop-1', { revision: 1, name: 'Name' })).resolves.toBeNull();
  });

  it('restores a non-title property with collision checks and prevents title archiving', async () => {
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'db-1', archived_at: null, workspace_archived_at: null }] };
      if (sql.includes('WHERE id = $1\n     FOR UPDATE')) return { rows: [property({ archived_at: '2026-01-02' })] };
      if (sql.includes('COUNT(*)::int')) return { rows: [{ count: 2 }] };
      if (sql.includes('OR position = $4')) return { rows: [] };
      if (sql.includes('UPDATE database_properties')) return { rows: [property({ revision: 2, archived_at: null })] };
      if (sql.includes('UPDATE databases')) return { rows: [{ revision: 4 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(restoreDatabaseProperty('prop-1', 1)).resolves.toMatchObject({
      database_revision: 4,
      property: { archived_at: null, revision: 2 },
    });

    mocks.clientQuery.mockReset();
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'db-1', archived_at: null, workspace_archived_at: null }] };
      if (sql.includes('WHERE id = $1\n     FOR UPDATE')) return { rows: [property({ property_type: 'title', archived_at: null })] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveDatabaseProperty('prop-1', 1)).rejects.toThrow('title property cannot be archived');
  });

  it('rejects property restore capacity and name conflicts before mutating the property', async () => {
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'db-1', archived_at: null, workspace_archived_at: null }] };
      if (sql.includes('WHERE id = $1\n     FOR UPDATE')) return { rows: [property({ archived_at: '2026-01-02' })] };
      if (sql.includes('COUNT(*)::int')) return { rows: [{ count: 100 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(restoreDatabaseProperty('prop-1', 1)).rejects.toThrow('at most 100 active properties');

    mocks.clientQuery.mockReset();
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'db-1', archived_at: null, workspace_archived_at: null }] };
      if (sql.includes('WHERE id = $1\n     FOR UPDATE')) return { rows: [property({ archived_at: '2026-01-02' })] };
      if (sql.includes('COUNT(*)::int')) return { rows: [{ count: 2 }] };
      if (sql.includes('OR position = $4')) return { rows: [{ id: 'conflict' }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(restoreDatabaseProperty('prop-1', 1))
      .rejects.toThrow('cannot be restored because an active property conflicts');
  });

  it('refuses to archive a property that still holds row values', async () => {
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'db-1', archived_at: null, workspace_archived_at: null }] };
      if (sql.includes('WHERE id = $1\n     FOR UPDATE')) return { rows: [property({ property_type: 'text', archived_at: null })] };
      if (sql.includes('FROM database_row_values')) return { rows: [{ has_values: true }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveDatabaseProperty('prop-1', 1))
      .rejects.toThrow('Database property prop-1 still has row values and cannot be archived');
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');

    mocks.clientQuery.mockReset();
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'db-1', archived_at: null, workspace_archived_at: null }] };
      if (sql.includes('WHERE id = $1\n     FOR UPDATE')) return { rows: [property({ property_type: 'text', archived_at: null })] };
      if (sql.includes('FROM database_row_values')) return { rows: [{ has_values: false }] };
      if (sql.includes('UPDATE database_properties')) return { rows: [property({ revision: 2, archived_at: '2026-01-02' })] };
      if (sql.includes('UPDATE databases')) return { rows: [{ revision: 4 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveDatabaseProperty('prop-1', 1)).resolves.toMatchObject({
      database_revision: 4,
      property: { archived_at: '2026-01-02', revision: 2 },
    });
  });

  it('returns null for missing archive locks and detects property movement or stale lifecycle revisions', async () => {
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveDatabaseProperty('missing', 1)).resolves.toBeNull();

    mocks.clientQuery.mockReset();
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'db-1', archived_at: null, workspace_archived_at: null }] };
      if (sql.includes('WHERE id = $1\n     FOR UPDATE')) return { rows: [property({ database_id: 'other-db' })] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveDatabaseProperty('prop-1', 1)).rejects.toThrow('changed databases during update');

    mocks.clientQuery.mockReset();
    setClientHandler(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'db-1', archived_at: null, workspace_archived_at: null }] };
      if (sql.includes('WHERE id = $1\n     FOR UPDATE')) return { rows: [property({ revision: 2 })] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveDatabaseProperty('prop-1', 1)).rejects.toThrow('database property prop-1 is at revision 2, not 1');
  });
});
