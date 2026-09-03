import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const integrationDatabaseUrl = process.env.HORIZONLAYER_INTEGRATION_DATABASE_URL;
const integrationDescribe = integrationDatabaseUrl ? describe.sequential : describe.skip;
const schemaSql = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function setTestSearchPath(client: PoolClient, schemaName: string): Promise<void> {
  await client.query(
    `SET search_path TO ${quoteIdentifier(schemaName)}, public, pg_catalog`
  );
  await client.query("SET statement_timeout = '5s'");
}

integrationDescribe('issue blocker workflow semantics', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPgOptions = process.env.PGOPTIONS;
  const schemaName = `hl_blockers_${randomUUID().replaceAll('-', '')}`;
  let adminPool: pg.Pool;
  let closePool: typeof import('./client.js')['closePool'] | undefined;
  let claimIssue: typeof import('./queries/issues.js')['claimIssue'];
  let getIssue: typeof import('./queries/issues.js')['getIssue'];
  let queryIssues: typeof import('./queries/issues.js')['queryIssues'];
  let blockerId: string;
  let blockedId: string;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);

    const setup = await adminPool.connect();
    try {
      await setTestSearchPath(setup, schemaName);
      await setup.query(schemaSql);
      const { rows: projects } = await setup.query<{ id: string }>(
        `INSERT INTO issue_projects (project_key, name)
         VALUES ($1, $2)
         RETURNING id`,
        ['HL', `Blockers ${schemaName}`]
      );
      const projectId = projects[0].id;
      const { rows: issues } = await setup.query<{ id: string; title: string }>(
        `INSERT INTO issues (project_id, title, created_by)
         VALUES ($1, 'Blocker', 'integration'), ($1, 'Blocked', 'integration')
         RETURNING id, title`,
        [projectId]
      );
      blockerId = issues.find((issue) => issue.title === 'Blocker')!.id;
      blockedId = issues.find((issue) => issue.title === 'Blocked')!.id;
      await setup.query(
        `INSERT INTO issue_dependencies (blocking_issue_id, blocked_issue_id)
         VALUES ($1, $2)`,
        [blockerId, blockedId]
      );
    } finally {
      setup.release();
    }

    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.PGOPTIONS = [
      `-c search_path=${schemaName},public,pg_catalog`,
      '-c statement_timeout=5000',
    ].join(' ');
    vi.resetModules();
    ({ closePool } = await import('./client.js'));
    ({ claimIssue, getIssue, queryIssues } = await import('./queries/issues.js'));
  }, 15_000);

  afterAll(async () => {
    if (closePool) await closePool();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      await adminPool.end();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPgOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = originalPgOptions;
  }, 15_000);

  async function setBlockerStatus(status: string): Promise<void> {
    const writer = await adminPool.connect();
    try {
      await setTestSearchPath(writer, schemaName);
      await writer.query('UPDATE issues SET status = $1 WHERE id = $2', [status, blockerId]);
    } finally {
      writer.release();
    }
  }

  async function readyIds(): Promise<string[]> {
    return (await queryIssues({ ready: true, limit: 100 })).map((issue) => issue.id);
  }

  it('treats done and closed blockers as finished in the ready filter', async () => {
    await expect(readyIds()).resolves.not.toContain(blockedId);

    await setBlockerStatus('done');
    await expect(readyIds()).resolves.toContain(blockedId);

    await setBlockerStatus('closed');
    await expect(readyIds()).resolves.toContain(blockedId);

    await setBlockerStatus('open');
    await expect(readyIds()).resolves.not.toContain(blockedId);
  });

  it('lets a closed blocker unblock the claim path', async () => {
    await setBlockerStatus('open');
    const current = await getIssue(blockedId);
    await expect(claimIssue(blockedId, 'integration-agent', current!.revision))
      .rejects.toThrow('not ready to claim');

    await setBlockerStatus('closed');
    const refreshed = await getIssue(blockedId);
    await expect(claimIssue(blockedId, 'integration-agent', refreshed!.revision))
      .resolves.toMatchObject({ assignee: 'integration-agent', status: 'in_progress' });
  });
});
