import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../db/client.js', () => ({
  getPool: () => ({ connect: mocks.connect }),
}));

import {
  loadRagCorpus,
  loadRagGeneration,
  loadRagPoints,
  withRagWorkspaceLock,
} from './rag.js';

const workspaceId = '10000000-0000-4000-8000-000000000001';

function pageRow() {
  return {
    page_id: '20000000-0000-4000-8000-000000000001',
    workspace_id: workspaceId,
    session_id: null,
    page_title: 'Page source',
    page_tags: ['source'],
    page_importance: 0.8,
    page_revision: 1,
    page_updated_at: '2026-07-16T00:00:00.000Z',
    block_id: null,
    block_type: null,
    block_content: null,
    block_position: null,
    block_revision: null,
  };
}

function rowSource() {
  return {
    row_id: '30000000-0000-4000-8000-000000000001',
    workspace_id: workspaceId,
    database_id: '40000000-0000-4000-8000-000000000001',
    database_name: 'Records',
    database_description: null,
    database_revision: 1,
    row_tags: [],
    row_importance: 0.5,
    row_revision: 1,
    row_updated_at: '2026-07-16T00:00:00.000Z',
    property_id: '50000000-0000-4000-8000-000000000001',
    property_name: 'Name',
    property_type: 'title',
    property_position: 0,
    property_revision: 1,
    value_text: 'Row source',
    value_number: null,
    value_date: null,
    value_bool: null,
    value_json: null,
  };
}

describe('RAG PostgreSQL loading coverage cases', () => {
  beforeEach(() => {
    mocks.connect.mockReset();
    mocks.query.mockReset();
    mocks.release.mockReset();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  });

  it('loads a generation with a dedicated client and releases it', async () => {
    mocks.query.mockResolvedValue({ rows: [{ search_generation: '12' }] });

    await expect(loadRagGeneration(workspaceId)).resolves.toBe('12');
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('workspace_search_changes'), [workspaceId]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('returns a sorted canonical corpus and supports selected source snapshots', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('workspace_search_changes')) return { rows: [{ search_generation: '13' }] };
      if (sql.includes('FROM pages p')) return { rows: [pageRow()] };
      if (sql.includes('FROM database_rows r')) return { rows: [rowSource()] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(loadRagCorpus(workspaceId)).resolves.toMatchObject({
      generation: '13',
      points: [
        expect.objectContaining({ source_type: 'page' }),
        expect.objectContaining({ source_type: 'row' }),
      ],
    });
    const selected = await loadRagPoints(workspaceId, {
      page_ids: ['20000000-0000-4000-8000-000000000001'],
      row_ids: ['30000000-0000-4000-8000-000000000001'],
    });
    expect(selected.points).toHaveLength(2);
    const selectedSql = mocks.query.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes('ANY($2::uuid[])'));
    expect(selectedSql).toHaveLength(2);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it('does not query either source table for an explicitly empty selected snapshot', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('workspace_search_changes')) return { rows: [{ search_generation: '14' }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(loadRagPoints(workspaceId, { page_ids: [], row_ids: [] })).resolves.toEqual({
      generation: '14',
      points: [],
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('FROM pages p'))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('FROM database_rows r'))).toBe(false);
  });

  it('rolls back and releases a failed repeatable-read snapshot', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('workspace_search_changes')) throw new Error('read failed');
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(loadRagCorpus(workspaceId)).rejects.toThrow('read failed');
    expect(mocks.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('runs work with a contextual client while holding and then releasing its advisory lock', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_lock')) return { rows: [{ pg_advisory_lock: null }] };
      if (sql.includes('workspace_search_changes')) return { rows: [{ search_generation: '15' }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(withRagWorkspaceLock(workspaceId, () => loadRagGeneration(workspaceId))).resolves.toBe('15');
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.map(([sql]) => String(sql))).toEqual(expect.arrayContaining([
      expect.stringContaining('pg_advisory_lock'),
      expect.stringContaining('workspace_search_changes'),
      expect.stringContaining('pg_advisory_unlock'),
    ]));
    expect(mocks.release).toHaveBeenCalledWith(undefined);
  });

  it('fails and destroys the client when a lock reports it was not held at release', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_lock')) return { rows: [{ pg_advisory_lock: null }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: false }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(withRagWorkspaceLock(workspaceId, async () => 'done')).rejects.toThrow(
      `RAG workspace lock ${workspaceId} was not held at release`
    );
    expect(mocks.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('releases a successfully acquired lock before surfacing work failures', async () => {
    const workError = new Error('indexing failed');
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_lock')) return { rows: [{ pg_advisory_lock: null }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(withRagWorkspaceLock(workspaceId, async () => { throw workError; })).rejects.toBe(workError);
    expect(mocks.release).toHaveBeenCalledWith(undefined);
  });

  it('retains both work and unlock failures for diagnostics', async () => {
    const workError = new Error('indexing failed');
    const unlockError = new Error('unlock failed');
    mocks.query
      .mockResolvedValueOnce({ rows: [{ pg_advisory_lock: null }] })
      .mockRejectedValueOnce(unlockError);

    await expect(withRagWorkspaceLock(workspaceId, async () => { throw workError; }))
      .rejects.toMatchObject({ name: 'AggregateError', errors: [workError, unlockError] });
    expect(mocks.release).toHaveBeenCalledWith(unlockError);
  });

  it('destroys a client when advisory-lock acquisition itself fails', async () => {
    const lockError = new Error('connection lost');
    mocks.query.mockRejectedValueOnce(lockError);

    await expect(withRagWorkspaceLock(workspaceId, async () => 'never runs')).rejects.toBe(lockError);
    expect(mocks.release).toHaveBeenCalledWith(lockError);
  });
});
