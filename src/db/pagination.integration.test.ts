import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppServer } from '../mcp.js';

const integrationDatabaseUrl = process.env.HORIZONLAYER_INTEGRATION_DATABASE_URL;
const integrationDescribe = integrationDatabaseUrl ? describe.sequential : describe.skip;
const schemaSql = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
const ROW_COUNT = 120;
const PAGE_SIZE = 7;

integrationDescribe('MCP pagination with tied sort values', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPgOptions = process.env.PGOPTIONS;
  const schemaName = `hl_pagination_${randomUUID().replaceAll('-', '')}`;
  let adminPool: pg.Pool;
  let setup: PoolClient;
  let closePool: typeof import('./client.js')['closePool'] | undefined;
  let server: AppServer;
  let workspaceId: string;
  let databaseId: string;
  let scorePropertyId: string;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    setup = await adminPool.connect();
    await setup.query(`SET search_path TO "${schemaName}", public, pg_catalog`);
    await setup.query("SET statement_timeout = '5s'");
    await setup.query(schemaSql);
    workspaceId = (await setup.query<{ id: string }>(
      "INSERT INTO workspaces (name) VALUES ('Pagination') RETURNING id"
    )).rows[0].id;
    databaseId = (await setup.query<{ id: string }>(
      "INSERT INTO databases (workspace_id, name) VALUES ($1, 'Row target') RETURNING id",
      [workspaceId]
    )).rows[0].id;
    const titlePropertyId = (await setup.query<{ id: string }>(
      `INSERT INTO database_properties (database_id, name, property_type, position)
       VALUES ($1, 'Title', 'title', 0) RETURNING id`,
      [databaseId]
    )).rows[0].id;
    scorePropertyId = (await setup.query<{ id: string }>(
      `INSERT INTO database_properties (database_id, name, property_type, position)
       VALUES ($1, 'Score', 'number', 1) RETURNING id`,
      [databaseId]
    )).rows[0].id;
    const projectId = (await setup.query<{ id: string }>(
      "INSERT INTO issue_projects (project_key, name) VALUES ('PG', 'Pagination') RETURNING id"
    )).rows[0].id;

    // Interleaved timestamp groups expose changed tie ordering at OFFSET
    // boundaries without forcing a PostgreSQL query plan.
    const id = "('00000000-0000-4000-8000-' || LPAD(n::text, 12, '0'))::uuid";
    const timestamp = `CASE WHEN n % 2 = 0 THEN '2026-01-02'::timestamptz
                      ELSE '2026-01-01'::timestamptz END`;
    await setup.query(
      `INSERT INTO databases (id, workspace_id, name, tags, created_at, updated_at)
       SELECT ${id}, $1, 'Database ' || n, ARRAY['pagination'], ${timestamp}, ${timestamp}
       FROM generate_series(1, $2::integer) n`,
      [workspaceId, ROW_COUNT]
    );
    await setup.query(
      `INSERT INTO sessions (id, workspace_id, title, started_at, last_activity_at, created_at, updated_at)
       SELECT ${id}, $1, 'Session ' || n, ${timestamp}, ${timestamp}, ${timestamp}, ${timestamp}
       FROM generate_series(1, $2::integer) n`,
      [workspaceId, ROW_COUNT]
    );
    await setup.query(
      `INSERT INTO issues (id, project_id, title, created_by, created_at, updated_at)
       SELECT ${id}, $1, 'Issue ' || n, 'reviewer', ${timestamp}, ${timestamp}
       FROM generate_series(1, $2::integer) n`,
      [projectId, ROW_COUNT]
    );
    await setup.query(
      `INSERT INTO pages (id, workspace_id, title)
       SELECT ${id}, $1, 'Endpoint ' || n FROM generate_series(1, $2::integer) n`,
      [workspaceId, ROW_COUNT]
    );
    await setup.query(
      `INSERT INTO links (id, workspace_id, from_type, from_id, to_type, to_id, created_at, updated_at)
       SELECT ${id}, $1, 'workspace', $1, 'page', ${id}, ${timestamp}, ${timestamp}
       FROM generate_series(1, $2::integer) n`,
      [workspaceId, ROW_COUNT]
    );
    await setup.query(
      `INSERT INTO database_rows (id, database_id, created_at, updated_at)
       SELECT ${id}, $1, ${timestamp}, ${timestamp} FROM generate_series(1, $2::integer) n`,
      [databaseId, ROW_COUNT]
    );
    await setup.query(
      `INSERT INTO database_row_values (row_id, property_id, value_text)
       SELECT id, $1, 'Row' FROM database_rows WHERE database_id = $2`,
      [titlePropertyId, databaseId]
    );
    await setup.query(
      `INSERT INTO database_row_values (row_id, property_id, value_number)
       SELECT ${id}, $1, n % 2 FROM generate_series(1, $2::integer) n WHERE n % 3 <> 0`,
      [scorePropertyId, ROW_COUNT]
    );

    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.PGOPTIONS = `-c search_path=${schemaName},public,pg_catalog -c statement_timeout=5000`;
    vi.resetModules();
    ({ closePool } = await import('./client.js'));
    const { AppServer } = await import('../mcp.js');
    const { registerModuleTools } = await import('../tools/modules.js');
    server = new AppServer({ name: 'pagination-review', version: '0.0.0' });
    registerModuleTools(server, ['knowledge', 'issues']);
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

  async function expectCompletePagination(
    tool: 'knowledge' | 'issues',
    parameters: { operation?: string; action?: string; input: Record<string, unknown> },
    snapshotSql: string,
    snapshotValues: unknown[]
  ): Promise<void> {
    const snapshot = await setup.query<{ id: string }>(snapshotSql, snapshotValues);
    const pagedIds: string[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const response = await server.callTool(tool, {
        ...parameters,
        input: { ...parameters.input, limit: PAGE_SIZE, offset },
      });
      const payload = response.structuredContent as {
        ok: boolean;
        result: { id: string }[] | { items: { id: string }[] };
      };
      expect(payload.ok).toBe(true);
      const items = Array.isArray(payload.result) ? payload.result : payload.result.items;
      pagedIds.push(...items.map(({ id }) => id));
      if (items.length < PAGE_SIZE) break;
    }

    expect(pagedIds).toHaveLength(ROW_COUNT);
    expect(new Set(pagedIds).size).toBe(ROW_COUNT);
    expect(pagedIds).toEqual(snapshot.rows.map(({ id }) => id));
  }

  it('lists every database once with timestamp ties', async () => {
    await expectCompletePagination('knowledge', {
      operation: 'database', input: { action: 'list', workspace_id: workspaceId, tags: ['pagination'] },
    }, `SELECT id FROM databases WHERE tags && ARRAY['pagination']
        ORDER BY updated_at DESC, created_at DESC, id DESC`, []);
  });

  it('lists every session once with last-activity and creation ties', async () => {
    await expectCompletePagination('knowledge', {
      operation: 'session', input: { action: 'list', workspace_id: workspaceId },
    }, `SELECT id FROM sessions WHERE workspace_id = $1
        ORDER BY last_activity_at DESC, created_at DESC, id DESC`, [workspaceId]);
  });

  it('queries every matching Issue once with timestamp ties', async () => {
    await expectCompletePagination('issues', {
      action: 'issue.query', input: { query: 'project = PG' },
    }, 'SELECT id FROM issues ORDER BY updated_at DESC, created_at DESC, id DESC', []);
  });

  it('lists every link once with timestamp ties', async () => {
    await expectCompletePagination('knowledge', {
      operation: 'link', input: { action: 'list', workspace_id: workspaceId },
    }, `SELECT id FROM links WHERE workspace_id = $1
        ORDER BY updated_at DESC, created_at DESC, id DESC`, [workspaceId]);
  });

  it('queries every row once with the default timestamp order', async () => {
    await expectCompletePagination('knowledge', {
      operation: 'row', input: { action: 'query', database_id: databaseId },
    }, `SELECT id FROM database_rows WHERE database_id = $1
        ORDER BY updated_at DESC, created_at DESC, id DESC`, [databaseId]);
  });

  it.each(['asc', 'desc'] as const)('queries every row once with equal title values sorted %s', async (direction) => {
    await expectCompletePagination('knowledge', {
      operation: 'row', input: { action: 'query', database_id: databaseId, sort_by: 'Title', sort_direction: direction },
    }, `SELECT id FROM database_rows WHERE database_id = $1
        ORDER BY created_at DESC, id DESC`, [databaseId]);
  });

  it.each(['asc', 'desc'] as const)('preserves numeric %s ordering and NULLS LAST across tied row pages', async (direction) => {
    await expectCompletePagination('knowledge', {
      operation: 'row', input: { action: 'query', database_id: databaseId, sort_by: 'Score', sort_direction: direction },
    }, `SELECT r.id FROM database_rows r
        LEFT JOIN database_row_values v ON v.row_id = r.id AND v.property_id = $2
        WHERE r.database_id = $1
        ORDER BY v.value_number ${direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, r.created_at DESC, r.id DESC`,
    [databaseId, scorePropertyId]);
  });
});
