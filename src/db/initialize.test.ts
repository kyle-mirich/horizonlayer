import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  connect: vi.fn(),
  readFileSync: vi.fn(),
  release: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: mocks.readFileSync,
}));

vi.mock('./client.js', () => ({
  getPool: () => ({ connect: mocks.connect }),
}));

describe('database initializer', () => {
  beforeEach(() => {
    mocks.clientQuery.mockReset().mockResolvedValue({ rowCount: 0, rows: [] });
    mocks.connect.mockReset().mockResolvedValue({
      query: mocks.clientQuery,
      release: mocks.release,
    });
    mocks.readFileSync.mockReset().mockReturnValue('-- canonical schema');
    mocks.release.mockReset();
  });

  it('applies schema.sql under one transaction-scoped advisory lock', async () => {
    const { initializeDatabase } = await import('./initialize.js');

    await initializeDatabase();

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.readFileSync).toHaveBeenCalledWith(expect.stringMatching(/schema\.sql$/), 'utf8');
    expect(mocks.clientQuery.mock.calls).toEqual([
      ['BEGIN'],
      ['SELECT pg_advisory_xact_lock($1)', [7_243_612_901]],
      ['SET LOCAL search_path = public, pg_catalog'],
      ['-- canonical schema'],
      ['COMMIT'],
    ]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back a failed schema application and releases the client', async () => {
    const schemaError = new Error('schema failed');
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === '-- canonical schema') throw schemaError;
      return { rowCount: 0, rows: [] };
    });
    const { initializeDatabase } = await import('./initialize.js');

    await expect(initializeDatabase()).rejects.toBe(schemaError);

    expect(mocks.clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('releases the client when schema.sql cannot be loaded', async () => {
    const readError = new Error('schema missing');
    mocks.readFileSync.mockImplementation(() => {
      throw readError;
    });
    const { initializeDatabase } = await import('./initialize.js');

    await expect(initializeDatabase()).rejects.toBe(readError);

    expect(mocks.clientQuery).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
