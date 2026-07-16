import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  requireActiveSession: vi.fn(),
  lockActiveSessionForChildWrite: vi.fn(),
  requireActiveWorkspace: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  poolQuery: vi.fn(),
  release: vi.fn(),
  touchSession: vi.fn(),
}));

vi.mock('../client.js', () => ({
  getPool: () => ({
    connect: mocks.connect,
    query: mocks.poolQuery,
  }),
}));

vi.mock('./sessions.js', () => ({
  touchSession: mocks.touchSession,
}));

vi.mock('./scopeGuards.js', () => ({
  lockActiveSessionForChildWrite: mocks.lockActiveSessionForChildWrite,
  requireActiveSession: mocks.requireActiveSession,
  requireActiveWorkspace: mocks.requireActiveWorkspace,
  requireSession: mocks.requireSession,
}));

function buildRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    workspace_id: 'ws-1',
    session_id: 'session-1',
    agent_name: 'agent',
    title: 'Run',
    status: 'running',
    metadata: {},
    result: {},
    error_message: null,
    latest_checkpoint_sequence: 0,
    latest_checkpoint_at: null,
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('run query contracts', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.connect.mockResolvedValue({
      query: mocks.clientQuery,
      release: mocks.release,
    });
    mocks.requireSession.mockResolvedValue({ workspace_id: 'ws-1' });
    mocks.requireActiveSession.mockResolvedValue({ workspace_id: 'ws-1' });
    mocks.lockActiveSessionForChildWrite.mockResolvedValue({ workspace_id: 'ws-1' });
    mocks.requireActiveWorkspace.mockResolvedValue(undefined);
    mocks.touchSession.mockResolvedValue(undefined);
  });

  it('starts a run and touches its session in the same transaction', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO agent_runs')) {
        return { rowCount: 1, rows: [buildRun()] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { startRun } = await import('./runs.js');
    const started = await startRun({
      agent_name: ' agent ',
      metadata: { plan: true },
      session_id: 'session-1',
      title: ' Run ',
      workspace_id: 'ws-1',
    });

    expect(started).toMatchObject({
      id: 'run-1',
      checkpoints: [],
      checkpoints_page: { has_more: false, limit: 20, next_offset: null, offset: 0 },
    });
    expect(mocks.requireActiveWorkspace).toHaveBeenCalledWith('ws-1');
    expect(mocks.requireActiveSession).toHaveBeenCalledWith('session-1');
    expect(mocks.lockActiveSessionForChildWrite).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ query: mocks.clientQuery })
    );
    const insertCall = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO agent_runs'));
    expect(String(insertCall?.[0])).not.toMatch(/SELECT \*|RETURNING \*|task_id|parent_run_id/);
    expect(insertCall?.[1]).toEqual([
      'ws-1',
      'session-1',
      'agent',
      'Run',
      JSON.stringify({ plan: true }),
    ]);
    expect(mocks.touchSession).toHaveBeenCalledWith('session-1', expect.objectContaining({
      query: mocks.clientQuery,
    }));
    expect(mocks.clientQuery.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO agent_runs'),
      'COMMIT',
    ]);
    expect(mocks.lockActiveSessionForChildWrite.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clientQuery.mock.invocationCallOrder[1]
    );
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back a failed run start and always releases the client', async () => {
    const insertError = new Error('insert failed');
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO agent_runs')) throw insertError;
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { startRun } = await import('./runs.js');
    await expect(startRun({
      agent_name: 'agent',
      workspace_id: 'ws-1',
    })).rejects.toBe(insertError);

    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('rejects session-scoped run creation when the session belongs to another workspace', async () => {
    mocks.requireActiveSession.mockResolvedValueOnce({ workspace_id: 'ws-2' });

    const { startRun } = await import('./runs.js');
    await expect(startRun({
      agent_name: 'agent',
      session_id: 'session-foreign',
      workspace_id: 'ws-1',
    })).rejects.toThrow('session_id must belong to workspace ws-1');

    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('rejects run creation in a closed session before opening a transaction', async () => {
    mocks.requireActiveSession.mockRejectedValueOnce(
      new Error('Session session-closed is closed and cannot be modified')
    );

    const { startRun } = await import('./runs.js');
    await expect(startRun({
      agent_name: 'agent',
      session_id: 'session-closed',
      workspace_id: 'ws-1',
    })).rejects.toThrow('Session session-closed is closed and cannot be modified');

    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('gets and lists runs with explicit columns and bound filters', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM run_checkpoints')) {
        return { rows: [{ id: 'checkpoint-1', run_id: 'run-1', sequence: 1 }] };
      }
      if (sql.includes('FROM agent_runs') && sql.includes('WHERE id = $1')) {
        return { rows: [buildRun()] };
      }
      if (sql.includes('FROM agent_runs') && sql.includes('ORDER BY started_at DESC')) {
        return { rows: [buildRun()] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { getRun, listRuns } = await import('./runs.js');
    await expect(getRun('run-1', {
      checkpoint_limit: 20,
      checkpoint_offset: 0,
      session_id: 'session-1',
    })).resolves.toMatchObject({
      checkpoints: [{ id: 'checkpoint-1' }],
      checkpoints_page: { has_more: false, limit: 20, next_offset: null, offset: 0 },
      id: 'run-1',
    });
    await expect(listRuns({
      agent_name: 'agent',
      limit: 10,
      offset: 5,
      session_id: 'session-1',
      status: ['running'],
      workspace_id: 'ws-1',
    })).resolves.toHaveLength(1);

    const runSelects = mocks.poolQuery.mock.calls.filter(([sql]) => String(sql).includes('FROM agent_runs'));
    expect(runSelects.every(([sql]) => !String(sql).includes('SELECT *'))).toBe(true);
    expect(runSelects.every(([sql]) => !/task_id|parent_run_id/.test(String(sql)))).toBe(true);
    const listCall = runSelects.find(([sql]) => String(sql).includes('ORDER BY started_at DESC'));
    expect(String(listCall?.[0])).toContain('status = ANY($4)');
    expect(String(listCall?.[0])).toContain('LIMIT $5 OFFSET $6');
    expect(listCall?.[1]).toEqual([
      'ws-1',
      'session-1',
      'agent',
      ['running'],
      10,
      5,
    ]);
    const checkpointsCall = mocks.poolQuery.mock.calls.find(([sql]) => String(sql).includes('FROM run_checkpoints'));
    expect(String(checkpointsCall?.[0])).toContain('ORDER BY sequence DESC');
    expect(String(checkpointsCall?.[0])).toContain('LIMIT $2 OFFSET $3');
    expect(checkpointsCall?.[1]).toEqual(['run-1', 21, 0]);
    expect(mocks.requireActiveWorkspace).toHaveBeenCalledTimes(2);
    expect(mocks.requireActiveWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('caps checkpoint history with honest latest-first lookahead pagination', async () => {
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agent_runs')) return { rows: [buildRun({ latest_checkpoint_sequence: 3 })] };
      if (sql.includes('FROM run_checkpoints')) {
        return {
          rows: [
            { id: 'checkpoint-3', run_id: 'run-1', sequence: 3 },
            { id: 'checkpoint-2', run_id: 'run-1', sequence: 2 },
            { id: 'checkpoint-1', run_id: 'run-1', sequence: 1 },
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const { getRun } = await import('./runs.js');

    await expect(getRun('run-1', {
      checkpoint_limit: 2,
      checkpoint_offset: 4,
    })).resolves.toMatchObject({
      checkpoints: [{ sequence: 3 }, { sequence: 2 }],
      checkpoints_page: { has_more: true, limit: 2, next_offset: 6, offset: 4 },
    });

    const checkpointCall = mocks.poolQuery.mock.calls.find(([sql]) => String(sql).includes('FROM run_checkpoints'));
    expect(checkpointCall?.[1]).toEqual(['run-1', 3, 4]);
  });

  it('allows the internal lookahead limit and rejects larger or invalid pagination', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });

    const { listRuns } = await import('./runs.js');
    await expect(listRuns({ workspace_id: 'ws-1', limit: 101 })).resolves.toEqual([]);
    await expect(listRuns({ workspace_id: 'ws-1', limit: 102 })).rejects.toThrow(
      'limit must be an integer between 0 and 101'
    );
    await expect(listRuns({ workspace_id: 'ws-1', offset: -1 })).rejects.toThrow(
      'offset must be an integer between 0 and 1000000'
    );

    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    expect(mocks.poolQuery.mock.calls[0]?.[1]).toEqual(['ws-1', 101, 0]);

    mocks.poolQuery.mockClear();
    const { getRun } = await import('./runs.js');
    await expect(getRun('run-1', { checkpoint_limit: 0 })).rejects.toThrow(
      'checkpoint_limit must be an integer between 1 and 100'
    );
    await expect(getRun('run-1', { checkpoint_offset: -1 })).rejects.toThrow(
      'checkpoint_offset must be an integer between 0 and 1000000'
    );
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('checkpoints a running run transactionally and returns refreshed details', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM agent_runs') && sql.includes('FOR UPDATE')) {
        return { rows: [buildRun({ latest_checkpoint_sequence: 2 })] };
      }
      if (sql.includes('INSERT INTO run_checkpoints')) {
        return { rows: [{ id: 'checkpoint-3', run_id: 'run-1', sequence: 3 }] };
      }
      if (sql.includes('UPDATE agent_runs')) {
        return { rows: [buildRun({ latest_checkpoint_sequence: 3 })] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { checkpointRun } = await import('./runs.js');
    await expect(checkpointRun({
      run_id: 'run-1',
      state: { step: 1 },
      summary: 'Saved',
    })).resolves.toMatchObject({
      checkpoint: { sequence: 3 },
      run: { latest_checkpoint_sequence: 3 },
    });

    const lockedSelect = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('FOR UPDATE'));
    expect(String(lockedSelect?.[0])).not.toMatch(/SELECT \*|task_id|parent_run_id/);
    const insertCall = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO run_checkpoints'));
    expect(insertCall?.[1]).toEqual([
      'run-1',
      3,
      'Saved',
      JSON.stringify({ step: 1 }),
      JSON.stringify({}),
    ]);
    expect(mocks.touchSession).toHaveBeenCalledWith('session-1', expect.objectContaining({
      query: mocks.clientQuery,
    }));
    expect(mocks.requireActiveWorkspace).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ query: mocks.clientQuery })
    );
    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('returns null and rolls back when checkpointing a missing run', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM agent_runs') && sql.includes('FOR UPDATE')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { checkpointRun } = await import('./runs.js');
    await expect(checkpointRun({
      run_id: 'missing',
    })).resolves.toBeNull();

    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['completed', null],
    ['failed', 'boom'],
    ['cancelled', null],
  ] as const)('finishes a run with outcome %s', async (outcome, storedError) => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM agent_runs') && sql.includes('FOR UPDATE')) {
        return { rows: [buildRun()] };
      }
      if (sql.includes('UPDATE agent_runs')) {
        return { rows: [buildRun({ error_message: storedError, status: outcome })] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    mocks.poolQuery.mockResolvedValue({ rows: [] });

    const runsModule = await import('./runs.js');
    await expect(runsModule.finishRun({
      ...(outcome === 'failed' ? { error_message: 'boom' } : {}),
      outcome,
      result: { ok: true },
      run_id: 'run-1',
    })).resolves.toMatchObject({
      latest_checkpoint: null,
      run: { status: outcome },
    });

    expect(runsModule).not.toHaveProperty('completeRun');
    expect(runsModule).not.toHaveProperty('failRun');
    expect(runsModule).not.toHaveProperty('cancelRun');
    const updateCall = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE agent_runs'));
    expect(updateCall?.[1]).toEqual([
      'run-1',
      outcome,
      JSON.stringify({ ok: true }),
      storedError,
    ]);
    expect(mocks.touchSession).toHaveBeenCalledWith('session-1', expect.objectContaining({
      query: mocks.clientQuery,
    }));
    expect(mocks.requireActiveWorkspace).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ query: mocks.clientQuery })
    );
    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('finishes with only the latest checkpoint instead of unbounded history', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM agent_runs') && sql.includes('FOR UPDATE')) {
        return { rows: [buildRun({ latest_checkpoint_sequence: 2 })] };
      }
      if (sql.includes('UPDATE agent_runs')) {
        return { rows: [buildRun({ latest_checkpoint_sequence: 2, status: 'completed' })] };
      }
      if (sql.includes('FROM run_checkpoints')) {
        return { rows: [{ id: 'checkpoint-2', run_id: 'run-1', sequence: 2 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const { finishRun } = await import('./runs.js');

    await expect(finishRun({
      outcome: 'completed',
      run_id: 'run-1',
    })).resolves.toMatchObject({
      latest_checkpoint: { sequence: 2 },
      run: { status: 'completed' },
    });

    const checkpointCall = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes('FROM run_checkpoints'));
    expect(String(checkpointCall?.[0])).toContain('ORDER BY sequence DESC');
    expect(String(checkpointCall?.[0])).toContain('LIMIT 1');
    expect(checkpointCall?.[1]).toEqual(['run-1']);
  });

  it('returns null and rolls back when finishing a missing run', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM agent_runs') && sql.includes('FOR UPDATE')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    const { finishRun } = await import('./runs.js');
    await expect(finishRun({
      outcome: 'failed',
      run_id: 'missing',
    })).resolves.toBeNull();

    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
