import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  requireDatabase: vi.fn(),
  requirePage: vi.fn(),
  requireActivePage: vi.fn(),
  lockActivePageForChildWrite: vi.fn(),
  requireActiveWorkspace: vi.fn(),
}));

vi.mock('../client.js', () => ({
  getPool: () => ({ query: mocks.poolQuery, connect: mocks.connect }),
}));

vi.mock('./scopeGuards.js', () => ({
  lockActivePageForChildWrite: mocks.lockActivePageForChildWrite,
  requireActivePage: mocks.requireActivePage,
  requireActiveWorkspace: mocks.requireActiveWorkspace,
  requireDatabase: mocks.requireDatabase,
  requirePage: mocks.requirePage,
}));

function property(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prop-status',
    database_id: 'db-1',
    name: 'Status',
    property_type: 'select',
    options: {},
    position: 1,
    revision: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function lockedDatabase() {
  return {
    id: 'db-1',
    archived_at: null,
    workspace_archived_at: null,
  };
}

describe('database property persistence contracts', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
    mocks.requireDatabase.mockResolvedValue({ workspace_id: 'ws-1', parent_page_id: null });
    mocks.requirePage.mockResolvedValue({ workspace_id: 'ws-1' });
    mocks.requireActivePage.mockResolvedValue({ workspace_id: 'ws-1' });
    mocks.lockActivePageForChildWrite.mockResolvedValue({ workspace_id: 'ws-1' });
    mocks.requireActiveWorkspace.mockResolvedValue(undefined);
  });

  it('revision-checks and increments the database when adding a property', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('UPDATE databases')) return { rows: [{ id: 'db-1', revision: 5 }] };
      if (sql.includes('LOWER(BTRIM(name))')) return { rows: [] };
      if (sql.includes('COUNT(*)::int')) return { rows: [{ count: 2 }] };
      if (sql.includes('MAX(position)')) return { rows: [{ max_position: 2 }] };
      if (sql.includes('INSERT INTO database_properties')) {
        return { rows: [property({ position: 3 })] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { addDatabaseProperty } = await import('./databases.js');

    await expect(addDatabaseProperty('db-1', {
      database_revision: 4,
      name: 'Status',
      property_type: 'select',
      options: { choices: ['Open'] },
    })).resolves.toMatchObject({
      property: { id: 'prop-status', position: 3 },
      database_revision: 5,
    });

    const touch = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE databases'));
    expect(touch?.[1]).toEqual(['db-1', 4]);
    expect(String(touch?.[0])).toContain('revision = revision + 1');
    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('caps databases at 100 active properties and rolls back the revision bump', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('UPDATE databases')) return { rows: [{ id: 'db-1' }] };
      if (sql.includes('LOWER(BTRIM(name))')) return { rows: [] };
      if (sql.includes('COUNT(*)::int')) return { rows: [{ count: 100 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { addDatabaseProperty } = await import('./databases.js');

    await expect(addDatabaseProperty('db-1', {
      database_revision: 2,
      name: 'Owner',
      property_type: 'text',
    })).rejects.toThrow('at most 100 active properties');

    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(mocks.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO database_properties')
    )).toBe(false);
  });

  it('reports stale database revisions before inserting a property', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('UPDATE databases')) return { rows: [] };
      if (sql === 'SELECT revision FROM databases WHERE id = $1') {
        return { rows: [{ revision: 7 }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { addDatabaseProperty } = await import('./databases.js');

    await expect(addDatabaseProperty('db-1', {
      database_revision: 3,
      name: 'Status',
      property_type: 'text',
    })).rejects.toThrow('database db-1 is at revision 7, not 3');
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('updates properties with their own revision and explicit columns', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [lockedDatabase()] };
      if (sql.includes('FROM database_properties') && sql.includes('FOR UPDATE')) {
        return { rows: [property()] };
      }
      if (sql.includes('id <> $2') && sql.includes('LOWER(BTRIM(name))')) return { rows: [] };
      if (sql.includes('SELECT EXISTS')) return { rows: [{ invalid: false }] };
      if (sql.includes('UPDATE database_properties')) {
        return { rows: [property({ name: 'State', revision: 2 })] };
      }
      if (sql.includes('UPDATE databases')) return { rows: [{ revision: 8 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { updateDatabaseProperty } = await import('./databases.js');

    await expect(updateDatabaseProperty('prop-status', {
      revision: 1,
      name: 'State',
      options: { choices: ['Open', 'Done'] },
    })).resolves.toMatchObject({
      property: { name: 'State', revision: 2 },
      database_revision: 8,
    });

    const updateSql = String(mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE database_properties')
    )?.[0]);
    expect(updateSql).toContain('revision = revision + 1');
    expect(updateSql).not.toContain('RETURNING *');
    expect(mocks.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes('UPDATE databases')
    )).toBe(true);
    const statements = mocks.clientQuery.mock.calls.map(([sql]) => String(sql));
    const databaseLock = statements.findIndex((sql) => sql.includes('FOR UPDATE OF d'));
    const propertyLock = statements.findIndex((sql) =>
      sql.includes('FROM database_properties')
      && sql.includes('FOR UPDATE')
      && !sql.includes('FOR UPDATE OF d')
    );
    expect(databaseLock).toBeGreaterThan(-1);
    expect(propertyLock).toBeGreaterThan(databaseLock);
  });

  it('bumps and returns the parent database revision when archiving a property', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [lockedDatabase()] };
      if (sql.includes('FROM database_properties') && sql.includes('FOR UPDATE')) {
        return { rows: [property()] };
      }
      if (sql.includes('UPDATE database_properties')) {
        return { rows: [property({ revision: 2, archived_at: 'now' })] };
      }
      if (sql.includes('UPDATE databases')) return { rows: [{ revision: 9 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { archiveDatabaseProperty } = await import('./databases.js');

    await expect(archiveDatabaseProperty('prop-status', 1)).resolves.toMatchObject({
      property: { id: 'prop-status', revision: 2, archived_at: 'now' },
      database_revision: 9,
    });
  });

  it('rejects choice updates that would invalidate existing rows', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [lockedDatabase()] };
      if (sql.includes('FROM database_properties') && sql.includes('FOR UPDATE')) {
        return { rows: [property()] };
      }
      if (sql.includes('id <> $2') && sql.includes('LOWER(BTRIM(name))')) return { rows: [] };
      if (sql.includes('SELECT EXISTS')) return { rows: [{ invalid: true }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { updateDatabaseProperty } = await import('./databases.js');

    await expect(updateDatabaseProperty('prop-status', {
      revision: 1,
      options: { choices: ['Done'] },
    })).rejects.toThrow('would invalidate existing row values');
    expect(mocks.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes('UPDATE database_properties')
    )).toBe(false);
    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('never allows the active title property to be archived or property storage types to change', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FOR UPDATE OF d')) return { rows: [lockedDatabase()] };
      if (sql.includes('FROM database_properties') && sql.includes('FOR UPDATE')) {
        return { rows: [property({ id: 'prop-title', name: 'Title', property_type: 'title', position: 0 })] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { archiveDatabaseProperty, updateDatabaseProperty } = await import('./databases.js');

    await expect(archiveDatabaseProperty('prop-title', 1)).rejects.toThrow(
      'title property cannot be archived'
    );
    const invalidUpdate = {
      revision: 1,
      property_type: 'text',
    } as { revision: number };
    await expect(updateDatabaseProperty('prop-title', invalidUpdate)).rejects.toThrow(
      'property type cannot be changed'
    );
  });

  it('checks stale property-add revisions through the checked-out client after rollback', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('UPDATE databases')) return { rows: [] };
      if (sql === 'SELECT revision FROM databases WHERE id = $1') {
        return { rows: [{ revision: 4 }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { addDatabaseProperty } = await import('./databases.js');

    await expect(addDatabaseProperty('db-1', {
      database_revision: 3,
      name: 'Owner',
      property_type: 'text',
    })).rejects.toThrow('Conflict: database db-1 is at revision 4, not 3');

    expect(mocks.poolQuery).not.toHaveBeenCalled();
    expect(mocks.clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('UPDATE databases'),
      'ROLLBACK',
      'SELECT revision FROM databases WHERE id = $1',
    ]);
  });
});
