import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const integrationDatabaseUrl = process.env.HORIZONLAYER_INTEGRATION_DATABASE_URL;
const integrationDescribe = integrationDatabaseUrl ? describe.sequential : describe.skip;
const schemaSql = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function setTestSearchPath(client: PoolClient, schemaName: string): Promise<void> {
  await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public, pg_catalog`);
  await client.query("SET statement_timeout = '5s'");
}

integrationDescribe('workspace search generation', () => {
  const schemaName = `hl_search_generation_${randomUUID().replaceAll('-', '')}`;
  let adminPool: pg.Pool;
  let client: PoolClient;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    client = await adminPool.connect();
    await setTestSearchPath(client, schemaName);
    await client.query(schemaSql);
  }, 15_000);

  afterAll(async () => {
    client?.release();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      await adminPool.end();
    }
  }, 15_000);

  async function generation(workspaceId: string): Promise<bigint> {
    const { rows } = await client.query<{ search_generation: string }>(
      `SELECT COUNT(*)::text AS search_generation
       FROM workspace_search_changes
       WHERE workspace_id = $1`,
      [workspaceId]
    );
    return BigInt(rows[0].search_generation);
  }

  async function canonicalMutation<Row extends QueryResultRow = QueryResultRow>(
    workspaceId: string,
    sql: string,
    values: unknown[] = []
  ): Promise<Row[]> {
    const before = await generation(workspaceId);
    const { rows } = await client.query<Row>(sql, values);
    expect(await generation(workspaceId)).toBe(before + 1n);
    return rows;
  }

  async function operationalMutation<Row extends QueryResultRow = QueryResultRow>(
    workspaceId: string,
    sql: string,
    values: unknown[] = []
  ): Promise<Row[]> {
    const before = await generation(workspaceId);
    const { rows } = await client.query<Row>(sql, values);
    expect(await generation(workspaceId)).toBe(before);
    return rows;
  }

  it('advances for every canonical table operation but not operational writes', async () => {
    const [{ id: workspaceId, revision, updated_at: updatedAt }] = (
      await client.query<{ id: string; revision: number; updated_at: Date }>(
        `INSERT INTO workspaces (name)
         VALUES ($1)
         RETURNING id, revision, updated_at`,
        [`Generation ${schemaName}`]
      )
    ).rows;

    const [{ id: pageId }] = await canonicalMutation<{ id: string }>(
      workspaceId,
      `INSERT INTO pages (workspace_id, title)
       VALUES ($1, 'Canonical page')
       RETURNING id`,
      [workspaceId]
    );
    const [{ id: blockId }] = await canonicalMutation<{ id: string }>(
      workspaceId,
      `INSERT INTO blocks (page_id, block_type, content, position)
       VALUES ($1, 'text', 'Canonical block', 0)
       RETURNING id`,
      [pageId]
    );
    const [{ id: databaseId }] = await canonicalMutation<{ id: string }>(
      workspaceId,
      `INSERT INTO databases (workspace_id, name)
       VALUES ($1, 'Canonical database')
       RETURNING id`,
      [workspaceId]
    );
    const [{ id: propertyId }] = await canonicalMutation<{ id: string }>(
      workspaceId,
      `INSERT INTO database_properties
         (database_id, name, property_type, position)
       VALUES ($1, 'Title', 'title', 0)
       RETURNING id`,
      [databaseId]
    );
    const [{ id: rowId }] = await canonicalMutation<{ id: string }>(
      workspaceId,
      `INSERT INTO database_rows (database_id)
       VALUES ($1)
       RETURNING id`,
      [databaseId]
    );
    const [{ id: valueId }] = await canonicalMutation<{ id: string }>(
      workspaceId,
      `INSERT INTO database_row_values (row_id, property_id, value_text)
       VALUES ($1, $2, 'Canonical row')
       RETURNING id`,
      [rowId, propertyId]
    );

    const generationBeforeNoOp = await generation(workspaceId);
    await client.query('UPDATE pages SET title = title WHERE id = $1', [pageId]);
    expect(await generation(workspaceId)).toBe(generationBeforeNoOp);

    const [{ id: sessionId }] = await operationalMutation<{ id: string }>(
      workspaceId,
      `INSERT INTO sessions (workspace_id, title)
       VALUES ($1, 'Operational session')
       RETURNING id`,
      [workspaceId]
    );
    await operationalMutation(
      workspaceId,
      `UPDATE sessions SET summary = 'Still operational' WHERE id = $1`,
      [sessionId]
    );
    await operationalMutation(workspaceId, 'DELETE FROM sessions WHERE id = $1', [sessionId]);

    const [{ id: runId }] = await operationalMutation<{ id: string }>(
      workspaceId,
      `INSERT INTO agent_runs (workspace_id, agent_name)
       VALUES ($1, 'generation-test')
       RETURNING id`,
      [workspaceId]
    );
    const [{ id: checkpointId }] = await operationalMutation<{ id: string }>(
      workspaceId,
      `INSERT INTO run_checkpoints (run_id, sequence, state)
       VALUES ($1, 1, '{"step":1}'::jsonb)
       RETURNING id`,
      [runId]
    );
    await operationalMutation(
      workspaceId,
      `UPDATE run_checkpoints SET state = '{"step":2}'::jsonb WHERE id = $1`,
      [checkpointId]
    );
    await operationalMutation(
      workspaceId,
      'DELETE FROM run_checkpoints WHERE id = $1',
      [checkpointId]
    );
    await operationalMutation(
      workspaceId,
      `UPDATE agent_runs SET title = 'Still operational' WHERE id = $1`,
      [runId]
    );
    await operationalMutation(workspaceId, 'DELETE FROM agent_runs WHERE id = $1', [runId]);

    const [{ id: linkId }] = await operationalMutation<{ id: string }>(
      workspaceId,
      `INSERT INTO links
         (workspace_id, from_type, from_id, to_type, to_id)
       VALUES ($1, 'workspace', $1, 'page', $2)
       RETURNING id`,
      [workspaceId, pageId]
    );
    await operationalMutation(
      workspaceId,
      'UPDATE links SET archived_at = NOW() WHERE id = $1',
      [linkId]
    );
    await operationalMutation(workspaceId, 'DELETE FROM links WHERE id = $1', [linkId]);

    await canonicalMutation(
      workspaceId,
      `UPDATE pages SET title = 'Updated page' WHERE id = $1`,
      [pageId]
    );
    await canonicalMutation(
      workspaceId,
      `UPDATE blocks SET content = 'Updated block' WHERE id = $1`,
      [blockId]
    );
    await canonicalMutation(
      workspaceId,
      `UPDATE databases SET description = 'Updated database' WHERE id = $1`,
      [databaseId]
    );
    await canonicalMutation(
      workspaceId,
      `UPDATE database_properties SET name = 'Name' WHERE id = $1`,
      [propertyId]
    );
    await canonicalMutation(
      workspaceId,
      `UPDATE database_rows SET tags = ARRAY['updated'] WHERE id = $1`,
      [rowId]
    );
    await canonicalMutation(
      workspaceId,
      `UPDATE database_row_values SET value_text = 'Updated row' WHERE id = $1`,
      [valueId]
    );

    await canonicalMutation(
      workspaceId,
      'DELETE FROM database_row_values WHERE id = $1',
      [valueId]
    );
    await canonicalMutation(workspaceId, 'DELETE FROM blocks WHERE id = $1', [blockId]);
    await canonicalMutation(workspaceId, 'DELETE FROM database_rows WHERE id = $1', [rowId]);
    await canonicalMutation(
      workspaceId,
      'DELETE FROM database_properties WHERE id = $1',
      [propertyId]
    );
    await canonicalMutation(workspaceId, 'DELETE FROM databases WHERE id = $1', [databaseId]);
    await canonicalMutation(workspaceId, 'DELETE FROM pages WHERE id = $1', [pageId]);

    const { rows: workspaceRows } = await client.query<{
      revision: number;
      updated_at: Date;
    }>(
      'SELECT revision, updated_at FROM workspaces WHERE id = $1',
      [workspaceId]
    );
    expect(workspaceRows[0].revision).toBe(revision);
    expect(workspaceRows[0].updated_at.toISOString()).toBe(updatedAt.toISOString());
  });

  it('advances both workspaces for a canonical cross-workspace move', async () => {
    const { rows: workspaces } = await client.query<{ id: string }>(
      `INSERT INTO workspaces (name)
       VALUES ($1), ($2)
       RETURNING id, name`,
      [`Move source ${schemaName}`, `Move target ${schemaName}`]
    );
    const [sourceId, targetId] = workspaces.map(({ id }) => id);
    const { rows: pages } = await client.query<{ id: string }>(
      `INSERT INTO pages (workspace_id, title)
       VALUES ($1, 'Moving page')
       RETURNING id`,
      [sourceId]
    );
    const sourceBefore = await generation(sourceId);
    const targetBefore = await generation(targetId);

    await client.query('UPDATE pages SET workspace_id = $1 WHERE id = $2', [
      targetId,
      pages[0].id,
    ]);

    expect(await generation(sourceId)).toBe(sourceBefore + 1n);
    expect(await generation(targetId)).toBe(targetBefore + 1n);
  });

  it('keeps concurrent canonical writers independent until commit', async () => {
    const { rows: workspaces } = await client.query<{ id: string }>(
      `INSERT INTO workspaces (name)
       VALUES ($1)
       RETURNING id`,
      [`Concurrent ${schemaName}`]
    );
    const workspaceId = workspaces[0].id;
    const before = await generation(workspaceId);
    const first = await adminPool.connect();
    const second = await adminPool.connect();
    let firstOpen = false;
    let secondOpen = false;
    try {
      await setTestSearchPath(first, schemaName);
      await setTestSearchPath(second, schemaName);
      await first.query('BEGIN');
      firstOpen = true;
      await first.query(
        `INSERT INTO pages (workspace_id, title)
         VALUES ($1, 'First concurrent writer')`,
        [workspaceId]
      );

      await second.query('BEGIN');
      secondOpen = true;
      await expect(second.query(
        `INSERT INTO pages (workspace_id, title)
         VALUES ($1, 'Second concurrent writer')`,
        [workspaceId]
      )).resolves.toMatchObject({ rowCount: 1 });
      await second.query('COMMIT');
      secondOpen = false;
      expect(await generation(workspaceId)).toBe(before + 1n);

      await first.query('COMMIT');
      firstOpen = false;
      expect(await generation(workspaceId)).toBe(before + 2n);
    } finally {
      if (secondOpen) await second.query('ROLLBACK');
      if (firstOpen) await first.query('ROLLBACK');
      second.release();
      first.release();
    }
  });

  it('keeps canonical cascade deletes safe and observable', async () => {
    const { rows: workspaces } = await client.query<{ id: string }>(
      `INSERT INTO workspaces (name)
       VALUES ($1)
       RETURNING id`,
      [`Cascade ${schemaName}`]
    );
    const workspaceId = workspaces[0].id;
    const { rows: pages } = await client.query<{ id: string }>(
      `INSERT INTO pages (workspace_id, title)
       VALUES ($1, 'Cascade page')
       RETURNING id`,
      [workspaceId]
    );
    await client.query(
      `INSERT INTO blocks (page_id, block_type, content, position)
       VALUES ($1, 'text', 'Cascade block', 0)`,
      [pages[0].id]
    );
    const beforePageDelete = await generation(workspaceId);
    await client.query('DELETE FROM pages WHERE id = $1', [pages[0].id]);
    expect(await generation(workspaceId)).toBeGreaterThan(beforePageDelete);

    const { rows: databases } = await client.query<{ id: string }>(
      `INSERT INTO databases (workspace_id, name)
       VALUES ($1, 'Cascade database')
       RETURNING id`,
      [workspaceId]
    );
    const { rows: properties } = await client.query<{ id: string }>(
      `INSERT INTO database_properties
         (database_id, name, property_type, position)
       VALUES ($1, 'Title', 'title', 0)
       RETURNING id`,
      [databases[0].id]
    );
    const { rows: databaseRows } = await client.query<{ id: string }>(
      `INSERT INTO database_rows (database_id)
       VALUES ($1)
       RETURNING id`,
      [databases[0].id]
    );
    await client.query(
      `INSERT INTO database_row_values (row_id, property_id, value_text)
       VALUES ($1, $2, 'Cascade row')`,
      [databaseRows[0].id, properties[0].id]
    );
    const beforeDatabaseDelete = await generation(workspaceId);
    await client.query('DELETE FROM databases WHERE id = $1', [databases[0].id]);
    expect(await generation(workspaceId)).toBeGreaterThan(beforeDatabaseDelete);

    await expect(client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]))
      .resolves.toMatchObject({ rowCount: 1 });
  });

  it('deletes a populated workspace without journaling orphaned cascade events', async () => {
    const { rows: workspaces } = await client.query<{ id: string }>(
      `INSERT INTO workspaces (name)
       VALUES ($1)
       RETURNING id`,
      [`Populated cascade ${schemaName}`]
    );
    const workspaceId = workspaces[0].id;
    const { rows: pages } = await client.query<{ id: string }>(
      `INSERT INTO pages (workspace_id, title)
       VALUES ($1, 'Populated page')
       RETURNING id`,
      [workspaceId]
    );
    await client.query(
      `INSERT INTO blocks (page_id, block_type, content, position)
       VALUES ($1, 'text', 'Populated block', 0)`,
      [pages[0].id]
    );
    const { rows: databases } = await client.query<{ id: string }>(
      `INSERT INTO databases (workspace_id, name)
       VALUES ($1, 'Populated database')
       RETURNING id`,
      [workspaceId]
    );
    const { rows: properties } = await client.query<{ id: string }>(
      `INSERT INTO database_properties (database_id, name, property_type, position)
       VALUES ($1, 'Title', 'title', 0)
       RETURNING id`,
      [databases[0].id]
    );
    const { rows: databaseRows } = await client.query<{ id: string }>(
      `INSERT INTO database_rows (database_id)
       VALUES ($1)
       RETURNING id`,
      [databases[0].id]
    );
    await client.query(
      `INSERT INTO database_row_values (row_id, property_id, value_text)
       VALUES ($1, $2, 'Populated row')`,
      [databaseRows[0].id, properties[0].id]
    );

    await expect(client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]))
      .resolves.toMatchObject({ rowCount: 1 });
    const { rows: changes } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM workspace_search_changes
       WHERE workspace_id = $1`,
      [workspaceId]
    );
    expect(changes[0].count).toBe('0');
  });
});
