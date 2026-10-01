import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as PageQueries from './queries/pages.js';
import type * as DatabaseQueries from './queries/databases.js';
import type * as RowQueries from './queries/rows.js';

const databaseUrl = process.env.HORIZONLAYER_INTEGRATION_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe.sequential : describe.skip;
const schemaSql = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');

integrationDescribe('aggregate revision contracts', () => {
  const schemaName = `hl_aggregate_${randomUUID().replaceAll('-', '')}`;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPgOptions = process.env.PGOPTIONS;
  let pool: pg.Pool;
  let closePool: typeof import('./client.js')['closePool'];
  let pages: typeof PageQueries;
  let databases: typeof DatabaseQueries;
  let rows: typeof RowQueries;
  let workspaceId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    const setup = await pool.connect();
    try {
      await setup.query(`SET search_path TO "${schemaName}", public, pg_catalog`);
      await setup.query(schemaSql);
      const result = await setup.query<{ id: string }>(
        "INSERT INTO workspaces (name) VALUES ('Aggregate revisions') RETURNING id"
      );
      workspaceId = result.rows[0].id;
    } finally {
      setup.release();
    }
    process.env.DATABASE_URL = databaseUrl;
    process.env.PGOPTIONS = `-c search_path=${schemaName},public,pg_catalog`;
    vi.resetModules();
    ({ closePool } = await import('./client.js'));
    pages = await import('./queries/pages.js');
    databases = await import('./queries/databases.js');
    rows = await import('./queries/rows.js');
  }, 15_000);

  afterAll(async () => {
    if (closePool) await closePool();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPgOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = originalPgOptions;
  }, 15_000);

  it('advances page revisions after appends and rejects a stale append', async () => {
    const page = await pages.createPage({ workspace_id: workspaceId, title: 'Appends' });
    const appended = await pages.appendPageBlocks(page.id, [{ block_type: 'text', content: 'First' }], {
      revision: page.revision,
    });
    expect(appended.page_revision).toBe(2);
    await expect(pages.appendPageBlocks(page.id, [{ block_type: 'text', content: 'Stale' }], {
      revision: page.revision,
    })).rejects.toThrow('Conflict:');
    expect(await pages.getPage(page.id)).toMatchObject({
      revision: 2,
      blocks: [{ content: 'First' }],
    });
  });

  it('advances the page revision on block edit, archive, and restore', async () => {
    const page = await pages.createPage({
      workspace_id: workspaceId,
      title: 'Block lifecycle',
      blocks: [{ block_type: 'text', content: 'Original' }],
    });
    const block = page.blocks[0];
    const edited = await pages.updatePageBlock(block.id, { revision: 1, content: 'Edited' });
    expect(edited).toMatchObject({ page_revision: 2, block: { revision: 2 } });
    const archived = await pages.archivePageBlock(block.id, 2);
    expect(archived).toMatchObject({ page_revision: 3, block: { revision: 3 } });
    const restored = await pages.restorePageBlock(block.id, 3);
    expect(restored).toMatchObject({ page_revision: 4, block: { revision: 4 } });
    expect(await pages.getPage(page.id)).toMatchObject({ revision: 4 });
    await expect(pages.updatePage(page.id, { revision: 1, title: 'Stale' }))
      .rejects.toThrow('Conflict:');
  });

  it('advances database revisions for property changes and rejects stale additions', async () => {
    const database = await databases.createDatabase({ workspace_id: workspaceId, name: 'Schema' });
    const added = await databases.addDatabaseProperty(database.id, {
      database_revision: database.revision, name: 'Notes', property_type: 'text',
    });
    expect(added.database_revision).toBe(2);
    await expect(databases.addDatabaseProperty(database.id, {
      database_revision: database.revision, name: 'Stale', property_type: 'text',
    })).rejects.toThrow('Conflict:');
    const updated = await databases.updateDatabaseProperty(added.property.id, {
      revision: added.property.revision, name: 'Details',
    });
    expect(updated).toMatchObject({ database_revision: 3, property: { revision: 2 } });
    const archived = await databases.archiveDatabaseProperty(added.property.id, 2);
    expect(archived).toMatchObject({ database_revision: 4, property: { revision: 3 } });
    const restored = await databases.restoreDatabaseProperty(added.property.id, 3);
    expect(restored).toMatchObject({ database_revision: 5, property: { revision: 4 } });
    expect(await databases.getDatabase(database.id)).toMatchObject({ revision: 5 });
  });

  it('allows only one concurrent values-only row update at the same revision', async () => {
    const database = await databases.createDatabase({ workspace_id: workspaceId, name: 'Rows' });
    const row = await rows.createRow({ database_id: database.id, values: { Title: 'Original' } });
    const results = await Promise.allSettled([
      rows.updateRow(row.id, { revision: row.revision, values: { Title: 'Writer A' } }),
      rows.updateRow(row.id, { revision: row.revision, values: { Title: 'Writer B' } }),
    ]);
    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({ message: expect.stringContaining('Conflict:') });
    expect(successes[0].value).toMatchObject({ revision: 2 });
    expect(await rows.getRow(row.id)).toMatchObject(successes[0].value!);
  });

  it('rolls back the aggregate revision when child validation fails', async () => {
    const database = await databases.createDatabase({ workspace_id: workspaceId, name: 'Rollback' });
    await expect(databases.addDatabaseProperty(database.id, {
      database_revision: database.revision, name: 'Title', property_type: 'text',
    })).rejects.toThrow('already exists');
    expect(await databases.getDatabase(database.id)).toMatchObject({ revision: 1 });
    const added = await databases.addDatabaseProperty(database.id, {
      database_revision: 1, name: 'Valid', property_type: 'text',
    });
    expect(added.database_revision).toBe(2);
  });

  it('consumes aggregate revision intent only for its target record within the transaction', async () => {
    const first = await pages.createPage({ workspace_id: workspaceId, title: 'Target' });
    const second = await pages.createPage({ workspace_id: workspaceId, title: 'Other record' });
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schemaName}", public, pg_catalog`);
      await client.query('BEGIN');
      await client.query("SELECT set_config('horizonlayer.revision_target', $1, true)", [`pages:${first.id}`]);
      const untouched = await client.query<{ revision: number }>(
        'UPDATE pages SET revision = revision + 1 WHERE id = $1 RETURNING revision', [second.id]
      );
      expect(untouched.rows[0].revision).toBe(1);
      const advanced = await client.query<{ revision: number }>(
        'UPDATE pages SET revision = revision + 1 WHERE id = $1 RETURNING revision', [first.id]
      );
      expect(advanced.rows[0].revision).toBe(2);
      const bareTouch = await client.query<{ revision: number }>(
        'UPDATE pages SET revision = revision + 1 WHERE id = $1 RETURNING revision', [first.id]
      );
      expect(bareTouch.rows[0].revision).toBe(2);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await pages.getPage(first.id)).toMatchObject({ revision: 1 });
  });
});
