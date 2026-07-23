import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  connect: vi.fn(),
  poolQuery: vi.fn(),
  release: vi.fn(),
  requireActiveWorkspace: vi.fn(),
}));

vi.mock('../client.js', () => ({
  getPool: () => ({ connect: mocks.connect, query: mocks.poolQuery }),
}));

vi.mock('./scopeGuards.js', () => ({
  requireActiveWorkspace: mocks.requireActiveWorkspace,
}));

import {
  archiveRow,
  createRow,
  getRow,
  queryRows,
  restoreRow,
  updateRow,
} from './rows.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    database_id: 'db-1',
    tags: [],
    importance: 0.5,
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

const fullSchema = [
  property(),
  property({ id: 'prop-text', name: 'Text', property_type: 'text', position: 1 }),
  property({ id: 'prop-url', name: 'URL', property_type: 'url', position: 2 }),
  property({ id: 'prop-number', name: 'Number', property_type: 'number', position: 3 }),
  property({ id: 'prop-date', name: 'Date', property_type: 'date', position: 4 }),
  property({ id: 'prop-check', name: 'Check', property_type: 'checkbox', position: 5 }),
  property({
    id: 'prop-select', name: 'Select', property_type: 'select', position: 6,
    options: { choices: ['Open', 'Closed'] },
  }),
  property({
    id: 'prop-multi', name: 'Multi', property_type: 'multi_select', position: 7,
    options: { choices: ['A', 'B'] },
  }),
];

function respondsWithSchema(
  query: ReturnType<typeof vi.fn>,
  options: { rows?: unknown[]; schema?: unknown[]; update?: unknown[] } = {}
) {
  query.mockImplementation(async (sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql === 'SELECT database_id FROM database_rows WHERE id = $1') return { rows: [{ database_id: 'db-1' }] };
    if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
    if (sql.includes('FROM database_properties')) return { rows: options.schema ?? fullSchema };
    if (sql.includes('FOR UPDATE OF r')) return { rows: [{ ...row(), workspace_id: 'ws-1' }] };
    if (sql.includes('INSERT INTO database_rows')) return { rows: [row()] };
    if (sql.includes('UPDATE database_rows')) return { rows: options.update ?? [row({ revision: 2 })] };
    if (sql.includes('INSERT INTO database_row_values')) return { rows: [] };
    if (sql.includes('FROM database_row_values')) return { rows: options.rows ?? [] };
    if (sql.includes('SELECT revision, archived_at FROM database_rows')) return { rows: [] };
    if (sql.includes('SELECT revision FROM database_rows')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

describe('row query coverage cases', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
    mocks.requireActiveWorkspace.mockResolvedValue(undefined);
  });

  it('serializes each supported value type through a row create', async () => {
    respondsWithSchema(mocks.clientQuery);

    await expect(createRow({
      database_id: 'db-1',
      tags: ['typed'],
      importance: 1,
      values: {
        Title: 'A title',
        Text: 'plain text',
        URL: 'https://example.test',
        Number: 42.5,
        Date: '2024-02-29T12:34:56+02:30',
        Check: false,
        Select: 'Open',
        Multi: ['A', 'B'],
      },
    })).resolves.toMatchObject({ id: 'row-1' });

    const writes = mocks.clientQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO database_row_values'));
    expect(writes).toHaveLength(8);
    expect(writes.map(([, values]) => values?.slice(2))).toEqual(expect.arrayContaining([
      ['A title', null, null, null, null],
      [null, 42.5, null, null, null],
      [null, null, '2024-02-29T10:04:56.000Z', null, null],
      [null, null, null, false, null],
      [null, null, null, null, '["A","B"]'],
    ]));
  });

  it('builds type-aware SQL filters for null, scalar, JSON, and contains predicates', async () => {
    respondsWithSchema(mocks.poolQuery);
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: fullSchema };
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: '0' }] };
      if (sql.includes('FROM database_rows r')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(queryRows({
      database_id: 'db-1',
      filters: [
        { property: 'Title', operator: 'eq', value: null },
        { property: 'Text', operator: 'neq', value: 'no' },
        { property: 'Number', operator: 'gt', value: 3 },
        { property: 'Date', operator: 'lt', value: '2026-01-02' },
        { property: 'Check', operator: 'eq', value: true },
        { property: 'Select', operator: 'eq', value: 'Open' },
        { property: 'Multi', operator: 'eq', value: ['A'] },
        { property: 'Multi', operator: 'contains', value: 'B' },
      ],
      sort_by: 'Check',
      sort_direction: 'asc',
      include_archived: true,
    })).resolves.toEqual({ rows: [], total: 0 });

    const count = mocks.poolQuery.mock.calls.find(([sql]) => String(sql).includes('SELECT COUNT(*)'));
    expect(String(count?.[0])).toContain('NOT EXISTS');
    expect(String(count?.[0])).toContain('NOT EXISTS (SELECT 1 FROM database_row_values v');
    expect(String(count?.[0])).toContain('v.value_json ?');
    expect(count?.[1]).toContain('["A"]');
    const selected = mocks.poolQuery.mock.calls.find(([sql]) => String(sql).includes('ORDER BY') && String(sql).includes('FROM database_rows r'));
    expect(String(selected?.[0])).toContain('ASC NULLS LAST');
  });

  it('rejects null comparisons and invalid typed filter values without querying rows', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: fullSchema };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(queryRows({
      database_id: 'db-1', filters: [{ property: 'Number', operator: 'gt', value: null }],
    })).rejects.toThrow('gt filters cannot compare against null');
    await expect(queryRows({
      database_id: 'db-1', filters: [{ property: 'Text', operator: 'contains', value: 1 as never }],
    })).rejects.toThrow('contains filters require a string value');
    await expect(queryRows({
      database_id: 'db-1', filters: [{ property: 'Select', operator: 'eq', value: 'Other' }],
    })).rejects.toThrow('Select must be one of: Open, Closed');
    expect(mocks.poolQuery.mock.calls.some(([sql]) => String(sql).includes('SELECT COUNT(*)'))).toBe(false);
  });

  it('returns null for missing reads and updates identities without mutating values', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(getRow('missing')).resolves.toBeNull();

    respondsWithSchema(mocks.clientQuery);
    await expect(updateRow('row-1', {
      revision: 1,
      tags: ['updated'],
      importance: 0,
    })).resolves.toMatchObject({ revision: 2 });
    const update = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE database_rows'));
    expect(update?.[1]).toEqual([['updated'], 0, 'row-1', 1]);
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO database_row_values'))).toBe(false);
  });

  it('returns null when the row disappears before update locking', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql === 'SELECT database_id FROM database_rows WHERE id = $1') return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(updateRow('missing', { revision: 1, tags: [] })).resolves.toBeNull();
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it.each([
    [{ Title: 'x', Text: 1 }, 'Text must be a string'],
    [{ Title: 'x', URL: 1 }, 'URL must be a string'],
    [{ Title: 'x', Number: Number.POSITIVE_INFINITY }, 'Number must be a finite number'],
    [{ Title: 'x', Date: 1 }, 'Date must be a valid date'],
    [{ Title: 'x', Date: '2026-01-01T00:00+25:00' }, 'Date must be a valid date'],
    [{ Title: 'x', Check: 'yes' }, 'Check must be a boolean'],
    [{ Title: 'x', Select: 1 }, 'Select must be a string'],
    [{ Title: 'x', Multi: 'A' }, 'Multi must be an array of strings'],
    [{ Title: 'x', Multi: ['C'] }, 'Multi contains unsupported choice: C'],
  ])('rejects malformed typed row input %o before inserting a row', async (values, message) => {
    respondsWithSchema(mocks.clientQuery);

    await expect(createRow({ database_id: 'db-1', values })).rejects.toThrow(message);
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO database_rows'))).toBe(false);
  });

  it('validates filter shape, operators, and sort names before loading row records', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: fullSchema };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(queryRows({ database_id: 'db-1', filters: [{ property: 'Unknown', operator: 'eq', value: 1 }] }))
      .rejects.toThrow('Unknown filter property: Unknown');
    await expect(queryRows({ database_id: 'db-1', filters: [{ property: 'Title', operator: 'bad' as never, value: 'x' }] }))
      .rejects.toThrow('Unsupported row filter operator: bad');
    await expect(queryRows({ database_id: 'db-1', filters: [{ property: 'Title', operator: 'eq' } as never] }))
      .rejects.toThrow('eq filters require a value');
    await expect(queryRows({ database_id: 'db-1', filters: [{ property: 'Title', operator: 'gt', value: 'x' }] }))
      .rejects.toThrow('Operator gt is not supported for title');
    await expect(queryRows({ database_id: 'db-1', filters: [{ property: 'Number', operator: 'contains', value: '1' }] }))
      .rejects.toThrow('contains is not supported for number');
    await expect(queryRows({ database_id: 'db-1', sort_by: 'Unknown' }))
      .rejects.toThrow('Unknown sort property: Unknown');
    await expect(queryRows({ database_id: 'db-1', sort_direction: 'sideways' as never, sort_by: 'Title' }))
      .rejects.toThrow('sort_direction must be asc or desc');
    expect(mocks.poolQuery.mock.calls.some(([sql]) => String(sql).includes('SELECT COUNT(*)'))).toBe(false);
  });

  it('rolls back when a row changes databases and reports an update-write revision conflict', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql === 'SELECT database_id FROM database_rows WHERE id = $1') return { rows: [{ database_id: 'db-1' }] };
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: fullSchema };
      if (sql.includes('FOR UPDATE OF r')) return { rows: [{ ...row(), workspace_id: 'other-workspace' }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(updateRow('row-1', { revision: 1, tags: [] })).rejects.toThrow('changed databases during update');

    mocks.clientQuery.mockReset();
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql === 'SELECT database_id FROM database_rows WHERE id = $1') return { rows: [{ database_id: 'db-1' }] };
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: fullSchema };
      if (sql.includes('FOR UPDATE OF r')) return { rows: [{ ...row(), workspace_id: 'ws-1' }] };
      if (sql.includes('UPDATE database_rows')) return { rows: [] };
      if (sql === 'SELECT revision FROM database_rows WHERE id = $1') return { rows: [{ revision: 2 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(updateRow('row-1', { revision: 1, tags: [] })).rejects.toThrow('row row-1 is at revision 2, not 1');
  });

  it('restores archived rows and rejects a matching-revision repeat archive as a state conflict', async () => {
    respondsWithSchema(mocks.clientQuery, { update: [row({ revision: 2, archived_at: null })] });
    await expect(restoreRow('row-1', 1)).resolves.toMatchObject({ revision: 2, archived_at: null });
    const restoreUpdate = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE database_rows'));
    expect(String(restoreUpdate?.[0])).toContain('archived_at IS NOT NULL');

    mocks.clientQuery.mockReset();
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql === 'SELECT database_id FROM database_rows WHERE id = $1') return { rows: [{ database_id: 'db-1' }] };
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: fullSchema };
      if (sql.includes('UPDATE database_rows')) return { rows: [] };
      if (sql.includes('SELECT revision, archived_at FROM database_rows')) {
        return { rows: [{ revision: 1, archived_at: '2026-01-02T00:00:00.000Z' }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveRow('row-1', 1)).rejects.toThrow('row row-1 is already archived');
  });

  it('returns null without a mutation when an archive target or its parent database no longer exists', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql === 'SELECT database_id FROM database_rows WHERE id = $1') return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveRow('missing', 1)).resolves.toBeNull();

    mocks.clientQuery.mockReset();
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql === 'SELECT database_id FROM database_rows WHERE id = $1') return { rows: [{ database_id: 'gone-db' }] };
      if (sql.includes('FROM databases')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(archiveRow('row-1', 1)).resolves.toBeNull();
  });
});
