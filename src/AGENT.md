# src

`src/` is the runtime code for the Horizon Layer server. The folder is organized around a thin startup layer, a tool layer, and a database/query layer.

## What Lives Here

- `index.ts`: smallest possible entrypoint. It just calls `runServer()`.
- `launcher.ts`: end-user entrypoint for stdio installs. If `DATABASE_URL` is missing, it tries to reach local Postgres, starts a Docker container if needed, creates the target database, then hands off to `runServer()`.
- `runServer.ts`: startup coordinator. It runs migrations, creates the server, starts the selected transport, and wires SIGINT/SIGTERM cleanup.
- `server.ts`: creates the FastMCP instance and registers the tool modules.
- `config.ts`: reads `config.yaml` or `config.example.yaml`, overlays environment variables, validates everything with Zod, and exports the final config.
- `mcp.ts`: shared FastMCP type aliases.
- `db/`: database access, access control, migrations, and the actual SQL-backed business logic.
- `tools/`: MCP tool definitions and request/response shaping.
- `embeddings/`: local embedding generation.
- `testing/`: live smoke test entrypoint.

## How Requests Flow

1. Process starts through `index.ts` or `launcher.ts`.
2. `runServer.ts` migrates the database before serving traffic.
3. `server.ts` registers 8 tools with FastMCP.
4. A tool module in `src/tools/` validates the request and chooses an action.
5. The tool calls into `src/db/queries/`.
6. Query code reads or mutates Postgres and returns typed records.
7. The tool wraps the result in the standard MCP response envelope.

## Important Design Choices

- Startup is intentionally split: `launcher.ts` is for friendly local bootstrapping, while `index.ts` is the simple programmatic entrypoint.
- Tools are consolidated by domain instead of one file per action. Each tool file owns one external MCP surface.
- The query layer is the real application core. If you need behavior changes, that is usually where the work belongs.
- Search and semantic ranking are local-first: embeddings are generated in-process via Xenova transformers rather than a hosted embedding service.

## Tests In This Tree

- `server.test.ts`: server registration and assembly checks.
- Most behavior-heavy tests live beside their owning layer in `src/tools/` or `src/db/queries/`.
