import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientQueryMock = vi.fn();
const poolQueryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    connect: connectMock,
    query: poolQueryMock,
  }),
}));

describe('database query guards', () => {
  beforeEach(() => {
    clientQueryMock.mockReset();
    poolQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockReset().mockResolvedValue({
      query: clientQueryMock,
      release: releaseMock,
    });
  });

  it('rejects duplicate property names on create before opening a transaction', async () => {
    const { createDatabase } = await import('./databases.js');

    await expect(
      createDatabase({
        name: 'Projects',
        properties: [
          { name: 'Status', type: 'text' },
          { name: 'status', type: 'select' },
        ],
      })
    ).rejects.toThrow('Duplicate database property names: status');

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate property names when adding a property', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE databases') && sql.includes('RETURNING id')) {
        return { rows: [{ id: 'db-1' }] };
      }
      if (sql.includes('FROM database_properties') && sql.includes('LOWER(name)')) {
        return { rows: [{ id: 'prop-1' }] };
      }
      if (sql.includes('INSERT INTO database_properties')) {
        throw new Error('duplicate property should not be inserted');
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { addDatabaseProperty } = await import('./databases.js');
    await expect(
      addDatabaseProperty('db-1', {
        name: 'Status',
        type: 'text',
      })
    ).rejects.toThrow('Property Status already exists in database db-1');

    expect(releaseMock).toHaveBeenCalled();
  });

  it('throws a clear not-found error before inserting a property into a missing database', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE databases') && sql.includes('RETURNING id')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO database_properties')) {
        throw new Error('property insert should not run for a missing database');
      }
      throw new Error(`Unexpected client query: ${sql}`);
    });
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT updated_at FROM databases WHERE id = $1') {
        return { rows: [] };
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
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE databases') && sql.includes('RETURNING id')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO database_properties')) {
        throw new Error('property insert should not run after a stale optimistic update');
      }
      throw new Error(`Unexpected client query: ${sql}`);
    });
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT updated_at FROM databases WHERE id = $1') {
        return {
          rows: [{ updated_at: '2026-01-03T00:00:00.000Z' }],
        };
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
