import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    query: poolQueryMock,
  }),
}));

describe('database query guards', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
  });

  it('throws a clear not-found error before inserting a property into a missing database', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE databases') && sql.includes('RETURNING id')) {
        return { rows: [] };
      }
      if (sql === 'SELECT updated_at FROM databases WHERE id = $1') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO database_properties')) {
        throw new Error('property insert should not run for a missing database');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { addDatabaseProperty } = await import('./databases.js');
    await expect(addDatabaseProperty('db-1', {
      name: 'Status',
      type: 'text',
    })).rejects.toThrow('Database db-1 not found');
  });

  it('stops before inserting a property when optimistic concurrency fails', async () => {
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE databases') && sql.includes('RETURNING id')) {
        return { rows: [] };
      }
      if (sql === 'SELECT updated_at FROM databases WHERE id = $1') {
        return {
          rows: [{ updated_at: '2026-01-03T00:00:00.000Z' }],
        };
      }
      if (sql.includes('INSERT INTO database_properties')) {
        throw new Error('property insert should not run after a stale optimistic update');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { addDatabaseProperty } = await import('./databases.js');
    await expect(addDatabaseProperty('db-1', {
      name: 'Status',
      type: 'text',
      expected_updated_at: '2026-01-02T00:00:00.000Z',
    })).rejects.toThrow('Conflict: database db-1 was modified by another agent');
  });
});
