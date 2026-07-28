import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from './transaction.js';

const INITIALIZATION_LOCK_ID = 7_243_612_901;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(moduleDirectory, '..', '..', 'schema.sql');

export async function initializeDatabase(): Promise<void> {
  const schema = readFileSync(schemaPath, 'utf8');
  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [INITIALIZATION_LOCK_ID]);
    await client.query('SET LOCAL search_path = public, pg_catalog');
    await client.query(schema);
  }, { failureContext: 'Database initialization' });
}
