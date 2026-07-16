import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowFilter } from './rows.js';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  requireActiveWorkspace: vi.fn(),
}));

vi.mock('../client.js', () => ({
  getPool: () => ({ query: mocks.poolQuery, connect: mocks.connect }),
}));

vi.mock('./scopeGuards.js', () => ({
  requireActiveWorkspace: mocks.requireActiveWorkspace,
}));

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

function storedValue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'value-1',
    row_id: 'row-1',
    property_id: 'prop-title',
    value_text: 'Ship it',
    value_number: null,
    value_date: null,
    value_bool: null,
    value_json: null,
    ...overrides,
  };
}

const properties = [
  property(),
  property({
    id: 'prop-labels',
    name: 'Labels',
    property_type: 'multi_select',
    options: { choices: ['Agent', 'Database'] },
    position: 1,
  }),
  property({
    id: 'prop-amount',
    name: 'Amount',
    property_type: 'number',
    position: 2,
  }),
];

describe('row persistence contracts', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
    mocks.requireActiveWorkspace.mockResolvedValue(undefined);
  });

  it('derives the live database schema and stores JavaScript null as SQL NULL', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: properties };
      if (sql.includes('INSERT INTO database_rows')) return { rows: [row()] };
      if (sql.includes('INSERT INTO database_row_values')) return { rows: [] };
      if (sql.includes('FROM database_row_values')) {
        return {
          rows: [
            storedValue(),
            storedValue({ id: 'value-2', property_id: 'prop-labels', value_text: null, value_json: null }),
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { createRow } = await import('./rows.js');

    await expect(createRow({
      database_id: 'db-1',
      values: { Title: 'Ship it', Labels: null },
    })).resolves.toMatchObject({
      id: 'row-1',
      values: { Title: 'Ship it', Labels: null },
    });

    const valueWrites = mocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO database_row_values')
    );
    expect(valueWrites[1]?.[1]?.[6]).toBeNull();
    const sql = mocks.clientQuery.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('INSERT INTO database_rows');
    expect(sql).toContain('INSERT INTO database_row_values');
    expect(sql).toMatch(/FROM databases[\s\S]*FOR SHARE/);
  });

  it('rejects caller values absent from the actual database schema', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: [property()] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { createRow } = await import('./rows.js');

    await expect(createRow({
      database_id: 'db-1',
      values: { Title: 'Known', Invented: 'Nope' },
    })).rejects.toThrow('Unknown properties: Invented');
    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('rejects unknown stored property types instead of falling back to text', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) {
        return { rows: [property({ property_type: 'mystery' })] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { createRow } = await import('./rows.js');

    await expect(createRow({
      database_id: 'db-1',
      values: { Title: 'No fallback' },
    })).rejects.toThrow('Unsupported property type: mystery');
  });

  it('enforces strict typed inputs and configured choices', async () => {
    const strictProperties = [
      property(),
      property({ id: 'prop-amount', name: 'Amount', property_type: 'number', position: 1 }),
      property({ id: 'prop-done', name: 'Done', property_type: 'checkbox', position: 2 }),
      property({
        id: 'prop-status',
        name: 'Status',
        property_type: 'select',
        options: { choices: ['Open', 'Done'] },
        position: 3,
      }),
      property({
        id: 'prop-labels',
        name: 'Labels',
        property_type: 'multi_select',
        options: { choices: ['Agent', 'Database'] },
        position: 4,
      }),
      property({ id: 'prop-due', name: 'Due', property_type: 'date', position: 5 }),
    ];
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: strictProperties };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { createRow } = await import('./rows.js');

    await expect(createRow({ database_id: 'db-1', values: { Title: '' } })).rejects.toThrow(
      'Title must be a non-empty string'
    );
    await expect(createRow({ database_id: 'db-1', values: { Title: 'x', Amount: '2' } })).rejects.toThrow(
      'Amount must be a finite number'
    );
    await expect(createRow({ database_id: 'db-1', values: { Title: 'x', Done: 'true' } })).rejects.toThrow(
      'Done must be a boolean'
    );
    await expect(createRow({ database_id: 'db-1', values: { Title: 'x', Status: 'Blocked' } })).rejects.toThrow(
      'Status must be one of: Open, Done'
    );
    await expect(createRow({ database_id: 'db-1', values: { Title: 'x', Labels: ['Agent', 2] } })).rejects.toThrow(
      'Labels must be an array of strings'
    );
    await expect(createRow({ database_id: 'db-1', values: { Title: 'x', Due: 'not-a-date' } })).rejects.toThrow(
      'Due must be a valid date'
    );
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO database_rows'))).toBe(false);
  });

  it('gets rows through SELECT-only reads and excludes archived data by default', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM database_rows r')) {
        return { rows: [{ ...row(), workspace_id: 'ws-1' }] };
      }
      if (sql.includes('FROM database_properties')) return { rows: [property()] };
      if (sql.includes('FROM database_row_values')) return { rows: [storedValue()] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { getRow } = await import('./rows.js');

    await expect(getRow('row-1')).resolves.toMatchObject({
      id: 'row-1',
      values: { Title: 'Ship it' },
    });
    for (const [sql] of mocks.poolQuery.mock.calls) {
      expect(String(sql).trimStart().startsWith('SELECT')).toBe(true);
    }
    expect(String(mocks.poolQuery.mock.calls[0]?.[0])).toContain('r.archived_at IS NULL');
  });

  it('queries with discriminated filters, tags, archive visibility, and parameterized pagination', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: properties };
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: '1' }] };
      if (sql.includes('FROM database_rows r')) return { rows: [row()] };
      if (sql.includes('FROM database_row_values')) return { rows: [storedValue()] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { queryRows } = await import('./rows.js');

    const result = await queryRows({
      database_id: 'db-1',
      filters: [
        { property: 'Title', operator: 'is_empty' },
        { property: 'Title', operator: 'contains', value: 'Ship' },
        { property: 'Labels', operator: 'contains', value: 'Agent' },
        { property: 'Amount', operator: 'gt', value: 2 },
      ],
      sort_by: 'Amount',
      sort_direction: 'desc',
      tags: ['active'],
      limit: 101,
      offset: 10,
    });

    expect(result.total).toBe(1);
    const countCall = mocks.poolQuery.mock.calls.find(([sql]) => String(sql).includes('SELECT COUNT(*)'));
    expect(String(countCall?.[0])).toContain('r.tags && $3::text[]');
    expect(String(countCall?.[0])).toContain('NOT EXISTS');
    expect(String(countCall?.[0])).toContain('STRPOS(LOWER(v.value_text::text), LOWER(');
    expect(String(countCall?.[0])).toContain('v.value_json ?');
    expect(String(countCall?.[0])).not.toContain('ILIKE');
    const rowCall = mocks.poolQuery.mock.calls.find(([sql]) =>
      String(sql).includes('ORDER BY') && String(sql).includes('FROM database_rows r')
    );
    expect(rowCall?.[1]?.slice(-2)).toEqual([101, 10]);
    expect(String(rowCall?.[0])).toContain('DESC NULLS LAST');
  });

  it('enforces the filter discriminant at runtime', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: [property()] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const invalid = { property: 'Title', operator: 'is_empty', value: 'x' } as unknown as RowFilter;
    const { queryRows } = await import('./rows.js');

    await expect(queryRows({ database_id: 'db-1', filters: [invalid] })).rejects.toThrow(
      'is_empty filters cannot include a value'
    );
    expect(mocks.poolQuery.mock.calls.some(([sql]) => String(sql).includes('SELECT COUNT(*)'))).toBe(false);
  });

  it('rejects filter operators and sorting that do not match property types', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: properties };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { queryRows } = await import('./rows.js');

    await expect(queryRows({
      database_id: 'db-1',
      filters: [{ property: 'Amount', operator: 'contains', value: '2' }],
    })).rejects.toThrow('contains is not supported for number');
    await expect(queryRows({
      database_id: 'db-1',
      filters: [{ property: 'Title', operator: 'gt', value: 'A' }],
    })).rejects.toThrow('gt is not supported for title');
    await expect(queryRows({
      database_id: 'db-1',
      sort_by: 'Labels',
    })).rejects.toThrow('multi_select properties cannot be used for sorting');
    expect(mocks.poolQuery.mock.calls.some(([sql]) => String(sql).includes('SELECT COUNT(*)'))).toBe(false);
  });

  it('rejects sort_direction without sort_by before querying', async () => {
    const { queryRows } = await import('./rows.js');

    await expect(queryRows({
      database_id: 'db-1',
      sort_direction: 'desc',
    })).rejects.toThrow('sort_direction requires sort_by');
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('rejects an empty row value patch before opening a transaction', async () => {
    const { updateRow } = await import('./rows.js');

    await expect(updateRow('row-1', { revision: 1, values: {} })).rejects.toThrow(
      'Row value updates must contain at least one property'
    );
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('revision-checks row updates before writing values', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql === 'SELECT database_id FROM database_rows WHERE id = $1') {
        return { rows: [{ database_id: 'db-1' }] };
      }
      if (sql.includes('FOR UPDATE OF r')) return { rows: [{ ...row(), workspace_id: 'ws-1' }] };
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: properties };
      if (sql.includes('UPDATE database_rows')) return { rows: [row({ revision: 2 })] };
      if (sql.includes('INSERT INTO database_row_values')) return { rows: [] };
      if (sql.includes('FROM database_row_values')) {
        return { rows: [storedValue(), storedValue({ property_id: 'prop-labels', value_text: null, value_json: null })] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { updateRow } = await import('./rows.js');

    await expect(updateRow('row-1', {
      revision: 1,
      values: { Labels: null },
    })).resolves.toMatchObject({ revision: 2, values: { Labels: null } });

    const updateCall = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE database_rows')
    );
    expect(String(updateCall?.[0])).toContain('revision = revision + 1');
    expect(updateCall?.[1]).toEqual(['row-1', 1]);
    const valueCall = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO database_row_values')
    );
    expect(valueCall?.[1]?.[6]).toBeNull();
    const statements = mocks.clientQuery.mock.calls.map(([sql]) => String(sql));
    const databaseLock = statements.findIndex((sql) =>
      sql.includes('FROM databases') && sql.includes('FOR SHARE')
    );
    const rowLock = statements.findIndex((sql) => sql.includes('FOR UPDATE OF r'));
    expect(databaseLock).toBeGreaterThan(-1);
    expect(rowLock).toBeGreaterThan(databaseLock);
  });

  it('rejects stale row updates before any row-value mutation', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql === 'SELECT database_id FROM database_rows WHERE id = $1') {
        return { rows: [{ database_id: 'db-1' }] };
      }
      if (sql.includes('FOR UPDATE OF r')) {
        return { rows: [{ ...row({ revision: 4 }), workspace_id: 'ws-1' }] };
      }
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('FROM database_properties')) return { rows: properties };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { updateRow } = await import('./rows.js');

    await expect(updateRow('row-1', {
      revision: 1,
      values: { Title: 'Stale' },
    })).rejects.toThrow('row row-1 is at revision 4, not 1');
    expect(mocks.clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO database_row_values')
    )).toBe(false);
  });

  it('archives and hydrates rows using the current revision', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql === 'SELECT database_id FROM database_rows WHERE id = $1') {
        return { rows: [{ database_id: 'db-1' }] };
      }
      if (sql.includes('FROM databases')) return { rows: [{ id: 'db-1', workspace_id: 'ws-1' }] };
      if (sql.includes('UPDATE database_rows')) {
        return { rows: [row({ revision: 2, archived_at: '2026-01-02T00:00:00.000Z' })] };
      }
      if (sql.includes('FROM database_properties')) return { rows: [property()] };
      if (sql.includes('FROM database_row_values')) return { rows: [storedValue()] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const { archiveRow } = await import('./rows.js');

    await expect(archiveRow('row-1', 1)).resolves.toMatchObject({
      revision: 2,
      archived_at: '2026-01-02T00:00:00.000Z',
    });
    const updateCall = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE database_rows')
    );
    expect(updateCall?.[1]).toEqual(['row-1', 'db-1', 1]);
    expect(String(updateCall?.[0])).toContain('archived_at IS NULL');
    const statements = mocks.clientQuery.mock.calls.map(([sql]) => String(sql));
    const databaseLock = statements.findIndex((sql) =>
      sql.includes('FROM databases') && sql.includes('FOR SHARE')
    );
    const rowMutation = statements.findIndex((sql) => sql.includes('UPDATE database_rows'));
    expect(databaseLock).toBeGreaterThan(-1);
    expect(rowMutation).toBeGreaterThan(databaseLock);
    expect(mocks.requireActiveWorkspace).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ query: mocks.clientQuery })
    );
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('allows the internal lookahead limit but rejects larger or fractional pagination', async () => {
    const { queryRows } = await import('./rows.js');

    await expect(queryRows({ database_id: 'db-1', limit: 102 })).rejects.toThrow(
      'limit must be an integer between 0 and 101'
    );
    await expect(queryRows({ database_id: 'db-1', offset: 1.5 })).rejects.toThrow(
      'offset must be an integer'
    );
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });
});
