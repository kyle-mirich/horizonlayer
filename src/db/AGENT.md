# src/db

`src/db/` is the storage support layer. It does not define the MCP API directly; instead it owns connections, migrations, access context primitives, and helper code shared by the query modules.

## Files

- `client.ts`: lazy singleton `pg.Pool` creation plus shutdown handling.
- `migrate.ts`: migration runner that scans `migrations/`, records applied files in `_migrations`, and executes each SQL file in a transaction.
- `access.ts`: access-context types plus SQL predicate builders for workspace-scoped read/write enforcement.
- `queries/`: all SQL-backed domain operations.
- `access.test.ts`: focused tests around the access predicate helpers.

## Responsibilities

- Build and cache the Postgres connection pool from validated config.
- Apply SSL and pooling options from `src/config.ts`.
- Provide a single place for migration execution on startup.
- Define the access model that query files use to gate reads and writes.
- Support the "system access" mode used by the current local-first runtime.

## Access Model Notes

- `SYSTEM_ACCESS` represents the only runtime access mode in the local-only build.
- Workspace predicates are the core enforcement building block. Query modules reuse them to keep access logic in SQL rather than in ad hoc TypeScript filters.

## Where To Go Next

- Read `queries/AGENT.md` for the real business behavior.
- Read `migrations/AGENT.md` if you need to line the query code up with the actual schema.
