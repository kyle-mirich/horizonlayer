import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

import pg, { type PoolClient, type QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const integrationDatabaseUrl = process.env.HORIZONLAYER_INTEGRATION_DATABASE_URL;
const integrationDescribe = integrationDatabaseUrl ? describe.sequential : describe.skip;
const schemaSql = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const isolationLevels = ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'] as const;
type IsolationLevel = typeof isolationLevels[number];
type WriteOutcome = { result: QueryResult } | { error: Error & { code?: string } };

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

integrationDescribe('Issue graph concurrency and repair', () => {
  const schemaName = `hl_issue_graph_${randomUUID().replaceAll('-', '')}`;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPgOptions = process.env.PGOPTIONS;
  let adminPool: pg.Pool;
  let setup: PoolClient;
  let closePool: typeof import('./client.js')['closePool'] | undefined;
  let issues: typeof import('./queries/issues.js');

  async function connect(): Promise<PoolClient> {
    const client = await adminPool.connect();
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public, pg_catalog`);
    await client.query("SET statement_timeout = '5s'");
    return client;
  }

  async function createProject(key: string): Promise<string> {
    const result = await setup.query<{ id: string }>(
      'INSERT INTO issue_projects (project_key, name) VALUES ($1, $1) RETURNING id', [key]
    );
    return result.rows[0].id;
  }

  async function createIssue(projectId: string, parentId?: string): Promise<string> {
    const result = await setup.query<{ id: string }>(
      `INSERT INTO issues (project_id, title, created_by, parent_issue_id)
       VALUES ($1, 'Graph regression', 'test', $2) RETURNING id`, [projectId, parentId ?? null]
    );
    return result.rows[0].id;
  }

  async function restoreDependency(id: string, revision: number): Promise<{ revision: number }> {
    const result = await setup.query<{ revision: number }>(
      `UPDATE issue_dependencies SET archived_at = NULL, updated_at = NOW()
       WHERE id = $1 AND revision = $2 RETURNING revision`, [id, revision]
    );
    return result.rows[0];
  }

  // The first writer cannot commit until the second statement has either
  // demonstrably waited on it or completed. No elapsed-time assumption is used
  // to infer blocking. Both transactions establish snapshots before either write.
  async function raceGraphWrites(
    isolation: IsolationLevel,
    firstSql: string,
    firstValues: string[],
    secondSql: string,
    secondValues: string[]
  ): Promise<{ waited: boolean; outcome: WriteOutcome }> {
    const first = await connect();
    const second = await connect();
    let pending: Promise<WriteOutcome> | undefined;
    try {
      await first.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await second.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const firstPid = (await first.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid, COUNT(*) FROM issues'
      )).rows[0].pid;
      const secondPid = (await second.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid, COUNT(*) FROM issues'
      )).rows[0].pid;
      await first.query(firstSql, firstValues);
      let settled = false;
      pending = second.query(secondSql, secondValues).then(
        (result): WriteOutcome => ({ result }),
        (error: Error & { code?: string }): WriteOutcome => ({ error })
      ).then((outcome) => { settled = true; return outcome; });
      let waited = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const blockers = await setup.query<{ pids: number[] }>(
          'SELECT pg_blocking_pids($1) AS pids', [secondPid]
        );
        if (blockers.rows[0].pids.includes(firstPid)) { waited = true; break; }
        if (settled) break;
        await setTimeout(5);
      }
      await first.query('COMMIT');
      const outcome = await pending;
      if ('result' in outcome) await second.query('COMMIT');
      else await second.query('ROLLBACK');
      return { waited, outcome };
    } finally {
      await first.query('ROLLBACK');
      if (pending) await pending;
      await second.query('ROLLBACK');
      first.release();
      second.release();
    }
  }

  function expectRefusedOppositeWrite(
    isolation: IsolationLevel, race: { waited: boolean; outcome: WriteOutcome }
  ): void {
    expect(race.waited).toBe(true);
    expect(race.outcome).toHaveProperty('error');
    if ('error' in race.outcome) {
      expect(race.outcome.error.code).toBe(isolation === 'READ COMMITTED' ? 'P0001' : '40001');
      if (isolation === 'READ COMMITTED') expect(race.outcome.error.message).toContain('cycle');
    }
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: integrationDatabaseUrl, max: 4 });
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    setup = await connect();
    await setup.query(schemaSql);
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.PGOPTIONS = `-c search_path=${schemaName},public,pg_catalog -c statement_timeout=5000`;
    vi.resetModules();
    ({ closePool } = await import('./client.js'));
    issues = await import('./queries/issues.js');
  }, 15_000);

  afterAll(async () => {
    if (closePool) await closePool();
    setup?.release();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      await adminPool.end();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPgOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = originalPgOptions;
  }, 15_000);

  for (const isolation of isolationLevels) {
    for (const crossProject of [false, true]) {
      it(`refuses concurrent opposite ${crossProject ? 'cross-project' : 'same-project'} dependencies at ${isolation}`, async () => {
        const key = `D${isolationLevels.indexOf(isolation)}${crossProject ? 'C' : 'S'}`;
        const project = await createProject(key);
        const otherProject = crossProject ? await createProject(`${key}B`) : project;
        const first = await createIssue(project);
        const second = await createIssue(otherProject);
        const sql = `INSERT INTO issue_dependencies (blocking_issue_id, blocked_issue_id)
                     VALUES ($1, $2) RETURNING id`;
        const race = await raceGraphWrites(isolation, sql, [first, second], sql, [second, first]);
        expectRefusedOppositeWrite(isolation, race);
        const edges = await setup.query(
          'SELECT id FROM issue_dependencies WHERE blocking_issue_id = ANY($1::uuid[])',
          [[first, second]]
        );
        expect(edges.rowCount).toBe(1);
        // A failed graph transaction must not retain coordination or prevent a
        // subsequent valid edge, including one across project boundaries.
        const third = await createIssue(otherProject);
        await expect(issues.createIssueDependency(second, third)).resolves.toMatchObject({
          blocking_issue_id: second, blocked_issue_id: third,
        });
      });
    }

    it(`refuses concurrent opposite parent updates at ${isolation}`, async () => {
      const project = await createProject(`P${isolationLevels.indexOf(isolation)}`);
      const first = await createIssue(project);
      const second = await createIssue(project);
      const sql = `UPDATE issues SET parent_issue_id = $2, updated_at = NOW()
                   WHERE id = $1 AND revision = 1 RETURNING id`;
      const race = await raceGraphWrites(isolation, sql, [first, second], sql, [second, first]);
      expectRefusedOppositeWrite(isolation, race);
      await expect(issues.getIssue(first)).resolves.toMatchObject({ parent_issue_id: second, revision: 2 });
      await expect(issues.getIssue(second)).resolves.toMatchObject({ parent_issue_id: null, revision: 1 });
    });
  }

  it('archives a legacy cyclic dependency and permits a valid replacement', async () => {
    const project = await createProject('LC');
    const first = await createIssue(project);
    const second = await createIssue(project);
    await setup.query('ALTER TABLE issue_dependencies DISABLE TRIGGER USER');
    const edge = await setup.query<{ id: string }>(
      `INSERT INTO issue_dependencies (blocking_issue_id, blocked_issue_id)
       VALUES ($1, $2), ($2, $1) RETURNING id`, [first, second]
    );
    await setup.query('ALTER TABLE issue_dependencies ENABLE TRIGGER USER');
    await expect(issues.archiveIssueDependency(edge.rows[0].id, 1)).resolves.toMatchObject({ revision: 2 });
    expect((await setup.query(
      'SELECT id FROM issue_dependencies WHERE id = $1 AND archived_at IS NOT NULL', [edge.rows[0].id]
    )).rowCount).toBe(1);
    await expect(restoreDependency(edge.rows[0].id, 2)).rejects.toThrow('cycle');
    await expect(issues.archiveIssueDependency(edge.rows[1].id, 1)).resolves.toMatchObject({ revision: 2 });
    await expect(restoreDependency(edge.rows[0].id, 2)).resolves.toMatchObject({ revision: 3 });
  });

  it('archives a dependency after an endpoint is archived, while add and restore still refuse it', async () => {
    const project = await createProject('IA');
    const first = await createIssue(project);
    const second = await createIssue(project);
    const edge = await issues.createIssueDependency(first, second);
    await issues.archiveIssue(first, 1);
    await expect(issues.archiveIssueDependency(edge.id, edge.revision)).resolves.toMatchObject({ revision: 2 });
    await expect(restoreDependency(edge.id, 2)).rejects.toThrow('active Issues');
    await expect(issues.createIssueDependency(first, second)).rejects.toThrow('active Issues');
  });

  it('rejects a descendant of a stored parent cycle promptly and allows detaching to repair it', async () => {
    const project = await createProject('LP');
    const first = await createIssue(project);
    const second = await createIssue(project);
    await setup.query('ALTER TABLE issues DISABLE TRIGGER USER');
    await setup.query(
      'UPDATE issues SET parent_issue_id = CASE WHEN id = $1 THEN $2 ELSE $1 END WHERE id = ANY($3::uuid[])',
      [first, second, [first, second]]
    );
    await setup.query('ALTER TABLE issues ENABLE TRIGGER USER');
    await setup.query("SET statement_timeout = '300ms'");
    try {
      await expect(createIssue(project, first)).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('cycle') });
    } finally {
      await setup.query("SET statement_timeout = '5s'");
    }
    await expect(issues.updateIssue(first, { parent_issue_id: null, revision: 1 }))
      .resolves.toMatchObject({ parent_issue_id: null, revision: 2 });
    await expect(createIssue(project, second)).resolves.toEqual(expect.any(String));
  });

  it('recreates coordination state for an older backup and preserves it on later schema reapplication', async () => {
    const project = await createProject('BK');
    const issue = await createIssue(project);
    await setup.query('DROP TABLE IF EXISTS issue_graph_state');
    await setup.query(schemaSql);
    expect((await setup.query('SELECT generation FROM issue_graph_state')).rows).toEqual([{ generation: '0' }]);
    await createIssue(project, issue);
    const generation = (await setup.query('SELECT generation FROM issue_graph_state')).rows;
    await setup.query(schemaSql);
    expect((await setup.query('SELECT generation FROM issue_graph_state')).rows).toEqual(generation);
    await expect(issues.getIssue(issue)).resolves.toMatchObject({ id: issue });
  });
});
