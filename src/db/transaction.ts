import { getPool, type PoolClient } from './client.js';

export type TransactionIsolationLevel =
  | 'read committed'
  | 'repeatable read'
  | 'serializable';

export interface TransactionOptions {
  isolationLevel?: TransactionIsolationLevel;
  readOnly?: boolean;
  failureContext?: string;
}

export interface TransactionControl {
  /** End the transaction without committing while still returning a normal result. */
  rollback(): Promise<void>;
}

type TransactionWork<T> = (
  client: PoolClient,
  transaction: TransactionControl
) => Promise<T>;

type TransactionOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      errors: unknown[];
      discardError?: Error;
      failureContext: string;
    };

const ISOLATION_LEVELS: Record<TransactionIsolationLevel, string> = {
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

function beginStatement(options: TransactionOptions): string {
  const clauses: string[] = [];
  if (options.isolationLevel) {
    clauses.push(`ISOLATION LEVEL ${ISOLATION_LEVELS[options.isolationLevel]}`);
  }
  if (options.readOnly !== undefined) {
    clauses.push(options.readOnly ? 'READ ONLY' : 'READ WRITE');
  }
  return clauses.length > 0 ? `BEGIN ${clauses.join(' ')}` : 'BEGIN';
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('PostgreSQL transaction cleanup failed', { cause: error });
}

function materializeFailure(
  errors: unknown[],
  failureContext: string,
  releaseFailed = false
): unknown {
  if (errors.length === 1) return errors[0];

  const message = releaseFailed
    ? errors.length > 2
      ? `${failureContext}, rollback, and client release failed`
      : `${failureContext} and client release both failed`
    : `${failureContext} and rollback both failed`;
  return new AggregateError(errors, message);
}

async function executeTransaction<T>(
  client: PoolClient,
  work: TransactionWork<T>,
  options: TransactionOptions
): Promise<TransactionOutcome<T>> {
  const failureContext = options.failureContext ?? 'Transaction work';
  let transactionOpen = false;
  let discardError: Error | undefined;

  try {
    await client.query(beginStatement(options));
    transactionOpen = true;
  } catch (error) {
    return { ok: false, errors: [error], discardError: asError(error), failureContext };
  }

  const rollback = async (): Promise<void> => {
    if (!transactionOpen) {
      throw new Error('Transaction is no longer open');
    }
    // Mark it closed before awaiting so a failed explicit rollback is never retried.
    transactionOpen = false;
    try {
      await client.query('ROLLBACK');
    } catch (error) {
      discardError = asError(error);
      throw error;
    }
  };

  try {
    const value = await work(client, { rollback });
    if (transactionOpen) {
      await client.query('COMMIT');
      transactionOpen = false;
    }
    return { ok: true, value };
  } catch (error) {
    if (!transactionOpen) {
      return { ok: false, errors: [error], discardError, failureContext };
    }

    try {
      await rollback();
    } catch (rollbackError) {
      return {
        ok: false,
        errors: [error, rollbackError],
        discardError: asError(rollbackError),
        failureContext,
      };
    }
    return { ok: false, errors: [error], failureContext };
  }
}

/** Run a transaction on a caller-owned client without acquiring or releasing it. */
export async function withClientTransaction<T>(
  client: PoolClient,
  work: TransactionWork<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const outcome = await executeTransaction(client, work, options);
  if (outcome.ok) return outcome.value;
  throw materializeFailure(outcome.errors, outcome.failureContext);
}

/** Run a transaction on a newly checked-out client and release it on every path. */
export async function withTransaction<T>(
  work: TransactionWork<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const client = await getPool().connect();
  const outcome = await executeTransaction(client, work, options);

  let releaseOutcome: { ok: true } | { ok: false; error: unknown };
  try {
    if (outcome.ok || !outcome.discardError) client.release();
    else client.release(outcome.discardError);
    releaseOutcome = { ok: true };
  } catch (error) {
    releaseOutcome = { ok: false, error };
  }

  if (outcome.ok) {
    if (!releaseOutcome.ok) throw releaseOutcome.error;
    return outcome.value;
  }
  if (releaseOutcome.ok) {
    throw materializeFailure(outcome.errors, outcome.failureContext);
  }
  throw materializeFailure(
    [...outcome.errors, releaseOutcome.error],
    outcome.failureContext,
    true
  );
}
