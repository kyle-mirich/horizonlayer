# Architecture

Horizon Layer is a single TypeScript service backed by PostgreSQL.

## Runtime Shape

There are three main layers:

1. An optional launcher that bootstraps local PostgreSQL for stdio users
2. The FastMCP server and tool registration layer
3. The PostgreSQL-backed query layer that owns persistence, access control, and search

## Entrypoints

- `src/launcher.ts`
- `src/index.ts`
- `src/runServer.ts`

Responsibilities:

- `src/launcher.ts`: optional bootstrap path for stdio clients; it can start a local Docker-backed Postgres instance when `DATABASE_URL` is not set
- `src/index.ts`: direct process entrypoint for HTTP or stdio mode when you already control the environment
- `src/runServer.ts`: shared startup path that runs migrations, starts the MCP server, and handles shutdown

## Server Assembly

- `src/server.ts`
- `src/mcp.ts`
- `src/config.ts`

Responsibilities:

- load YAML and environment configuration
- create the FastMCP instance
- register tools
- apply host allowlist checks for HTTP traffic
- expose HTTP transport and `/healthz` when running in HTTP mode

## Tool Layer

- `src/tools/*.ts`

Each tool:

- validates inputs with Zod
- resolves the requested action
- calls into the query layer
- returns the standard response envelope

The tool layer is intentionally thin. SQL and persistence rules stay below it.

## Query Layer

- `src/db/queries/*.ts`
- `src/db/client.ts`
- `src/db/migrate.ts`
- `src/db/access.ts`
- `src/db/localUser.ts`

Responsibilities:

- run migrations
- manage the shared Postgres pool
- enforce access boundaries
- execute SQL for content, search, tasks, links, and runs
- shape records returned to the tool layer

This is the main application core.

## Storage Model

The database stores both knowledge and workflow state:

- content graph: workspaces, pages, blocks, databases, rows, links
- legacy identity and tenancy: users, organizations, memberships, sessions, identities, and OAuth-era records
- coordination: tasks, dependencies, acknowledgements, events, and inbox items
- execution: runs and checkpoints
- search: pgvector embeddings and full-text indexes

That shared persistence model is what makes resumable agent workflows possible without separate coordination infrastructure.

## Deployment Shapes

The repo supports:

- local stdio via `dist/launcher.js`
- local HTTP via Node or Docker Compose
- AWS deployment via Terraform in `infra/terraform`

The AWS path is:

- ECR for the image
- ECS Fargate for the app
- ALB for ingress
- EFS for runtime state and model cache persistence
- RDS PostgreSQL for storage

See `docs/deployment.md` for deployment details.
