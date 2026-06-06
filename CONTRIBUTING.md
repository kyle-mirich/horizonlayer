# Contributing to Horizon Layer

## Running locally

Prerequisites: Node.js 22, Docker.

```bash
make install   # install dependencies
make db-up     # start Postgres in Docker
make dev       # run the local stdio server against the Docker database
```

For raw stdio transport against an already-running database:

```bash
make dev-stdio
```

For the public launcher flow used by MCP clients:

```bash
make build
node dist/launcher.js
```

The launcher defaults to Docker-managed PostgreSQL only when `DATABASE_URL` is unset. Contributors should usually prefer `make db-up` plus `make dev` or `make dev-stdio` so failures are easier to isolate.

Migrations run automatically on startup.

## Running tests

Unit tests (no database required):

```bash
make test
```

Repo verification:

```bash
npm run verify
```

Live smoke test (requires a running server):

```bash
make db-up
make dev       # in another terminal
make smoke-live
```

`smoke-live` exercises the compact core MCP loop against the running stdio server. Use `MCP_COMMAND` and `MCP_ARGS` when you need to point the smoke test at a different launcher command.

One-command local smoke flow:

```bash
make smoke-local
```

`smoke-local` starts Docker Postgres, launches the stdio server through the local launcher, runs `smoke-live`, then stops the database container.

## Code conventions

- **TypeScript strict mode** — no implicit `any`, no unsafe casts.
- **Zod at input boundaries** — all tool parameters are validated with Zod schemas before reaching the query layer. Do not add runtime checks that duplicate Zod validation.
- **Query layer for SQL** — all SQL lives in `src/db/queries/`. Tool files (`src/tools/`) call query functions; they do not write SQL directly.
- **Standard response envelope** — tools return `successEnvelope(...)` or `errorEnvelope(...)` from `src/tools/common.ts`. Do not return raw strings or ad-hoc shapes.
- **No `any` in query types** — use `pg`'s typed query pattern with explicit generic parameters.

## Adding a core tool action

1. Add the new action name to the relevant enum in `src/tools/core.ts`.
2. Add parameters for the new action to the tool schema with `.describe(...)` on each field.
3. Add a `case` branch in the `switch (action)` block.
4. Write the SQL in `src/db/queries/` — one function per logical operation.
5. Wire the query function into the `case` branch. Return `successEnvelope(...)`.
6. Add a unit test in `src/tools/core.test.ts` or extend the smoke test in `src/testing/liveSmoke.ts`.

## Adding a new tool

Treat a new MCP tool as a public API expansion. Prefer adding a focused action to `session`, `memory`, or `coordination`; only add another tool when the concept cannot fit those boundaries cleanly.

## Pull request guidelines

- Keep PRs focused on a single change.
- Run `npm run verify` before submitting.
- Run `make smoke-local` when you change startup, transport, migrations, or cross-tool flows.
- If you change startup, transport, or deployment behavior, update the relevant docs in `README.md` and `docs/`.
- Describe what the change does and why in the PR description.
- New tool actions should include at least one test.
- New SQL migrations go in `migrations/` with the next sequence number (`NNN_description.sql`).

## Releasing

The npm package is published from GitHub Actions through `.github/workflows/publish.yml`.

For a new release:

```bash
git tag v1.0.1
git push origin v1.0.1
```

That tag triggers the publish workflow, which runs `npm ci`, `npm run verify`, and `npm publish --provenance`.

If trusted publishing is configured in npm, no long-lived npm token is required in the repository.
