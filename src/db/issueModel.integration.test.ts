import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const integrationDatabaseUrl = process.env.HORIZONLAYER_INTEGRATION_DATABASE_URL;
const integrationDescribe = integrationDatabaseUrl ? describe.sequential : describe.skip;
const schemaSql = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const migrationSql = readFileSync(
  new URL('../../migrations/0002_issue_modules_v3.sql', import.meta.url),
  'utf8'
);

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function setSearchPath(client: PoolClient, schemaName: string): Promise<void> {
  await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public, pg_catalog`);
  await client.query("SET statement_timeout = '5s'");
}

integrationDescribe('Issue Module canonical persistence', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPgOptions = process.env.PGOPTIONS;
  const schemaName = `hl_issues_${randomUUID().replaceAll('-', '')}`;
  let adminPool: pg.Pool;
  let setup: PoolClient;
  let closePool: typeof import('./client.js')['closePool'] | undefined;
  let issueProjects: typeof import('./queries/issueProjects.js');
  let issues: typeof import('./queries/issues.js');
  let links: typeof import('./queries/links.js');
  let workspaceId: string;
  let pageId: string;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    setup = await adminPool.connect();
    await setSearchPath(setup, schemaName);
    await setup.query(schemaSql);
    const workspace = await setup.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('Issue links') RETURNING id`
    );
    workspaceId = workspace.rows[0].id;
    const page = await setup.query<{ id: string }>(
      `INSERT INTO pages (workspace_id, title) VALUES ($1, 'Issue context') RETURNING id`,
      [workspaceId]
    );
    pageId = page.rows[0].id;

    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.PGOPTIONS = [
      `-c search_path=${schemaName},public,pg_catalog`,
      '-c statement_timeout=5000',
    ].join(' ');
    vi.resetModules();
    ({ closePool } = await import('./client.js'));
    issueProjects = await import('./queries/issueProjects.js');
    issues = await import('./queries/issues.js');
    links = await import('./queries/links.js');
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

  it('allocates immutable readable keys and enforces same-project acyclic subtasks', async () => {
    const project = await issueProjects.createIssueProject({
      project_key: 'HL',
      name: 'HorizonLayer',
    });
    const otherProject = await issueProjects.createIssueProject({
      project_key: 'OTHER',
      name: 'Other',
    });
    const parent = await issues.createIssue({
      created_by: 'test',
      project_id: project.id,
      title: 'Parent',
    });
    const child = await issues.createIssue({
      created_by: 'test',
      parent_issue_id: parent.id,
      project_id: project.id,
      title: 'Child',
    });

    expect([parent.issue_key, child.issue_key]).toEqual(['HL-1', 'HL-2']);
    await expect(issues.createIssue({
      created_by: 'test',
      parent_issue_id: parent.id,
      project_id: otherProject.id,
      title: 'Wrong project',
    })).rejects.toThrow('same Issue Project');
    await expect(issues.updateIssue(parent.id, {
      parent_issue_id: child.id,
      revision: parent.revision,
    })).rejects.toThrow('cycle');
  });

  it('enforces acyclic dependencies and exclusive revision-safe assignment', async () => {
    const [project] = await issueProjects.listIssueProjects({ limit: 1 });
    const blocker = await issues.createIssue({
      created_by: 'test', project_id: project.id, title: 'Blocker',
    });
    const blocked = await issues.createIssue({
      created_by: 'test', project_id: project.id, title: 'Blocked',
    });
    await issues.createIssueDependency(blocker.id, blocked.id);
    await expect(issues.createIssueDependency(blocked.id, blocker.id)).rejects.toThrow('cycle');
    await expect(issues.claimIssue(blocked.id, 'agent-a', blocked.revision)).rejects.toThrow(
      'not ready'
    );

    const ready = await issues.createIssue({
      created_by: 'test', project_id: project.id, title: 'Ready',
    });
    await expect(issues.queryIssues({ project_id: project.id, ready: true }))
      .resolves.toContainEqual(expect.objectContaining({ id: ready.id }));
    const claims = await Promise.allSettled([
      issues.claimIssue(ready.id, 'agent-a', ready.revision),
      issues.claimIssue(ready.id, 'agent-b', ready.revision),
    ]);
    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === 'rejected')).toHaveLength(1);
  });

  it('stores append-only comments and cross-domain links without merging scopes', async () => {
    const [project] = await issueProjects.listIssueProjects({ limit: 1 });
    const issue = await issues.createIssue({
      created_by: 'test', project_id: project.id, title: 'Linked work',
    });
    await issues.addIssueComment({ author: 'agent-a', body: 'Started', issue_id: issue.id });
    await issues.addIssueComment({ author: 'agent-b', body: 'Context added', issue_id: issue.id });
    await expect(issues.listIssueComments(issue.id)).resolves.toHaveLength(2);

    const link = await links.createLink({
      from_id: pageId,
      from_type: 'page',
      to_id: issue.id,
      to_type: 'issue',
    });
    expect(link.workspace_id).toBe(workspaceId);
    await expect(links.listLinks({ item_id: issue.id, item_type: 'issue' }))
      .resolves.toEqual([expect.objectContaining({ id: link.id })]);
  });
});

integrationDescribe('v2 to v3 migration', () => {
  it('preserves legacy knowledge and link identities transactionally', async () => {
    const schemaName = `hl_migration_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    await pool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    const client = await pool.connect();
    try {
      await setSearchPath(client, schemaName);
      await client.query(schemaSql);
      const workspace = await client.query<{ id: string }>(
        `INSERT INTO workspaces (name) VALUES ('Legacy') RETURNING id`
      );
      const page = await client.query<{ id: string }>(
        `INSERT INTO pages (workspace_id, title) VALUES ($1, 'Legacy page') RETURNING id`,
        [workspace.rows[0].id]
      );
      const link = await client.query<{ id: string }>(
        `INSERT INTO links (workspace_id, from_type, from_id, to_type, to_id)
         VALUES ($1, 'workspace', $1, 'page', $2) RETURNING id`,
        [workspace.rows[0].id, page.rows[0].id]
      );

      await client.query('DROP VIEW links');
      await client.query('ALTER TABLE record_links RENAME TO links');
      await client.query(
        'ALTER TABLE links RENAME CONSTRAINT record_links_from_type_check TO links_from_type_check'
      );
      await client.query(
        'ALTER TABLE links RENAME CONSTRAINT record_links_to_type_check TO links_to_type_check'
      );
      await client.query('ALTER TABLE links ALTER COLUMN workspace_id SET NOT NULL');
      await client.query('DROP TABLE schema_migrations');

      await client.query('BEGIN');
      await client.query(migrationSql);
      await client.query(schemaSql);
      await client.query('COMMIT');

      const preserved = await client.query<{ id: string }>('SELECT id FROM links WHERE id = $1', [link.rows[0].id]);
      expect(preserved.rows).toEqual([{ id: link.rows[0].id }]);
      await expect(client.query(
        `INSERT INTO issue_projects (project_key, name) VALUES ('UP', 'Upgraded')`
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(client.query('SELECT version FROM schema_migrations ORDER BY version'))
        .resolves.toMatchObject({ rows: [{ version: 1 }, { version: 2 }] });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      await pool.end();
    }
  });
});
