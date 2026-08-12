import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from './transaction.js';

const INITIALIZATION_LOCK_ID = 7_243_612_901;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(moduleDirectory, '..', '..', 'schema.sql');
const migrationPath = join(moduleDirectory, '..', '..', 'migrations', '0002_issue_modules_v3.sql');

export async function initializeDatabase(): Promise<void> {
  const schema = readFileSync(schemaPath, 'utf8');
  const migration = readFileSync(migrationPath, 'utf8');
  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [INITIALIZATION_LOCK_ID]);
    await client.query('SET LOCAL search_path = public, pg_catalog');
    const { rows } = await client.query<{
      migrations: string | null;
      workspaces: string | null;
    }>(
      `SELECT to_regclass('schema_migrations')::text AS migrations,
              to_regclass('workspaces')::text AS workspaces`
    );
    if (rows[0]?.workspaces && !rows[0].migrations) {
      await client.query(migration);
    }
    await client.query(schema);
  }, { failureContext: 'Database initialization' });
}
