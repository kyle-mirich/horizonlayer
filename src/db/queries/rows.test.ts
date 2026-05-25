import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientQueryMock = vi.fn();
const poolQueryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn();
const embedMock = vi.fn();
const vectorToSqlMock = vi.fn((vec: number[]) => `[${vec.join(',')}]`);

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
});
