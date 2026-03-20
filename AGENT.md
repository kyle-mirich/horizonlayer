# Horizon Layer Source Map

This repository is a single TypeScript service that exposes a PostgreSQL-backed MCP server for agent memory, structured knowledge, task coordination, and resumable runs.

## Start Here

- `src/index.ts`: direct process entrypoint for normal app startup.
- `src/launcher.ts`: CLI-facing launcher that can provision a local Docker Postgres instance before starting the app.
- `src/runServer.ts`: shared startup path that runs migrations, starts FastMCP, and handles shutdown.
- `src/server.ts`: assembles the FastMCP server and registers the 8 exposed tools.
- `src/config.ts`: merges YAML and environment config into the runtime config object.
- `src/db/`: database access layer, migrations runner, access helpers, and SQL query modules.
- `src/tools/`: MCP tool definitions. This is the boundary between the MCP schema and the SQL/query layer.
- `src/embeddings/`: local embedding generation used by search and semantic indexing.
- `migrations/`: ordered SQL schema history. Read these to understand the real data model.
- `docs/`: human-facing architecture, API, deployment, flow, and database docs.
- `examples/`: end-to-end MCP usage examples for memory, structured data, and coordination.
- `infra/terraform/`: AWS deployment baseline for ECS, ALB, EFS, and RDS.

## Runtime Shape

1. `src/launcher.ts` or `src/index.ts` starts the process.
2. `src/runServer.ts` runs SQL migrations from `migrations/`.
3. `src/server.ts` creates the FastMCP server and registers `workspace`, `page`, `database`, `row`, `search`, `link`, `task`, and `run`.
4. Tool handlers in `src/tools/` validate inputs and call query functions in `src/db/queries/`.
5. Query modules read and write PostgreSQL state, including vector embeddings and coordination state.

## Directory Guide

- `src/AGENT.md`: entrypoints, runtime assembly, and subsystem overview.
- `src/db/AGENT.md`: connection management, access model, and database support code.
- `src/db/queries/AGENT.md`: detailed map of the SQL-backed application core.
- `src/tools/AGENT.md`: tool schemas, action routing, and response conventions.
- `src/embeddings/AGENT.md`: local model loading and vector formatting.
- `src/testing/AGENT.md`: live smoke testing entrypoint.
- `docs/AGENT.md`: what each prose document covers.
- `examples/AGENT.md`: what each example demonstrates.
- `migrations/AGENT.md`: what each numbered migration adds.
- `infra/AGENT.md`: deployment material at a glance.
- `infra/terraform/AGENT.md`: AWS infrastructure layout and variable surface.

## Fastest Paths For Common Questions

- "How does the server start?" -> `src/launcher.ts`, `src/index.ts`, `src/runServer.ts`
- "What tools exist?" -> `src/server.ts`, then `src/tools/`
- "Where is the business logic?" -> `src/db/queries/`
- "What is the schema?" -> `migrations/`, then `docs/database.md`
- "How is search implemented?" -> `src/tools/search.ts`, `src/db/queries/search.ts`, `src/embeddings/index.ts`
- "How do tasks and runs work?" -> `src/tools/tasks.ts`, `src/tools/runs.ts`, `src/db/queries/tasks.ts`, `src/db/queries/runs.ts`
- "How is this deployed?" -> `docs/deployment.md`, `infra/terraform/`
