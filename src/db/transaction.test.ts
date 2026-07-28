import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock('./client.js', () => ({
  getPool: () => ({ connect: mocks.connect }),
}));

import { withClientTransaction, withTransaction } from './transaction.js';

describe('PostgreSQL transaction lifecycle', () => {
  beforeEach(() => {
    mocks.connect.mockReset().mockResolvedValue({
      query: mocks.query,
      release: mocks.release,
    });
    mocks.query.mockReset().mockResolvedValue({ rows: [] });
    mocks.release.mockReset();
  });

  it('begins, commits exactly once after successful work, and releases the client', async () => {
    const work = vi.fn().mockResolvedValue('done');

    await expect(withTransaction(work)).resolves.toBe('done');

    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
    expect(work).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledWith();
  });

  it('renders isolation and access-mode options in the BEGIN statement', async () => {
    await withTransaction(async () => undefined, {
      isolationLevel: 'repeatable read',
      readOnly: true,
    });

    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'COMMIT',
    ]);
  });

  it('supports explicit read-write transactions', async () => {
    await withTransaction(async () => undefined, {
      isolationLevel: 'serializable',
      readOnly: false,
    });

    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE',
      'COMMIT',
    ]);
  });

  it('releases but does not roll back when BEGIN fails', async () => {
    const beginError = new Error('begin failed');
    mocks.query.mockRejectedValueOnce(beginError);
    const work = vi.fn();

    await expect(withTransaction(work)).rejects.toBe(beginError);

    expect(work).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledWith(beginError);
  });

  it('rolls back work failures and preserves the original error', async () => {
    const workError = new Error('work failed');

    await expect(withTransaction(async () => { throw workError; })).rejects.toBe(workError);

    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(mocks.release).toHaveBeenCalledWith();
  });

  it('rolls back a failed COMMIT without attempting a second commit', async () => {
    const commitError = new Error('commit failed');
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw commitError;
      return { rows: [] };
    });

    await expect(withTransaction(async () => 'worked')).rejects.toBe(commitError);

    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'COMMIT',
      'ROLLBACK',
    ]);
  });

  it('retains work and rollback failures and discards the unsafe client', async () => {
    const workError = new Error('work failed');
    const rollbackError = new Error('rollback failed');
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [] };
    });

    await expect(withTransaction(async () => { throw workError; })).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [workError, rollbackError],
    });
    expect(mocks.release).toHaveBeenCalledWith(rollbackError);
  });

  it('surfaces a release failure after successful work', async () => {
    const releaseError = new Error('release failed');
    mocks.release.mockImplementationOnce(() => { throw releaseError; });

    await expect(withTransaction(async () => 'worked')).rejects.toBe(releaseError);

    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('retains the original work error when release also fails', async () => {
    const workError = new Error('work failed');
    const releaseError = new Error('release failed');
    mocks.release.mockImplementationOnce(() => { throw releaseError; });

    await expect(withTransaction(async () => { throw workError; })).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [workError, releaseError],
    });

    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('retains work, rollback, and release failures in occurrence order', async () => {
    const workError = new Error('work failed');
    const rollbackError = new Error('rollback failed');
    const releaseError = new Error('release failed');
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [] };
    });
    mocks.release.mockImplementationOnce(() => { throw releaseError; });

    await expect(withTransaction(async () => { throw workError; })).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [workError, rollbackError, releaseError],
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('supports deliberate rollback and caller-owned clients without releasing them', async () => {
    const client = {
      query: mocks.query,
      release: mocks.release,
    } as never;

    await expect(withClientTransaction(client, async (_client, transaction) => {
      await transaction.rollback();
      return null;
    })).resolves.toBeNull();

    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('does not retry a failed deliberate rollback on a caller-owned client', async () => {
    const rollbackError = new Error('rollback failed');
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [] };
    });
    const client = {
      query: mocks.query,
      release: mocks.release,
    } as never;

    await expect(withClientTransaction(client, async (_client, transaction) => {
      await transaction.rollback();
    })).rejects.toBe(rollbackError);

    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
