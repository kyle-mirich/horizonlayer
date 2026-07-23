import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './client.js';

const INITIALIZATION_LOCK_ID = 7_243_612_901;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(moduleDirectory, '..', '..', 'schema.sql');

export async function initializeDatabase(): Promise<void> {
  const client = await getPool().connect();
  let transactionStarted = false;

  try {
    const schema = readFileSync(schemaPath, 'utf8');
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SELECT pg_advisory_xact_lock($1)', [INITIALIZATION_LOCK_ID]);
    await client.query('SET LOCAL search_path = public, pg_catalog');
    await client.query(schema);
    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Database initialization and rollback both failed'
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
