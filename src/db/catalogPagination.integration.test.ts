import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const integrationDatabaseUrl = process.env.HORIZONLAYER_INTEGRATION_DATABASE_URL;
const integrationDescribe = integrationDatabaseUrl ? describe.sequential : describe.skip;
const schemaSql = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const ROW_COUNT = 612;

integrationDescribe('catalog pagination with timestamp ties', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPgOptions = process.env.PGOPTIONS;
  const schemaName = `hl_catalog_${randomUUID().replaceAll('-', '')}`;
  let adminPool: pg.Pool;
  let setup: PoolClient;
  let closePool: typeof import('./client.js')['closePool'] | undefined;
  let listWorkspaces: typeof import('./queries/workspaces.js')['listWorkspaces'];
  let listIssueProjects: typeof import('./queries/issueProjects.js')['listIssueProjects'];

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    setup = await adminPool.connect();
    await setup.query(`SET search_path TO "${schemaName}", public, pg_catalog`);
    await setup.query("SET statement_timeout = '5s'");
    await setup.query(schemaSql);
    // Interleaved groups expose PostgreSQL's different sorting behavior across
    // OFFSET boundaries. Each timestamp group is larger than a full page.
    await setup.query(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       SELECT ('00000000-0000-0000-0000-' || LPAD(i::text, 12, '0'))::uuid,
              'Workspace ' || i,
              '2026-01-01'::timestamptz,
              CASE WHEN i % 2 = 0 THEN '2026-01-01'::timestamptz
                   ELSE '2025-01-01'::timestamptz END
       FROM generate_series(1, $1::integer) i`,
      [ROW_COUNT]
    );
    await setup.query(
      `INSERT INTO issue_projects (id, project_key, name, created_at, updated_at, archived_at)
       SELECT ('00000000-0000-0000-0000-' || LPAD(i::text, 12, '0'))::uuid,
              'P' || i,
              'Project ' || i,
              '2026-01-01'::timestamptz,
              CASE WHEN i % 2 = 0 THEN '2026-01-01'::timestamptz
                   ELSE '2025-01-01'::timestamptz END,
              CASE WHEN i % 5 = 0 THEN '2026-01-02'::timestamptz ELSE NULL END
       FROM generate_series(1, $1::integer) i`,
      [ROW_COUNT]
    );

    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.PGOPTIONS = `-c search_path=${schemaName},public,pg_catalog -c statement_timeout=5000`;
    vi.resetModules();
    ({ closePool } = await import('./client.js'));
    ({ listWorkspaces } = await import('./queries/workspaces.js'));
    ({ listIssueProjects } = await import('./queries/issueProjects.js'));
  }, 15_000);

  afterAll(async () => {
    if (closePool) await closePool();
    setup?.release();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPgOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = originalPgOptions;
  }, 15_000);

  async function expectCompleteCatalog(
    table: 'workspaces' | 'issue_projects',
    list: (params: { limit: number; offset: number }) => Promise<{ id: string }[]>
  ): Promise<void> {
    const snapshot = await setup.query<{ id: string }>(
      `SELECT id FROM ${table} ORDER BY updated_at DESC, created_at DESC, id DESC`
    );
    const pagedIds: string[] = [];
    for (let offset = 0; ; offset += 101) {
      const page = await list({ limit: 101, offset });
      pagedIds.push(...page.map(({ id }) => id));
      if (page.length < 101) break;
    }

    expect(pagedIds).toHaveLength(ROW_COUNT);
    expect(new Set(pagedIds).size).toBe(ROW_COUNT);
    expect(pagedIds).toEqual(snapshot.rows.map(({ id }) => id));
  }

  it('lists every active workspace once in the same order as one complete query', async () => {
    await expectCompleteCatalog('workspaces', listWorkspaces);
  });

  it('lists every active and archived project once in the same order as one complete query', async () => {
    await expectCompleteCatalog('issue_projects', (params) => (
      listIssueProjects({ ...params, include_archived: true })
    ));
  });
});
