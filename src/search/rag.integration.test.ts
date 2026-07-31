import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const integrationDatabaseUrl = process.env.HORIZONLAYER_INTEGRATION_DATABASE_URL;
const integrationDescribe = integrationDatabaseUrl ? describe.sequential : describe.skip;
const schemaSql = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

integrationDescribe('canonical RAG corpus', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPoolMax = process.env.DB_POOL_MAX;
  const originalPgOptions = process.env.PGOPTIONS;
  const schemaName = `hl_rag_${randomUUID().replaceAll('-', '')}`;
  let adminPool: pg.Pool;
  let closePool: typeof import('../db/client.js')['closePool'];
  let searchRecords: typeof import('../db/queries/search.js')['searchRecords'];
  let loadRagCorpus: typeof import('./rag.js')['loadRagCorpus'];
  let loadRagGeneration: typeof import('./rag.js')['loadRagGeneration'];
  let loadRagPoints: typeof import('./rag.js')['loadRagPoints'];
  let withRagWorkspaceLock: typeof import('./rag.js')['withRagWorkspaceLock'];
  let pageId: string;
  let rowId: string;
  let workspaceId: string;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    const setup = await adminPool.connect();
    try {
      await setup.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public, pg_catalog`);
      await setup.query(schemaSql);
      const { rows: workspaces } = await setup.query<{ id: string }>(
        `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
        [`RAG ${schemaName}`]
      );
      workspaceId = workspaces[0].id;
      const { rows: pages } = await setup.query<{ id: string }>(
        `INSERT INTO pages (workspace_id, title, tags, importance)
         VALUES ($1, 'Local agent memory', ARRAY['agents'], 0.9)
         RETURNING id`,
        [workspaceId]
      );
      pageId = pages[0].id;
      await setup.query(
        `INSERT INTO blocks (page_id, block_type, content, position, archived_at)
         VALUES
           ($1, 'text', 'Canonical evidence', 0, NULL),
           ($1, 'text', 'Archived evidence', 1, NOW())`,
        [pages[0].id]
      );
      const { rows: databases } = await setup.query<{ id: string }>(
        `INSERT INTO databases (workspace_id, name, description)
         VALUES ($1, 'Decisions', 'Architecture choices')
         RETURNING id`,
        [workspaceId]
      );
      const { rows: properties } = await setup.query<{ id: string; name: string }>(
        `INSERT INTO database_properties (database_id, name, property_type, position)
         VALUES
           ($1, 'Name', 'title', 0),
           ($1, 'Decision', 'text', 1),
           ($1, 'Deadline', 'date', 2)
         RETURNING id, name`,
        [databases[0].id]
      );
      const { rows: records } = await setup.query<{ id: string }>(
        `INSERT INTO database_rows (database_id, tags, importance)
         VALUES ($1, ARRAY['architecture'], 0.8)
         RETURNING id`,
        [databases[0].id]
      );
      rowId = records[0].id;
      await setup.query(
        `INSERT INTO database_row_values (row_id, property_id, value_text)
         VALUES ($1, $2, 'Use local embeddings'), ($1, $3, 'Keep PostgreSQL canonical')`,
        [
          records[0].id,
          properties.find(({ name }) => name === 'Name')!.id,
          properties.find(({ name }) => name === 'Decision')!.id,
        ]
      );
      await setup.query(
        `INSERT INTO database_row_values (row_id, property_id, value_date)
         VALUES ($1, $2, '2026-07-15T00:00:00.000Z')`,
        [records[0].id, properties.find(({ name }) => name === 'Deadline')!.id]
      );
    } finally {
      setup.release();
    }

    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DB_POOL_MAX = '1';
    process.env.PGOPTIONS = [
      `-c search_path=${schemaName},public,pg_catalog`,
      '-c statement_timeout=5000',
    ].join(' ');
    vi.resetModules();
    ({ closePool } = await import('../db/client.js'));
    ({ searchRecords } = await import('../db/queries/search.js'));
    ({
      loadRagCorpus,
      loadRagGeneration,
      loadRagPoints,
      withRagWorkspaceLock,
    } = await import('./rag.js'));
  }, 15_000);

  afterAll(async () => {
    if (closePool) await closePool();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      await adminPool.end();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPoolMax === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = originalPoolMax;
    if (originalPgOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = originalPgOptions;
  }, 15_000);

  it('materializes active page and row evidence with exact visible ranking context', async () => {
    const corpus = await loadRagCorpus(workspaceId);
    expect(corpus.generation).toBe(await loadRagGeneration(workspaceId));
    expect(corpus.points).toHaveLength(5);
    expect(corpus.points.some(({ text }) => text.includes('Archived evidence'))).toBe(false);
    expect(corpus.points.every(({ embed_text, text }) => embed_text === text)).toBe(true);
    expect(corpus.points).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_type: 'page',
        text: 'Canonical evidence\nPage: Local agent memory',
        citation: expect.objectContaining({ type: 'page', part: 'block' }),
      }),
      expect.objectContaining({
        source_type: 'row',
        text: expect.stringContaining('Database: Decisions'),
        citation: expect.objectContaining({
          type: 'row',
          database_name: 'Decisions',
          database_description: 'Architecture choices',
        }),
      }),
    ]));

    await expect(loadRagPoints(workspaceId, {
      page_ids: [pageId],
      row_ids: [],
    })).resolves.toMatchObject({ points: [{ source_type: 'page' }, { source_type: 'page' }] });
    await expect(loadRagPoints(workspaceId, {
      page_ids: [],
      row_ids: [rowId],
    })).resolves.toMatchObject({
      points: [{ source_type: 'row' }, { source_type: 'row' }, { source_type: 'row' }],
    });
  });

  it('finds rows by property name and normalized date value', async () => {
    const scope = {
      kind: 'workspace' as const,
      workspace_id: workspaceId,
      types: ['row' as const],
      session_id: null,
      database_id: null,
    };

    await expect(searchRecords({ query: 'Deadline', scope, limit: 10 })).resolves.toMatchObject({
      records: [expect.objectContaining({ id: rowId, type: 'row' })],
    });
    await expect(searchRecords({ query: '2026-07-15', scope, limit: 10 })).resolves.toMatchObject({
      records: [expect.objectContaining({ id: rowId, type: 'row' })],
    });
    await expect(searchRecords({ query: rowId, scope, limit: 10 })).resolves.toMatchObject({
      records: [expect.objectContaining({ id: rowId, type: 'row' })],
    });
  });

  it('finds exact page ids and returns the winning block excerpt', async () => {
    const scope = {
      kind: 'workspace' as const,
      workspace_id: workspaceId,
      types: ['page' as const],
      session_id: null,
      database_id: null,
    };

    await expect(searchRecords({ query: pageId, scope, limit: 10 })).resolves.toMatchObject({
      records: [expect.objectContaining({ id: pageId, type: 'page' })],
    });
    await expect(searchRecords({ query: 'Canonical evidence', scope, limit: 10 }))
      .resolves.toMatchObject({
        records: [expect.objectContaining({
          id: pageId,
          type: 'page',
          snippet: 'Canonical evidence',
        })],
      });

    const fixture = await adminPool.connect();
    let lateMatchPageId: string | undefined;
    try {
      await fixture.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public, pg_catalog`);
      const { rows } = await fixture.query<{ id: string }>(
        `INSERT INTO pages (workspace_id, title)
         VALUES ($1, 'Late match page')
         RETURNING id`,
        [workspaceId]
      );
      lateMatchPageId = rows[0].id;
      await fixture.query(
        `INSERT INTO blocks (page_id, block_type, content, position)
         VALUES ($1, 'text', repeat('prefix ', 100) || 'Deep needle', 0)`,
        [lateMatchPageId]
      );

      const result = await searchRecords({ query: 'Deep needle', scope, limit: 10 });
      const match = result.records.find(({ id }) => id === lateMatchPageId);
      expect(match?.snippet).toContain('Deep needle');
      expect(match?.snippet.length).toBeLessThanOrEqual(400);
      expect(match?.snippet.indexOf('Deep needle')).toBeLessThan(200);
    } finally {
      if (lateMatchPageId) {
        await fixture.query('DELETE FROM pages WHERE id = $1', [lateMatchPageId]);
      }
      fixture.release();
    }
  });

  it('loads a repeatable corpus under the workspace lock with a one-client pool', async () => {
    await expect(withRagWorkspaceLock(workspaceId, async () => {
      const corpus = await loadRagCorpus(workspaceId);
      return corpus.points.length;
    })).resolves.toBe(5);
  });
});
