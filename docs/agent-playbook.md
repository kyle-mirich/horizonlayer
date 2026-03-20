# Agent Playbook

This is the shortest reliable path for changing Horizon Layer without guessing.

## Happy path

```bash
npm ci
npm run verify
```

When you need the app running locally:

```bash
make db-up
make dev
```

When you need the full end-to-end tool surface verified:

```bash
make smoke-local
```

## Repo map

- `src/index.ts`, `src/runServer.ts`, `src/launcher.ts`: startup and transport entrypoints
- `src/server.ts`: FastMCP server assembly and tool registration
- `src/tools/*.ts`: tool schemas, action routing, response envelopes
- `src/db/queries/*.ts`: SQL-backed application logic
- `src/testing/liveSmoke.ts`: end-to-end MCP smoke test against a running server
- `migrations/*.sql`: schema history
- `docs/*.md`: API, architecture, flows, deployment, and configuration docs
- `examples/*.md`: copy-pasteable tool call examples

## Recommended edit flow

1. Change the smallest surface that matches the request.
2. Run `npm run verify`.
3. If startup, transport, or integration behavior changed, run `make smoke-local`.
4. If you changed tool shapes or examples, update `docs/api.md` and `examples/*.md` in the same patch.

## Common decisions

- Use `make dev` or `make dev-stdio` while developing the server itself.
- Use `node dist/launcher.js` only when validating the public launcher flow used by MCP clients.
- Keep SQL inside `src/db/queries/`. Tool files should validate input and call query functions.
- Prefer the examples and `docs/api.md` as the contract surface. The test suite now validates markdown tool snippets against the real schemas.
