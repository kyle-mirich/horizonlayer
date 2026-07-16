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

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await new Promise((resolve) => setTimeout(resolve, 75));
  expect(settled).toBe(false);
}

integrationDescribe('database concurrency invariants', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPgOptions = process.env.PGOPTIONS;
  const schemaName = `hl_concurrency_${randomUUID().replaceAll('-', '')}`;
  let adminPool: pg.Pool;
  let closePool: typeof import('./client.js')['closePool'] | undefined;
  let createRow: typeof import('./queries/rows.js')['createRow'];
  let createPage: typeof import('./queries/pages.js')['createPage'];
  let archivePage: typeof import('./queries/pages.js')['archivePage'];
  let closeSession: typeof import('./queries/sessions.js')['closeSession'];
  let startRun: typeof import('./queries/runs.js')['startRun'];
  let createLink: typeof import('./queries/links.js')['createLink'];
  let archiveLink: typeof import('./queries/links.js')['archiveLink'];
  let restoreLink: typeof import('./queries/links.js')['restoreLink'];
  let updateDatabaseProperty: typeof import('./queries/databases.js')['updateDatabaseProperty'];
  let archiveWorkspace: typeof import('./queries/workspaces.js')['archiveWorkspace'];
  let workspaceId: string;
  let firstDatabaseId: string;
  let firstTitlePropertyId: string;
  let firstStatusPropertyId: string;
  let secondDatabaseId: string;
  let secondStatusPropertyId: string;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: integrationDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);

    const setup = await adminPool.connect();
    try {
      await setTestSearchPath(setup, schemaName);
      await setup.query(schemaSql);
      const { rows: workspaces } = await setup.query<{ id: string }>(
        `INSERT INTO workspaces (name)
         VALUES ($1)
         RETURNING id`,
        [`Concurrency ${schemaName}`]
      );
      workspaceId = workspaces[0].id;

      const { rows: databases } = await setup.query<{ id: string; name: string }>(
        `INSERT INTO databases (workspace_id, name)
         VALUES ($1, 'First'), ($1, 'Second')
         RETURNING id, name`,
        [workspaceId]
      );
      firstDatabaseId = databases.find((database) =>
        database.name === 'First'
      )?.id ?? databases[0].id;
      secondDatabaseId = databases.find((database) =>
        database.name === 'Second'
      )?.id ?? databases[1].id;

      const { rows: properties } = await setup.query<{
        id: string;
        database_id: string;
        name: string;
      }>(
        `INSERT INTO database_properties
           (database_id, name, property_type, options, position)
         VALUES
           ($1, 'Title', 'title', '{}'::jsonb, 0),
           ($1, 'Status', 'select', '{"choices":["Open"]}'::jsonb, 1),
           ($2, 'Title', 'title', '{}'::jsonb, 0),
           ($2, 'Status', 'select', '{"choices":["Open"]}'::jsonb, 1)
         RETURNING id, database_id, name`,
        [firstDatabaseId, secondDatabaseId]
      );
      firstTitlePropertyId = properties.find((property) =>
        property.database_id === firstDatabaseId && property.name === 'Title'
      )!.id;
      firstStatusPropertyId = properties.find((property) =>
        property.database_id === firstDatabaseId && property.name === 'Status'
      )!.id;
      secondStatusPropertyId = properties.find((property) =>
        property.database_id === secondDatabaseId && property.name === 'Status'
      )!.id;
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
    ({ createRow } = await import('./queries/rows.js'));
    ({ archivePage, createPage } = await import('./queries/pages.js'));
    ({ closeSession } = await import('./queries/sessions.js'));
    ({ startRun } = await import('./queries/runs.js'));
    ({ archiveLink, createLink, restoreLink } = await import('./queries/links.js'));
    ({ updateDatabaseProperty } = await import('./queries/databases.js'));
    ({ archiveWorkspace } = await import('./queries/workspaces.js'));
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

  it('waits for an in-flight row write before validating reduced choices', async () => {
    const writer = await adminPool.connect();
    await setTestSearchPath(writer, schemaName);
    let transactionOpen = false;
    let mutation: ReturnType<typeof updateDatabaseProperty> | undefined;
    try {
      await writer.query('BEGIN');
      transactionOpen = true;
      await writer.query('SELECT id FROM databases WHERE id = $1 FOR SHARE', [firstDatabaseId]);
      const { rows } = await writer.query<{ id: string }>(
        `INSERT INTO database_rows (database_id)
         VALUES ($1)
         RETURNING id`,
        [firstDatabaseId]
      );
      await writer.query(
        `INSERT INTO database_row_values (row_id, property_id, value_text)
         VALUES ($1, $2, 'Created while locked'), ($1, $3, 'Open')`,
        [rows[0].id, firstTitlePropertyId, firstStatusPropertyId]
      );

      mutation = updateDatabaseProperty(firstStatusPropertyId, {
        revision: 1,
        options: { choices: ['Done'] },
      });
      await expectStillPending(mutation);

      await writer.query('COMMIT');
      transactionOpen = false;
      await expect(mutation).rejects.toThrow('would invalidate existing row values');
    } finally {
      if (transactionOpen) await writer.query('ROLLBACK');
      writer.release();
      if (mutation) await mutation.catch(() => undefined);
    }
  });

  it('makes row creation wait for committed property choices and validate the new schema', async () => {
    const schemaWriter = await adminPool.connect();
    await setTestSearchPath(schemaWriter, schemaName);
    let transactionOpen = false;
    let rowWrite: ReturnType<typeof createRow> | undefined;
    try {
      await schemaWriter.query('BEGIN');
      transactionOpen = true;
      await schemaWriter.query(
        'SELECT id FROM databases WHERE id = $1 FOR UPDATE',
        [secondDatabaseId]
      );
      await schemaWriter.query(
        `UPDATE database_properties
         SET options = '{"choices":["Done"]}'::jsonb
         WHERE id = $1`,
        [secondStatusPropertyId]
      );

      rowWrite = createRow({
        database_id: secondDatabaseId,
        values: { Title: 'Wait for schema', Status: 'Open' },
      });
      await expectStillPending(rowWrite);

      await schemaWriter.query('COMMIT');
      transactionOpen = false;
      await expect(rowWrite).rejects.toThrow('Status must be one of: Done');
    } finally {
      if (transactionOpen) await schemaWriter.query('ROLLBACK');
      schemaWriter.release();
      if (rowWrite) await rowWrite.catch(() => undefined);
    }
  });

  it('serializes page and run starts before a concurrent session close', async () => {
    const starters = [
      {
        label: 'page',
        start: (sessionId: string) => createPage({
          session_id: sessionId,
          title: 'Created before close',
          workspace_id: workspaceId,
        }),
      },
      {
        label: 'run',
        start: (sessionId: string) => startRun({
          agent_name: 'concurrency-test',
          session_id: sessionId,
          title: 'Started before close',
          workspace_id: workspaceId,
        }),
      },
    ];

    for (const starter of starters) {
      const setup = await adminPool.connect();
      await setTestSearchPath(setup, schemaName);
      const { rows: sessions } = await setup.query<{ id: string }>(
        `INSERT INTO sessions (workspace_id, title)
         VALUES ($1, $2)
         RETURNING id`,
        [workspaceId, `Concurrent ${starter.label}`]
      );
      setup.release();
      const sessionId = sessions[0].id;

      const workspaceBlocker = await adminPool.connect();
      await setTestSearchPath(workspaceBlocker, schemaName);
      let transactionOpen = false;
      let startPromise: ReturnType<typeof starter.start> | undefined;
      let closePromise: ReturnType<typeof closeSession> | undefined;
      try {
        await workspaceBlocker.query('BEGIN');
        transactionOpen = true;
        await workspaceBlocker.query(
          'SELECT id FROM workspaces WHERE id = $1 FOR UPDATE',
          [workspaceId]
        );

        startPromise = starter.start(sessionId);

        const deadline = Date.now() + 2_000;
        let sessionLocked = false;
        while (Date.now() < deadline && !sessionLocked) {
          const probe = await adminPool.connect();
          try {
            await setTestSearchPath(probe, schemaName);
            await probe.query(
              'SELECT id FROM sessions WHERE id = $1 FOR UPDATE NOWAIT',
              [sessionId]
            );
          } catch (error) {
            if ((error as { code?: string }).code === '55P03') sessionLocked = true;
            else throw error;
          } finally {
            probe.release();
          }
          if (!sessionLocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(sessionLocked).toBe(true);

        closePromise = closeSession(sessionId);
        await expectStillPending(closePromise);

        await workspaceBlocker.query('COMMIT');
        transactionOpen = false;
        await expect(startPromise).resolves.toBeTruthy();
        await expect(closePromise).resolves.toMatchObject({ status: 'closed' });
      } finally {
        if (transactionOpen) await workspaceBlocker.query('ROLLBACK');
        workspaceBlocker.release();
        if (startPromise) await startPromise.catch(() => undefined);
        if (closePromise) await closePromise.catch(() => undefined);
      }
    }
  });

  it('rejects child creation when a concurrent parent archive wins', async () => {
    const setup = await adminPool.connect();
    await setTestSearchPath(setup, schemaName);
    const { rows: parents } = await setup.query<{ id: string }>(
      `INSERT INTO pages (workspace_id, title)
       VALUES ($1, 'Parent being archived')
       RETURNING id`,
      [workspaceId]
    );
    setup.release();
    const parentId = parents[0].id;

    const workspaceBlocker = await adminPool.connect();
    await setTestSearchPath(workspaceBlocker, schemaName);
    let transactionOpen = false;
    let archivePromise: ReturnType<typeof archivePage> | undefined;
    let childPromise: ReturnType<typeof createPage> | undefined;
    try {
      await workspaceBlocker.query('BEGIN');
      transactionOpen = true;
      await workspaceBlocker.query(
        'SELECT id FROM workspaces WHERE id = $1 FOR UPDATE',
        [workspaceId]
      );

      archivePromise = archivePage(parentId, 1);
      const deadline = Date.now() + 2_000;
      let parentLocked = false;
      while (Date.now() < deadline && !parentLocked) {
        const probe = await adminPool.connect();
        try {
          await setTestSearchPath(probe, schemaName);
          await probe.query('SELECT id FROM pages WHERE id = $1 FOR UPDATE NOWAIT', [parentId]);
        } catch (error) {
          if ((error as { code?: string }).code === '55P03') parentLocked = true;
          else throw error;
        } finally {
          probe.release();
        }
        if (!parentLocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(parentLocked).toBe(true);

      childPromise = createPage({
        parent_page_id: parentId,
        title: 'Must not attach after archive',
        workspace_id: workspaceId,
      });
      await expectStillPending(childPromise);

      await workspaceBlocker.query('COMMIT');
      transactionOpen = false;
      await expect(archivePromise).resolves.toMatchObject({ archived_at: expect.anything() });
      await expect(childPromise).rejects.toThrow(`Page ${parentId} not found`);
    } finally {
      if (transactionOpen) await workspaceBlocker.query('ROLLBACK');
      workspaceBlocker.release();
      if (archivePromise) await archivePromise.catch(() => undefined);
      if (childPromise) await childPromise.catch(() => undefined);
    }
  });

  it('rejects link creation and restoration against archived endpoints', async () => {
    const endpoint = await createPage({
      title: 'Link endpoint',
      workspace_id: workspaceId,
    });
    const link = await createLink({
      from_id: workspaceId,
      from_type: 'workspace',
      to_id: endpoint.id,
      to_type: 'page',
      workspace_id: workspaceId,
    });
    const archivedLink = await archiveLink(link.id, link.revision);
    expect(archivedLink).not.toBeNull();
    await archivePage(endpoint.id, endpoint.revision);

    await expect(createLink({
      from_id: workspaceId,
      from_type: 'workspace',
      to_id: endpoint.id,
      to_type: 'page',
      workspace_id: workspaceId,
    })).rejects.toThrow(`Page ${endpoint.id} not found`);
    await expect(restoreLink(link.id, archivedLink!.revision)).rejects.toThrow(
      `Page ${endpoint.id} not found`
    );
  });

  it('locks a block parent page before a preceding database endpoint', async () => {
    const setup = await adminPool.connect();
    await setTestSearchPath(setup, schemaName);
    const { rows: pages } = await setup.query<{ id: string }>(
      `INSERT INTO pages (workspace_id, title)
       VALUES ($1, 'Lock-plan page')
       RETURNING id`,
      [workspaceId]
    );
    const pageId = pages[0].id;
    const { rows: blocks } = await setup.query<{ id: string }>(
      `INSERT INTO blocks (page_id, block_type, content, position)
       VALUES ($1, 'text', 'Lock-plan block', 0)
       RETURNING id`,
      [pageId]
    );
    setup.release();
    const blockId = blocks[0].id;

    const databaseBlocker = await adminPool.connect();
    await setTestSearchPath(databaseBlocker, schemaName);
    let transactionOpen = false;
    let pageDatabaseLink: ReturnType<typeof createLink> | undefined;
    let databaseBlockLink: ReturnType<typeof createLink> | undefined;
    try {
      await databaseBlocker.query('BEGIN');
      transactionOpen = true;
      await databaseBlocker.query(
        'SELECT id FROM databases WHERE id = $1 FOR UPDATE',
        [firstDatabaseId]
      );

      // Caller order is database -> block, but the block resolves to pageId.
      // The global plan must lock pageId before waiting on firstDatabaseId.
      databaseBlockLink = createLink({
        from_id: firstDatabaseId,
        from_type: 'database',
        to_id: blockId,
        to_type: 'block',
        workspace_id: workspaceId,
      });

      const deadline = Date.now() + 2_000;
      let pageLocked = false;
      while (Date.now() < deadline && !pageLocked) {
        const probe = await adminPool.connect();
        try {
          await setTestSearchPath(probe, schemaName);
          await probe.query('SELECT id FROM pages WHERE id = $1 FOR UPDATE NOWAIT', [pageId]);
        } catch (error) {
          if ((error as { code?: string }).code === '55P03') pageLocked = true;
          else throw error;
        } finally {
          probe.release();
        }
        if (!pageLocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(pageLocked).toBe(true);
      await expectStillPending(databaseBlockLink);

      // This is the reverse graph: page -> database. It must converge on the
      // same actual page -> database lock plan.
      pageDatabaseLink = createLink({
        from_id: pageId,
        from_type: 'page',
        to_id: firstDatabaseId,
        to_type: 'database',
        workspace_id: workspaceId,
      });
      await expectStillPending(pageDatabaseLink);

      await databaseBlocker.query('COMMIT');
      transactionOpen = false;
      await expect(databaseBlockLink).resolves.toMatchObject({
        from_id: firstDatabaseId,
        to_id: blockId,
      });
      await expect(pageDatabaseLink).resolves.toMatchObject({
        from_id: pageId,
        to_id: firstDatabaseId,
      });
    } finally {
      if (transactionOpen) await databaseBlocker.query('ROLLBACK');
      databaseBlocker.release();
      if (pageDatabaseLink) await pageDatabaseLink.catch(() => undefined);
      if (databaseBlockLink) await databaseBlockLink.catch(() => undefined);
    }
  });

  it('makes workspace archive wait for child writes and rejects later direct writes', async () => {
    const childWriter = await adminPool.connect();
    await setTestSearchPath(childWriter, schemaName);
    let transactionOpen = false;
    let archive: ReturnType<typeof archiveWorkspace> | undefined;
    try {
      await childWriter.query('BEGIN');
      transactionOpen = true;
      await childWriter.query(
        `INSERT INTO sessions (workspace_id, title)
         VALUES ($1, 'In flight')`,
        [workspaceId]
      );

      archive = archiveWorkspace(workspaceId, 1);
      await expectStillPending(archive);

      await childWriter.query('COMMIT');
      transactionOpen = false;
      await expect(archive).resolves.toMatchObject({ archived_at: expect.anything() });

      await expect(childWriter.query(
        `INSERT INTO sessions (workspace_id, title)
         VALUES ($1, 'Too late')`,
        [workspaceId]
      )).rejects.toThrow('does not exist or is archived');
      await expect(childWriter.query(
        `UPDATE database_row_values
         SET value_text = value_text
         WHERE property_id = $1`,
        [firstStatusPropertyId]
      )).rejects.toThrow('does not exist or is archived');
    } finally {
      if (transactionOpen) await childWriter.query('ROLLBACK');
      childWriter.release();
      if (archive) await archive.catch(() => undefined);
    }
  });
});
