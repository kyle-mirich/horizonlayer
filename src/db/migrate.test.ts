import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const clientQueryMock = vi.fn();
const releaseMock = vi.fn();

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

vi.mock('./client.js', () => ({
  getPool: () => ({
    connect: vi.fn(async () => ({
      query: clientQueryMock,
      release: releaseMock,
    })),
    query: poolQueryMock,
  }),
}));

describe('migration runner', () => {
  beforeEach(() => {
    poolQueryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    clientQueryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    releaseMock.mockReset();
  });

  it('serializes migration runs with a database advisory lock', async () => {
    const { runMigrations } = await import('./migrate.js');
    await runMigrations();

    const sqlCalls = poolQueryMock.mock.calls.map(([sql]) => String(sql));
    expect(sqlCalls.some((sql) => sql.includes('pg_advisory_lock'))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes('pg_advisory_unlock'))).toBe(true);
    expect(sqlCalls.findIndex((sql) => sql.includes('pg_advisory_lock'))).toBeLessThan(
      sqlCalls.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS _migrations'))
    );
  });
});
