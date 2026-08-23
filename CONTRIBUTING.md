# Contributing to HorizonLayer

HorizonLayer is a local PostgreSQL MCP server. Changes must preserve workspace isolation, the canonical PostgreSQL model, optimistic revisions, archive/restore lifecycle, and local runtime behavior. The normative vocabulary lives in [docs/glossary.md](docs/glossary.md); design rationale for the main seams lives in [docs/engineering-notes.md](docs/engineering-notes.md).

## Local setup

Use Node.js 22 or later. Docker is required for launcher-backed local smoke tests.

```bash
npm ci
npm run verify
npm run test:coverage
npm run build
npm run test:smoke:local
npm run test:smoke:recovery
npm pack --dry-run
```

`npm run verify` runs linting, type checks, and unit tests. `npm test` and `npm run test:coverage` explicitly exclude `*.integration.test.ts`, so these ordinary local checks stay fast and never require Docker, PostgreSQL, Qdrant, or another external service. Vitest also turns React “not wrapped in act(...)” warnings into test failures without hiding the original warning. Coverage enforces the repository's configured branch, function, line, and statement thresholds. Run the focused test suite that covers a change, then run the full verification and coverage gates before opening a pull request. Changes to launcher, installer, runtime configuration, or package contents also need a clean-environment and packed-artifact check.

### PostgreSQL integration tests

The concurrency, search-generation, and canonical RAG suites require a disposable PostgreSQL database. Point the dedicated integration variable at that database and run the explicit integration command:

```bash
HORIZONLAYER_INTEGRATION_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/horizonlayer_test' \
  npm run test:integration:postgres
```

The database role must be able to create and drop schemas and install the `pgcrypto` and `pg_trgm` extensions. The suites create unique schemas, apply the canonical `schema.sql`, run serially, and remove their schemas afterward. The command fails when `HORIZONLAYER_INTEGRATION_DATABASE_URL` is unset so an integration run cannot silently report only skipped tests. Do not point it at a database whose availability or contents matter.

GitHub Actions runs on Node.js 22 in two jobs. The verification job has no service containers and runs linting, typechecking, unit tests, coverage, and the production build. The integration job starts a fresh PostgreSQL 17 service, sets `HORIZONLAYER_INTEGRATION_DATABASE_URL`, and executes all three PostgreSQL suites. CI does not require Qdrant or the Docker-managed local runtime.

### Managed recovery smoke test

`npm run test:smoke:recovery` requires Docker and packs the repository before exercising the public launcher. It always uses a unique temporary `HORIZONLAYER_HOME`, Compose project, loopback ports, volumes, artifacts, and dashboard port; its exit trap resets only that runtime. The test proves private/collision-safe artifacts, lifecycle and signal handling, concurrent-write snapshot consistency, transaction-preserving restore failure, isolated host ports, A→B→A recovery, safety-Backup return to B, SQL/MCP/dashboard reads, Qdrant rebuild, reset survival, and corrupt-input refusal. Never weaken its isolation or point it at a normal user runtime.

Before a recovery-related pull request, run the complete local gate set:

```bash
npm ci
npm run verify
npm run test:coverage
npm run build
HORIZONLAYER_INTEGRATION_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/horizonlayer_test' npm run test:integration:postgres
npm run test:smoke:local
npm run test:smoke:recovery
npm pack --dry-run
git diff --check
```

## Commit conventions

Use concise, imperative commit messages with a type prefix:

- `feat:` new user-visible capability
- `fix:` bug fix
- `test:` test-only change
- `refactor:` behavior-preserving restructuring
- `docs:` documentation only
- `chore:` tooling, CI, dependencies
- `release:` version preparation

Keep each commit focused on one change; the subject line should complete "this commit will …".

## Pull requests

- Keep changes narrowly scoped and include tests for changed behavior.
- Update user-facing documentation when commands, configuration, local data locations, or recovery behavior changes.
- Do not add hosted infrastructure, remote deployment claims, migrations, or compatibility layers without an approved product decision.
- Preserve user data: public lifecycle operations are archive and restore, not broad destructive deletion.
- Describe verification performed and any Docker, platform, or external-service assumptions in the pull request.

For a bug or feature discussion, use the [issue tracker](https://github.com/kyle-mirich/horizonlayer/issues). For a security-sensitive issue, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
