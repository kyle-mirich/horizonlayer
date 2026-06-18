import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const clientQueryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn();
const assertDatabaseReadAccessMock = vi.fn();
const assertDatabaseWriteAccessMock = vi.fn();
const assertPageWriteAccessMock = vi.fn();
const assertWorkspaceWriteAccessMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    connect: connectMock,
    query: poolQueryMock,
  }),
}));

vi.mock('./accessControl.js', () => ({
  assertDatabaseReadAccess: assertDatabaseReadAccessMock,
  assertDatabaseWriteAccess: assertDatabaseWriteAccessMock,
  assertPageWriteAccess: assertPageWriteAccessMock,
  assertWorkspaceWriteAccess: assertWorkspaceWriteAccessMock,
}));

function database(overrides: Record<string, unknown> = {}) {
  return {
    id: 'db-1',
    workspace_id: 'ws-1',
    parent_page_id: null,
    name: 'Database',
    description: null,
    icon: null,
    tags: [],
    source: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function property(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prop-1',
    database_id: 'db-1',
    name: 'Title',
    property_type: 'title',
    options: {},
    position: 0,
    is_required: true,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('database query contracts', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockReset();
    assertDatabaseReadAccessMock.mockReset();
    assertDatabaseWriteAccessMock.mockReset();
    assertPageWriteAccessMock.mockReset();
    assertWorkspaceWriteAccessMock.mockReset();
    connectMock.mockResolvedValue({ query: clientQueryMock, release: releaseMock });
    assertDatabaseReadAccessMock.mockResolvedValue(undefined);
    assertDatabaseWriteAccessMock.mockResolvedValue(undefined);
    assertPageWriteAccessMock.mockResolvedValue({ workspace_id: 'ws-1' });
    assertWorkspaceWriteAccessMock.mockResolvedValue(undefined);
  });

  it('creates databases with workspace access and property rows in one transaction', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [database()] })
      .mockResolvedValueOnce({ rows: [property()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { createDatabase } = await import('./databases.js');
    const created = await createDatabase({
      name: 'Database',
      workspace_id: 'ws-1',
      properties: [{ name: 'Title', type: 'title', is_required: true }],
    });

    expect(created.properties).toHaveLength(1);
    expect(assertWorkspaceWriteAccessMock).toHaveBeenCalledWith('ws-1', { kind: 'system' });
    expect(clientQueryMock.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate property input before opening a transaction', async () => {
    const { createDatabase } = await import('./databases.js');

    await expect(createDatabase({
      name: 'Database',
      properties: [
        { name: ' Title ', type: 'title' },
        { name: 'title', type: 'text' },
      ],
    })).rejects.toThrow('Duplicate database property names: title');

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('validates parent page workspace and rolls back failed inserts', async () => {
    assertPageWriteAccessMock.mockResolvedValueOnce({ workspace_id: null });
    const { createDatabase } = await import('./databases.js');

    await expect(createDatabase({
      name: 'Nested',
      parent_page_id: 'page-1',
      properties: [{ name: 'Title', type: 'title' }],
    })).rejects.toThrow('Parent page page-1 is not associated with a workspace');

    assertPageWriteAccessMock.mockResolvedValueOnce({ workspace_id: 'ws-2' });
    await expect(createDatabase({
      name: 'Nested',
      parent_page_id: 'page-1',
      workspace_id: 'ws-1',
      properties: [{ name: 'Title', type: 'title' }],
    })).rejects.toThrow('workspace_id must match the parent page workspace');

    assertPageWriteAccessMock.mockResolvedValueOnce({ workspace_id: 'ws-1' });
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(createDatabase({
      name: 'Nested',
      parent_page_id: 'page-1',
      properties: [{ name: 'Title', type: 'title' }],
    })).rejects.toThrow('insert failed');
    expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('rolls back database creation when property insertion fails', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [database()] })
      .mockRejectedValueOnce(new Error('property insert failed'))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { createDatabase } = await import('./databases.js');
    await expect(createDatabase({
      name: 'Database',
      workspace_id: 'ws-1',
      properties: [{ name: 'Title', type: 'title' }],
    })).rejects.toThrow('property insert failed');

    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('gets, lists, updates, and deletes databases with optimistic conflict checks', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [database()] })
      .mockResolvedValueOnce({ rows: [property()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [database(), database({ id: 'db-2' })] })
      .mockResolvedValueOnce({ rows: [property(), property({ id: 'prop-2', database_id: 'db-2' })] })
      .mockResolvedValueOnce({ rows: [database({ name: 'Updated' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ updated_at: '2026-01-01T00:00:00.000Z' }] });

    const { deleteDatabase, getDatabase, listDatabases, updateDatabase } = await import('./databases.js');

    await expect(getDatabase('db-1')).resolves.toMatchObject({ id: 'db-1', properties: [{ id: 'prop-1' }] });
    await expect(getDatabase('missing')).resolves.toBeNull();
    await expect(listDatabases({ workspace_id: 'ws-1', tags: ['active'] })).resolves.toHaveLength(2);
    await expect(updateDatabase('db-1', { name: 'Updated', description: 'desc', icon: 'db', tags: ['a'] })).resolves.toMatchObject({ name: 'Updated' });
    await expect(deleteDatabase('db-1')).resolves.toBe(true);
    await expect(updateDatabase('db-1', { name: 'Stale', expected_updated_at: '2026-01-01T00:00:00.000Z' })).rejects.toThrow(
      'Conflict: database db-1 was modified by another agent'
    );
  });

  it('returns empty database lists without fetching properties', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });

    const { listDatabases } = await import('./databases.js');
    await expect(listDatabases({ workspace_id: 'ws-1' })).resolves.toEqual([]);

    expect(poolQueryMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for missing database updates and false for missing deletes without stale-write conflicts', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { deleteDatabase, updateDatabase } = await import('./databases.js');
    await expect(updateDatabase('missing', { name: 'Nope' })).resolves.toBeNull();
    await expect(deleteDatabase('missing')).resolves.toBe(false);
  });

  it('throws conflicts for stale database deletes', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [{ updated_at: '2026-01-03T00:00:00.000Z' }] });

    const { deleteDatabase } = await import('./databases.js');
    await expect(deleteDatabase(
      'db-1',
      { kind: 'system' },
      '2026-01-02T00:00:00.000Z'
    )).rejects.toThrow('Conflict: database db-1 was modified by another agent');
  });

  it('adds database properties and handles duplicate, missing, and failed transactions', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'db-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ max_pos: 2 }] })
      .mockResolvedValueOnce({ rows: [property({ id: 'prop-3', position: 3 })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'db-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'prop-existing' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { addDatabaseProperty } = await import('./databases.js');

    await expect(addDatabaseProperty('db-1', { name: 'Status', type: 'text', options: { choices: [] } })).resolves.toMatchObject({
      id: 'prop-3',
      position: 3,
    });
    await expect(addDatabaseProperty('db-1', { name: 'Status', type: 'text' })).rejects.toThrow(
      'Property Status already exists in database db-1'
    );
    await expect(addDatabaseProperty('db-1', {
      name: 'Missing',
      type: 'text',
      expected_updated_at: '2026-01-01T00:00:00.000Z',
    })).rejects.toThrow('Database db-1 not found');

    expect(releaseMock).toHaveBeenCalledTimes(3);
  });

  it('rolls back add-property transactions when the insert fails after duplicate checks', async () => {
    clientQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'db-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ max_pos: null }] })
      .mockRejectedValueOnce(new Error('property insert failed'))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { addDatabaseProperty } = await import('./databases.js');
    await expect(addDatabaseProperty('db-1', {
      name: 'Status',
      type: 'select',
      options: { choices: ['todo'] },
      is_required: true,
    })).rejects.toThrow('property insert failed');

    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
