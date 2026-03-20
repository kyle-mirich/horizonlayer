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
});
