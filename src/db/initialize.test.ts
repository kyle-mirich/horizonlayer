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
    mocks.readFileSync.mockReset().mockImplementation((path: string) =>
      path.endsWith('schema.sql') ? '-- canonical schema' : '-- v3 migration'
    );
    mocks.release.mockReset();
  });

  it('applies schema.sql under one transaction-scoped advisory lock for a fresh database', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('schema_migrations')) {
        return { rows: [{ migrations: null, workspaces: null }] };
      }
      return { rowCount: 0, rows: [] };
    });
    const { initializeDatabase } = await import('./initialize.js');

    await initializeDatabase();

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.readFileSync).toHaveBeenCalledWith(expect.stringMatching(/schema\.sql$/), 'utf8');
    expect(mocks.readFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/0002_issue_modules_v3\.sql$/),
      'utf8'
    );
    expect(mocks.clientQuery.mock.calls).toEqual([
      ['BEGIN'],
      ['SELECT pg_advisory_xact_lock($1)', [7_243_612_901]],
      ['SET LOCAL search_path = public, pg_catalog'],
      [expect.stringContaining("format('%I.schema_migrations', current_schema())")],
      ['-- canonical schema'],
      ['COMMIT'],
    ]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('migrates an existing unversioned database before applying the v3 schema', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('schema_migrations')) {
        return { rows: [{ migrations: null, workspaces: 'workspaces' }] };
      }
      return { rowCount: 0, rows: [] };
    });
    const { initializeDatabase } = await import('./initialize.js');

    await initializeDatabase();

    expect(mocks.clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock($1)',
      'SET LOCAL search_path = public, pg_catalog',
      expect.stringContaining("format('%I.schema_migrations', current_schema())"),
      '-- v3 migration',
      '-- canonical schema',
      'COMMIT',
    ]);
  });

  it('rolls back a failed schema application and releases the client', async () => {
    const schemaError = new Error('schema failed');
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === '-- canonical schema') throw schemaError;
      if (sql.includes('schema_migrations')) {
        return { rows: [{ migrations: null, workspaces: null }] };
      }
      return { rowCount: 0, rows: [] };
    });
    const { initializeDatabase } = await import('./initialize.js');

    await expect(initializeDatabase()).rejects.toBe(schemaError);

    expect(mocks.clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back a failed v2-to-v3 migration before the canonical schema is applied', async () => {
    const migrationError = new Error('migration failed');
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('schema_migrations')) {
        return { rows: [{ migrations: null, workspaces: 'workspaces' }] };
      }
      if (sql === '-- v3 migration') throw migrationError;
      return { rowCount: 0, rows: [] };
    });
    const { initializeDatabase } = await import('./initialize.js');

    await expect(initializeDatabase()).rejects.toBe(migrationError);

    expect(mocks.clientQuery).not.toHaveBeenCalledWith('-- canonical schema');
    expect(mocks.clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('does not check out a client when schema.sql cannot be loaded', async () => {
    const readError = new Error('schema missing');
    mocks.readFileSync.mockImplementation((path: string) => {
      if (path.endsWith('schema.sql')) throw readError;
      return '-- v3 migration';
    });
    const { initializeDatabase } = await import('./initialize.js');

    await expect(initializeDatabase()).rejects.toBe(readError);

    expect(mocks.clientQuery).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
