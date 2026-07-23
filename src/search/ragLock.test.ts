import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../db/client.js', () => ({
  getPool: () => ({ connect: mocks.connect }),
}));

import { ragInternals } from './rag.js';

describe('RAG workspace lock lifecycle', () => {
  it('destroys a client whose session-level advisory lock cannot be released', async () => {
    const unlockError = new Error('connection lost during unlock');
    mocks.query
      .mockResolvedValueOnce({ rows: [{ pg_advisory_lock: null }] })
      .mockRejectedValueOnce(unlockError);
    mocks.connect.mockResolvedValueOnce({
      query: mocks.query,
      release: mocks.release,
    });

    await expect(ragInternals.runWithRagWorkspaceLock(
      '10000000-0000-4000-8000-000000000001',
      async () => 'indexed'
    )).rejects.toBe(unlockError);

    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledWith(unlockError);
  });
});
