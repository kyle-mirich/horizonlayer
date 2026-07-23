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
    id: 'prop-title',
    database_id: 'db-1',
    name: 'Title',
    property_type: 'title',
    options: {},
    position: 0,
    revision: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('database persistence contracts', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
    mocks.requireDatabase.mockResolvedValue({ workspace_id: 'ws-1', parent_page_id: null });
    mocks.requirePage.mockResolvedValue({ workspace_id: 'ws-1', parent_page_id: null, session_id: null });
    mocks.requireActivePage.mockResolvedValue({ workspace_id: 'ws-1', parent_page_id: null, session_id: null });
    mocks.lockActivePageForChildWrite.mockResolvedValue({ workspace_id: 'ws-1', parent_page_id: null, session_id: null });
    mocks.requireActiveWorkspace.mockResolvedValue(undefined);
  });

  it('creates one title property when callers omit it', async () => {
    let propertyNumber = 0;
    mocks.clientQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('INSERT INTO databases')) return { rows: [database()] };
      if (sql.includes('INSERT INTO database_properties')) {
        propertyNumber += 1;
        return {
          rows: [property({
            id: `prop-${propertyNumber}`,
            name: values?.[1],
            property_type: values?.[2],
            position: values?.[4],
          })],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { createDatabase } = await import('./databases.js');

    const created = await createDatabase({
      workspace_id: 'ws-1',
      name: ' Projects ',
      parent_page_id: 'page-parent',
      properties: [{ name: 'Status', property_type: 'select' }],
    });

    expect(created.properties).toHaveLength(2);
    const inserts = mocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO database_properties')
    );
    expect(inserts[0]?.[1]).toEqual(['db-1', 'Title', 'title', '{}', 0]);
    expect(inserts[1]?.[1]).toEqual(['db-1', 'Status', 'select', '{}', 1]);
    expect(mocks.requireActiveWorkspace).toHaveBeenCalledWith('ws-1');
    expect(mocks.requireActivePage).toHaveBeenCalledWith('page-parent');
    expect(mocks.lockActivePageForChildWrite).toHaveBeenCalledWith(
      'page-parent',
      expect.objectContaining({ query: mocks.clientQuery })
    );
    expect(mocks.lockActivePageForChildWrite.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clientQuery.mock.invocationCallOrder[
        mocks.clientQuery.mock.calls.findIndex(([sql]) => String(sql).includes('INSERT INTO databases'))
      ]
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('rejects unknown types, duplicate names, and multiple titles before opening a transaction', async () => {
    const { createDatabase } = await import('./databases.js');

    await expect(createDatabase({
      workspace_id: 'ws-1',
      name: 'Bad',
      properties: [{ name: 'Attachment', property_type: 'files' }],
    })).rejects.toThrow('Unsupported property type: files');
    await expect(createDatabase({
      workspace_id: 'ws-1',
      name: 'Bad',
      properties: [
        { name: 'Status', property_type: 'text' },
        { name: ' status ', property_type: 'select' },
      ],
    })).rejects.toThrow('Duplicate database property name: status');
    await expect(createDatabase({
      workspace_id: 'ws-1',
      name: 'Bad',
      properties: [
        { name: 'Title', property_type: 'title' },
        { name: 'Other', property_type: 'title' },
      ],
    })).rejects.toThrow('only one title property');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('accepts only normalized choice options on select properties', async () => {
    const { createDatabase } = await import('./databases.js');

    await expect(createDatabase({
      workspace_id: 'ws-1',
      name: 'Bad options',
      properties: [{ name: 'Body', property_type: 'text', options: { choices: ['x'] } }],
    })).rejects.toThrow('text does not accept options');
    await expect(createDatabase({
      workspace_id: 'ws-1',
      name: 'Duplicate choices',
      properties: [{
        name: 'Status',
        property_type: 'select',
        options: { choices: ['Open', ' open '] },
      }],
    })).rejects.toThrow('Duplicate property choice: open');
    await expect(createDatabase({
      workspace_id: 'ws-1',
      name: 'Extra option key',
      properties: [{
        name: 'Status',
        property_type: 'select',
        options: { choices: ['Open'], color: 'blue' },
      }],
    })).rejects.toThrow('must be exactly');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('gets and lists with explicit columns, archive controls, tags, and parameterized pagination', async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [database()] })
      .mockResolvedValueOnce({ rows: [property()] })
      .mockResolvedValueOnce({ rows: [database(), database({ id: 'db-2' })] });
    const { getDatabase, listDatabases } = await import('./databases.js');

    await expect(getDatabase('db-1', { include_archived: true })).resolves.toMatchObject({
      id: 'db-1',
      properties: [{ id: 'prop-title' }],
    });
    await expect(listDatabases({
      workspace_id: 'ws-1',
      tags: ['active'],
      include_archived: false,
      limit: 101,
      offset: 25,
    })).resolves.toHaveLength(2);

    const sql = mocks.poolQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toContain('SELECT *');
    expect(sql).toContain('tags && $3::text[]');
    expect(sql).toContain('LIMIT $4 OFFSET $5');
    expect(sql).not.toContain('ANY($1::uuid[])');
    expect(mocks.poolQuery.mock.calls[2]?.[1]).toEqual([
      'ws-1', false, ['active'], 101, 25,
    ]);
  });

  it('requires a current revision for updates and archive transitions', async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [database({ name: 'Renamed', revision: 2 })] })
      .mockResolvedValueOnce({ rows: [database({ archived_at: '2026-01-02', revision: 3 })] });
    const { archiveDatabase, updateDatabase } = await import('./databases.js');

    await expect(updateDatabase('db-1', { revision: 1, name: 'Renamed' })).resolves.toMatchObject({
      revision: 2,
    });
    await expect(archiveDatabase('db-1', 2)).resolves.toMatchObject({ revision: 3 });

    expect(String(mocks.poolQuery.mock.calls[0]?.[0])).toContain('AND revision = $3');
    expect(String(mocks.poolQuery.mock.calls[1]?.[0])).toContain('archived_at IS NULL');
    await expect(updateDatabase('db-1', { revision: 0, name: 'Nope' })).rejects.toThrow(
      'revision must be a positive integer'
    );
  });
});
