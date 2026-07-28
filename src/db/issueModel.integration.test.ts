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
    const prioritized = await issues.updateIssue(ready.id, { priority: 'highest', revision: ready.revision });
    await expect(issues.queryIssues({ project_key: project.project_key, priority: ['highest'] }))
      .resolves.toContainEqual(expect.objectContaining({ id: ready.id }));
    const claims = await Promise.allSettled([
      issues.claimIssue(ready.id, 'agent-a', prioritized!.revision),
      issues.claimIssue(ready.id, 'agent-b', prioritized!.revision),
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
    const secondIssue = await issues.createIssue({
      created_by: 'test', project_id: project.id, title: 'Second linked work',
    });
    await links.createLink({
      from_id: issue.id,
      from_type: 'issue',
      to_id: secondIssue.id,
      to_type: 'issue',
      link_type: 'follows',
    });
    await expect(links.traverseLinks({ item_id: pageId, item_type: 'page', depth: 2 }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ depth: 1, id: issue.id, type: 'issue' }),
        expect.objectContaining({ depth: 2, id: secondIssue.id, type: 'issue' }),
      ]));
  });
});
