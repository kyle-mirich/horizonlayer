import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientQueryMock = vi.fn();
const poolQueryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn();
const embedMock = vi.fn();
const vectorToSqlMock = vi.fn((vec: number[]) => `[${vec.join(',')}]`);

function property(overrides: Partial<{
  id: string;
  name: string;
  position: number;
  property_type: string;
  is_required: boolean;
}> = {}) {
  return {
    id: overrides.id ?? 'title-prop',
    database_id: 'db-1',
    name: overrides.name ?? 'Title',
    options: {},
    position: overrides.position ?? 0,
    property_type: overrides.property_type ?? 'title',
    is_required: overrides.is_required ?? false,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function row(overrides: Partial<{
  id: string;
  database_id: string;
}> = {}) {
  return {
    id: overrides.id ?? 'row-1',
    database_id: overrides.database_id ?? 'db-1',
    tags: [],
    source: null,
    importance: 0.5,
    expires_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    last_accessed_at: '2026-01-03T00:00:00.000Z',
  };
}

vi.mock('../client.js', () => ({
  getPool: () => ({
    connect: connectMock,
    query: poolQueryMock,
  }),
}));

vi.mock('../../embeddings/index.js', () => ({
  embed: embedMock,
  vectorToSql: vectorToSqlMock,
}));

describe('row query and indexing', () => {
  beforeEach(() => {
    clientQueryMock.mockReset();
    poolQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockReset();
    embedMock.mockReset();
    vectorToSqlMock.mockClear();

    connectMock.mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock,
    });
  });

  it('casts numeric contains filters to text', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const { queryRows } = await import('./rows.js');
    await queryRows({
      database_id: 'db-1',
      filters: [
        {
          property: 'Amount',
          operator: 'contains',
          value: '42',
        },
      ],
      properties: [
        {
          id: 'prop-1',
          database_id: 'db-1',
          name: 'Amount',
          options: {},
          position: 0,
          property_type: 'number',
          is_required: false,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(poolQueryMock.mock.calls[0]?.[0]).toContain('value_number::text ILIKE');
  });

  it('treats string false checkbox filters as false instead of truthy', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const { queryRows } = await import('./rows.js');
    await queryRows({
      database_id: 'db-1',
      filters: [
        {
          property: 'Done',
          operator: 'eq',
          value: 'false',
        },
      ],
      properties: [
        {
          id: 'prop-1',
          database_id: 'db-1',
          name: 'Done',
          options: {},
          position: 0,
          property_type: 'checkbox',
          is_required: false,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual(['db-1', 'prop-1', false]);
  });

  it('rebuilds embeddings from the full stored row after partial updates', async () => {
    clientQueryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    embedMock.mockResolvedValue([0.1, 0.2, 0.3]);

    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT * FROM database_row_values WHERE row_id = $1') {
        return {
          rows: [
            {
              id: 'value-1',
              row_id: 'row-1',
              property_id: 'title-prop',
              value_text: 'Updated title',
              value_number: null,
              value_date: null,
              value_bool: null,
              value_json: null,
            },
            {
              id: 'value-2',
              row_id: 'row-1',
              property_id: 'desc-prop',
              value_text: 'Existing body',
              value_number: null,
              value_date: null,
              value_bool: null,
              value_json: null,
            },
          ],
        };
      }

      if (sql === 'UPDATE database_rows SET embedding = $1 WHERE id = $2') {
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes('UPDATE database_rows SET last_accessed_at = NOW()')) {
        return {
          rows: [
            {
              id: 'row-1',
              database_id: 'db-1',
              tags: [],
              source: null,
              importance: 0.5,
              expires_at: null,
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-02T00:00:00.000Z',
              last_accessed_at: '2026-01-03T00:00:00.000Z',
            },
          ],
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    });

    const { updateRow } = await import('./rows.js');
    await updateRow('row-1', {
      values: {
        Title: 'Updated title',
      },
      properties: [
        {
          id: 'title-prop',
          database_id: 'db-1',
          name: 'Title',
          options: {},
          position: 0,
          property_type: 'title',
          is_required: true,
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'desc-prop',
          database_id: 'db-1',
          name: 'Description',
          options: {},
          position: 1,
          property_type: 'text',
          is_required: false,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(embedMock).toHaveBeenCalledWith('Updated title\nExisting body');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('rejects stale optimistic updates before mutating row values', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('UPDATE database_rows SET')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        throw new Error('row values should not be written after a stale update');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT updated_at FROM database_rows WHERE id = $1') {
        return {
          rows: [{ updated_at: '2026-01-03T00:00:00.000Z' }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { updateRow } = await import('./rows.js');
    await expect(updateRow('row-1', {
      values: {
        Title: 'Updated title',
      },
      properties: [
        {
          id: 'title-prop',
          database_id: 'db-1',
          name: 'Title',
          options: {},
          position: 0,
          property_type: 'title',
          is_required: true,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      expected_updated_at: '2026-01-02T00:00:00.000Z',
    })).rejects.toThrow('Conflict: row row-1 was modified by another agent');

    expect(releaseMock).toHaveBeenCalled();
  });

  it('returns null without mutating values when the row no longer exists', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('UPDATE database_rows SET')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        throw new Error('row values should not be written after a missing-row update');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT updated_at FROM database_rows WHERE id = $1') {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { updateRow } = await import('./rows.js');
    await expect(updateRow('row-1', {
      values: {
        Title: 'Updated title',
      },
      properties: [
        {
          id: 'title-prop',
          database_id: 'db-1',
          name: 'Title',
          options: {},
          position: 0,
          property_type: 'title',
          is_required: true,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      expected_updated_at: '2026-01-02T00:00:00.000Z',
    })).resolves.toBeNull();

    expect(releaseMock).toHaveBeenCalled();
  });

  it('updates row tags and importance without rebuilding embeddings when values are unchanged', async () => {
    const updateCalls: unknown[][] = [];
    clientQueryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('UPDATE database_rows SET')) {
        updateCalls.push(values ?? []);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        throw new Error('metadata-only update should not touch row values');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE database_rows SET last_accessed_at = NOW()')) {
        return { rows: [row()] };
      }
      if (sql === 'SELECT * FROM database_row_values WHERE row_id = $1') {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { updateRow } = await import('./rows.js');
    await expect(updateRow('row-1', {
      tags: ['agent', 'fresh-context'],
      importance: 0.9,
      properties: [property({ is_required: true })],
    })).resolves.toMatchObject({ id: 'row-1' });

    expect(updateCalls).toEqual([[['agent', 'fresh-context'], 0.9, 'row-1']]);
    expect(embedMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalled();
  });

  it('rejects null required properties on update before opening a transaction', async () => {
    const { updateRow } = await import('./rows.js');
    await expect(updateRow('row-1', {
      values: { Title: null },
      properties: [property({ name: 'Title', is_required: true })],
    })).rejects.toThrow('Missing required properties: Title');

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rolls back row updates when a value write fails', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'COMMIT') {
        throw new Error('row update should not commit after a value write fails');
      }
      if (sql.startsWith('UPDATE database_rows SET')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        throw new Error('value write failed');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { updateRow } = await import('./rows.js');
    await expect(updateRow('row-1', {
      values: { Title: 'Updated' },
      properties: [property({ is_required: true })],
    })).rejects.toThrow('value write failed');

    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('keeps successful row creation when embedding refresh fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO database_rows')) {
        return { rows: [row()] };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE database_rows SET last_accessed_at = NOW()')) {
        return { rows: [row()] };
      }
      if (sql === 'SELECT * FROM database_row_values WHERE row_id = $1') {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    embedMock.mockRejectedValueOnce(new Error('embedding unavailable'));

    const { createRow } = await import('./rows.js');
    await expect(createRow({
      database_id: 'db-1',
      properties: [property({ is_required: true })],
      values: { Title: 'Still created' },
    })).resolves.toMatchObject({ id: 'row-1' });

    expect(consoleError).toHaveBeenCalledWith(
      'Failed to update row embedding for row-1:',
      expect.any(Error)
    );
    consoleError.mockRestore();
  });

  it('rejects unknown properties before opening a write transaction', async () => {
    const { createRow } = await import('./rows.js');
    await expect(
      createRow({
        database_id: 'db-1',
        values: {
          Unknown: 'value',
        },
        properties: [
          {
            id: 'title-prop',
            database_id: 'db-1',
            name: 'Title',
            options: {},
            position: 0,
            property_type: 'title',
            is_required: true,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    ).rejects.toThrow('Unknown properties: Unknown');

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rejects missing required properties on create', async () => {
    const { createRow } = await import('./rows.js');
    await expect(
      createRow({
        database_id: 'db-1',
        values: {},
        properties: [
          {
            id: 'title-prop',
            database_id: 'db-1',
            name: 'Title',
            options: {},
            position: 0,
            property_type: 'title',
            is_required: true,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    ).rejects.toThrow('Missing required properties: Title');

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('creates a row, indexes title text, and returns hydrated values', async () => {
    const properties = [
      property({ id: 'title-prop', name: 'Title', property_type: 'title', is_required: true }),
      property({ id: 'done-prop', name: 'Done', property_type: 'checkbox' }),
    ];
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO database_rows')) {
        return { rows: [row()] };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'UPDATE database_rows SET embedding = $1 WHERE id = $2') {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE database_rows SET last_accessed_at = NOW()')) {
        return { rows: [row()] };
      }
      if (sql === 'SELECT * FROM database_row_values WHERE row_id = $1') {
        return {
          rows: [
            {
              id: 'value-1',
              property_id: 'title-prop',
              row_id: 'row-1',
              value_bool: null,
              value_date: null,
              value_json: null,
              value_number: null,
              value_text: 'Ship it',
            },
            {
              id: 'value-2',
              property_id: 'done-prop',
              row_id: 'row-1',
              value_bool: true,
              value_date: null,
              value_json: null,
              value_number: null,
              value_text: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    embedMock.mockResolvedValue([0.4, 0.5]);

    const { createRow } = await import('./rows.js');
    const created = await createRow({
      database_id: 'db-1',
      properties,
      values: {
        Done: true,
        Title: 'Ship it',
      },
    });

    expect(created.values).toEqual({
      Done: true,
      Title: 'Ship it',
    });
    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).toContain('COMMIT');
    expect(embedMock).toHaveBeenCalledWith('Ship it');
    expect(poolQueryMock).toHaveBeenCalledWith(
      'UPDATE database_rows SET embedding = $1 WHERE id = $2',
      ['[0.4,0.5]', 'row-1']
    );
  });

  it('stores every supported row value type in its typed column', async () => {
    const properties = [
      property({ id: 'title-prop', name: 'Title', property_type: 'title' }),
      property({ id: 'number-prop', name: 'Amount', property_type: 'number' }),
      property({ id: 'date-prop', name: 'Due', property_type: 'date' }),
      property({ id: 'checkbox-prop', name: 'Done', property_type: 'checkbox' }),
      property({ id: 'select-prop', name: 'Status', property_type: 'select' }),
      property({ id: 'unknown-prop', name: 'Custom', property_type: 'custom' }),
    ];
    const valueInserts: unknown[][] = [];
    clientQueryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO database_rows')) {
        return { rows: [row()] };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        valueInserts.push(values ?? []);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'UPDATE database_rows SET embedding = $1 WHERE id = $2') {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE database_rows SET last_accessed_at = NOW()')) {
        return { rows: [row()] };
      }
      if (sql === 'SELECT * FROM database_row_values WHERE row_id = $1') {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    embedMock.mockResolvedValue([0.2, 0.3]);

    const { createRow } = await import('./rows.js');
    await createRow({
      database_id: 'db-1',
      properties,
      values: {
        Amount: '42.5',
        Custom: 123,
        Done: 'true',
        Due: '2026-02-03T00:00:00.000Z',
        Status: { name: 'Ready' },
        Title: 'Typed row',
      },
    });

    expect(valueInserts).toEqual([
      ['row-1', 'title-prop', 'Typed row', null, null, null, null],
      ['row-1', 'number-prop', null, 42.5, null, null, null],
      ['row-1', 'date-prop', null, null, '2026-02-03T00:00:00.000Z', null, null],
      ['row-1', 'checkbox-prop', null, null, null, true, null],
      ['row-1', 'select-prop', null, null, null, null, '{"name":"Ready"}'],
      ['row-1', 'unknown-prop', '123', null, null, null, null],
    ]);
  });

  it('throws when a created row cannot be hydrated after commit', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO database_rows')) {
        return { rows: [row()] };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'UPDATE database_rows SET embedding = $1 WHERE id = $2') {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE database_rows SET last_accessed_at = NOW()')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    embedMock.mockResolvedValue([0.4, 0.5]);

    const { createRow } = await import('./rows.js');
    await expect(createRow({
      database_id: 'db-1',
      properties: [property({ is_required: true })],
      values: { Title: 'Missing after create' },
    })).rejects.toThrow('Row row-1 not found after creation');
  });

  it('rejects invalid numeric values before writing row data', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO database_rows')) {
        return {
          rows: [{
            id: 'row-1',
            database_id: 'db-1',
            tags: [],
            source: null,
            importance: 0.5,
            expires_at: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            last_accessed_at: '2026-01-01T00:00:00.000Z',
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { createRow } = await import('./rows.js');
    await expect(
      createRow({
        database_id: 'db-1',
        values: {
          Amount: 'NaNish',
        },
        properties: [
          {
            id: 'amount-prop',
            database_id: 'db-1',
            name: 'Amount',
            options: {},
            position: 0,
            property_type: 'number',
            is_required: false,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    ).rejects.toThrow('Property Amount must be a finite number');

    expect(releaseMock).toHaveBeenCalled();
  });

  it('rejects invalid checkbox values before writing row data', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO database_rows')) {
        return { rows: [row()] };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        throw new Error('invalid checkbox should not be written');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { createRow } = await import('./rows.js');
    await expect(createRow({
      database_id: 'db-1',
      properties: [property({ id: 'done-prop', name: 'Done', property_type: 'checkbox' })],
      values: { Done: 'sometimes' },
    })).rejects.toThrow('Property Done must be a boolean');

    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('rejects invalid checkbox query filters before issuing SQL', async () => {
    const { queryRows } = await import('./rows.js');

    await expect(queryRows({
      database_id: 'db-1',
      filters: [{ property: 'Done', operator: 'eq', value: 'sometimes' }],
      properties: [property({ id: 'done-prop', name: 'Done', property_type: 'checkbox' })],
    })).rejects.toThrow('Property filter must be a boolean');

    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('rejects unknown query filters before issuing SQL', async () => {
    const { queryRows } = await import('./rows.js');

    await expect(
      queryRows({
        database_id: 'db-1',
        filters: [{ property: 'Missing', operator: 'eq', value: 'ready' }],
        properties: [
          {
            id: 'title-prop',
            database_id: 'db-1',
            name: 'Title',
            options: {},
            position: 0,
            property_type: 'title',
            is_required: false,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    ).rejects.toThrow('Unknown filter properties: Missing');

    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('rejects unknown sort properties before issuing SQL', async () => {
    const { queryRows } = await import('./rows.js');

    await expect(
      queryRows({
        database_id: 'db-1',
        properties: [
          {
            id: 'title-prop',
            database_id: 'db-1',
            name: 'Title',
            options: {},
            position: 0,
            property_type: 'title',
            is_required: false,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
        sort_by: 'Missing',
      })
    ).rejects.toThrow('Unknown sort property: Missing');

    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('looks up the database id for a row with system access', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ database_id: 'db-1' }] });

    const { getRowDatabaseId } = await import('./rows.js');
    await expect(getRowDatabaseId('row-1')).resolves.toBe('db-1');

    expect(poolQueryMock).toHaveBeenCalledWith(
      'SELECT database_id FROM database_rows WHERE id = $1',
      ['row-1']
    );
  });

  it('returns false when deleting a missing row without a stale-write conflict', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { deleteRow } = await import('./rows.js');
    await expect(deleteRow('row-1')).resolves.toBe(false);

    expect(poolQueryMock).toHaveBeenCalledWith('DELETE FROM database_rows WHERE id = $1', ['row-1']);
  });

  it('throws a conflict when a stale delete misses an existing row', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [{ updated_at: '2026-01-03T00:00:00.000Z' }] });

    const { deleteRow } = await import('./rows.js');
    await expect(deleteRow(
      'row-1',
      { kind: 'system' },
      '2026-01-02T00:00:00.000Z'
    )).rejects.toThrow('Conflict: row row-1 was modified by another agent');
  });

  it('rejects fractional query pagination before issuing SQL', async () => {
    const { queryRows } = await import('./rows.js');

    await expect(
      queryRows({
        database_id: 'db-1',
        limit: 1.5,
        offset: 0,
        properties: [],
      })
    ).rejects.toThrow('limit must be a non-negative integer');

    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('counts rows by using zero-limit pagination without fetching values', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [] });

    const { countRows } = await import('./rows.js');
    await expect(countRows({
      database_id: 'db-1',
      properties: [],
    })).resolves.toBe(3);

    expect(poolQueryMock.mock.calls[1]?.[0]).toContain('LIMIT $2 OFFSET $3');
    expect(poolQueryMock.mock.calls[1]?.[1]).toEqual(['db-1', 0, 0]);
  });

  it('queries sorted rows and hydrates typed row values', async () => {
    const properties = [
      property({ id: 'title-prop', name: 'Title', property_type: 'title' }),
      property({ id: 'amount-prop', name: 'Amount', property_type: 'number' }),
      property({ id: 'status-prop', name: 'Status', property_type: 'select' }),
    ];
    poolQueryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT COUNT(*) AS count')) {
        return { rows: [{ count: '2' }] };
      }
      if (sql.includes('SELECT r.* FROM database_rows')) {
        return { rows: [row({ id: 'row-1' }), row({ id: 'row-2' })] };
      }
      if (sql === 'SELECT * FROM database_row_values WHERE row_id = ANY($1)') {
        expect(values).toEqual([['row-1', 'row-2']]);
        return {
          rows: [
            {
              id: 'value-1',
              property_id: 'title-prop',
              row_id: 'row-1',
              value_bool: null,
              value_date: null,
              value_json: null,
              value_number: null,
              value_text: 'First',
            },
            {
              id: 'value-2',
              property_id: 'amount-prop',
              row_id: 'row-1',
              value_bool: null,
              value_date: null,
              value_json: null,
              value_number: 7,
              value_text: null,
            },
            {
              id: 'value-3',
              property_id: 'status-prop',
              row_id: 'row-2',
              value_bool: null,
              value_date: null,
              value_json: { name: 'Done' },
              value_number: null,
              value_text: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { queryRows } = await import('./rows.js');
    const result = await queryRows({
      database_id: 'db-1',
      filters: [
        { property: 'Amount', operator: 'gt', value: '5' },
        { property: 'Status', operator: 'contains', value: 'Done' },
        { property: 'Title', operator: 'is_empty' },
      ],
      limit: 10,
      offset: 5,
      properties,
      sort_by: 'Amount',
    });

    expect(result).toEqual({
      rows: [
        { ...row({ id: 'row-1' }), values: { Amount: 7, Title: 'First' } },
        { ...row({ id: 'row-2' }), values: { Status: { name: 'Done' } } },
      ],
      total: 2,
    });
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual([
      'db-1',
      'amount-prop',
      5,
      'status-prop',
      '%Done%',
      'title-prop',
    ]);
    expect(poolQueryMock.mock.calls[1]?.[0]).toContain('ORDER BY (SELECT value_number');
    expect(poolQueryMock.mock.calls[1]?.[1]).toEqual([
      'db-1',
      'amount-prop',
      5,
      'status-prop',
      '%Done%',
      'title-prop',
      'amount-prop',
      10,
      5,
    ]);
  });

  it('coerces date and json filters into SQL-safe typed comparisons', async () => {
    const properties = [
      property({ id: 'due-prop', name: 'Due', property_type: 'date' }),
      property({ id: 'status-prop', name: 'Status', property_type: 'select' }),
    ];
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const { queryRows } = await import('./rows.js');
    await expect(queryRows({
      database_id: 'db-1',
      filters: [
        { property: 'Due', operator: 'contains', value: '2026' },
        { property: 'Status', operator: 'eq', value: { name: 'Ready' } },
      ],
      properties,
    })).resolves.toEqual({ rows: [], total: 0 });

    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('value_date::text ILIKE');
    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain('value_json = $5');
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual([
      'db-1',
      'due-prop',
      '%2026%',
      'status-prop',
      '{"name":"Ready"}',
    ]);
  });

  it('validates every bulk row before opening a transaction', async () => {
    const { bulkCreateRows } = await import('./rows.js');

    await expect(
      bulkCreateRows({
        database_id: 'db-1',
        rows: [
          { values: { Title: 'Valid' } },
          { values: { Missing: 'Invalid' } },
        ],
        properties: [
          {
            id: 'title-prop',
            database_id: 'db-1',
            name: 'Title',
            options: {},
            position: 0,
            property_type: 'title',
            is_required: true,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    ).rejects.toThrow('Unknown properties: Missing');

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rolls back the entire bulk insert when any row insert fails', async () => {
    let nextRow = 1;
    clientQueryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'COMMIT') {
        throw new Error('bulk insert should not commit after one row fails');
      }
      if (sql.includes('INSERT INTO database_rows')) {
        const rowId = `row-${nextRow++}`;
        return {
          rows: [{
            id: rowId,
            database_id: 'db-1',
            tags: [],
            source: null,
            importance: 0.5,
            expires_at: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            last_accessed_at: '2026-01-01T00:00:00.000Z',
          }],
        };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        if (values?.[0] === 'row-2') {
          throw new Error('value insert failed');
        }
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { bulkCreateRows } = await import('./rows.js');
    await expect(
      bulkCreateRows({
        database_id: 'db-1',
        rows: [
          { values: { Title: 'One' } },
          { values: { Title: 'Two' } },
        ],
        properties: [
          {
            id: 'title-prop',
            database_id: 'db-1',
            name: 'Title',
            options: {},
            position: 0,
            property_type: 'title',
            is_required: true,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    ).rejects.toThrow('value insert failed');

    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('bulk creates rows, updates embeddings, and returns hydrated rows in order', async () => {
    const properties = [
      property({ id: 'title-prop', name: 'Title', property_type: 'title', is_required: true }),
    ];
    let nextRow = 1;
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO database_rows')) {
        return { rows: [row({ id: `row-${nextRow++}` })] };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    poolQueryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql === 'UPDATE database_rows SET embedding = $1 WHERE id = $2') {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE database_rows SET last_accessed_at = NOW()')) {
        return { rows: [row({ id: String(values?.[0]) })] };
      }
      if (sql === 'SELECT * FROM database_row_values WHERE row_id = $1') {
        const rowId = String(values?.[0]);
        return {
          rows: [{
            id: `value-${rowId}`,
            property_id: 'title-prop',
            row_id: rowId,
            value_bool: null,
            value_date: null,
            value_json: null,
            value_number: null,
            value_text: rowId === 'row-1' ? 'One' : 'Two',
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    embedMock.mockResolvedValue([0.1, 0.2]);

    const { bulkCreateRows } = await import('./rows.js');
    const created = await bulkCreateRows({
      database_id: 'db-1',
      properties,
      rows: [
        { values: { Title: 'One' } },
        { values: { Title: 'Two' } },
      ],
    });

    expect(created.map((createdRow) => createdRow.id)).toEqual(['row-1', 'row-2']);
    expect(created.map((createdRow) => createdRow.values.Title)).toEqual(['One', 'Two']);
    expect(embedMock).toHaveBeenCalledWith('One');
    expect(embedMock).toHaveBeenCalledWith('Two');
    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).toContain('COMMIT');
  });

  it('throws when a bulk-created row cannot be hydrated after commit', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO database_rows')) {
        return { rows: [row()] };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'UPDATE database_rows SET embedding = $1 WHERE id = $2') {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE database_rows SET last_accessed_at = NOW()')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    embedMock.mockResolvedValue([0.1, 0.2]);

    const { bulkCreateRows } = await import('./rows.js');
    await expect(bulkCreateRows({
      database_id: 'db-1',
      properties: [property({ is_required: true })],
      rows: [{ values: { Title: 'One' } }],
    })).rejects.toThrow('Row row-1 not found after bulk creation');
  });

  it('sets row embedding to null when indexed values have no text', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO database_rows')) {
        return { rows: [row()] };
      }
      if (sql.includes('INSERT INTO database_row_values')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'UPDATE database_rows SET embedding = NULL WHERE id = $1') {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE database_rows SET last_accessed_at = NOW()')) {
        return { rows: [row()] };
      }
      if (sql === 'SELECT * FROM database_row_values WHERE row_id = $1') {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { createRow } = await import('./rows.js');
    await createRow({
      database_id: 'db-1',
      properties: [property({ id: 'amount-prop', name: 'Amount', property_type: 'number' })],
      values: { Amount: 1 },
    });

    expect(embedMock).not.toHaveBeenCalled();
    expect(poolQueryMock).toHaveBeenCalledWith(
      'UPDATE database_rows SET embedding = NULL WHERE id = $1',
      ['row-1']
    );
  });

  it('deletes links that point at expired pages and rows before deleting the records', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('DELETE FROM links')) {
        return { rows: [], rowCount: 4 };
      }
      if (sql.includes('DELETE FROM pages')) {
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes('DELETE FROM database_rows')) {
        return { rows: [], rowCount: 3 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { cleanupExpired } = await import('./rows.js');
    const result = await cleanupExpired();

    expect(result).toEqual({ pages_deleted: 2, rows_deleted: 3 });
    const calls = clientQueryMock.mock.calls.map(([sql]) => String(sql));
    expect(calls.findIndex((sql) => sql.includes('DELETE FROM links'))).toBeLessThan(
      calls.findIndex((sql) => sql.includes('DELETE FROM pages'))
    );
    expect(releaseMock).toHaveBeenCalled();
  });

  it('rolls back expired cleanup when row deletion fails', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('DELETE FROM links')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM pages')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM database_rows')) {
        throw new Error('row delete failed');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { cleanupExpired } = await import('./rows.js');
    await expect(cleanupExpired()).rejects.toThrow('row delete failed');

    expect(clientQueryMock.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(releaseMock).toHaveBeenCalled();
  });
});
