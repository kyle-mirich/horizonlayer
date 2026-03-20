# Architecture

Horizon Layer is a single Node.js service with a PostgreSQL backing store.

## Runtime shape

At runtime the system has three major parts:

1. An optional launcher that bootstraps local PostgreSQL for stdio users
2. The FastMCP server and tool registration layer
3. The PostgreSQL-backed query layer

## Key modules

### Entrypoint

- `src/index.ts`
- `src/runServer.ts`
- `src/launcher.ts`

Responsibilities:

- `src/index.ts`: direct server entrypoint used by dev scripts and HTTP mode
- `src/runServer.ts`: shared startup path that runs migrations, starts FastMCP, and handles shutdown
- `src/launcher.ts`: public stdio launcher that can ensure a local Docker-backed PostgreSQL instance before delegating into `runServer()`

### Server assembly

- `src/server.ts`

Responsibilities:

- create the FastMCP instance
- register tools
- apply host allowlist checks for HTTP traffic

### Tool layer

- `src/tools/*.ts`

Each tool follows a similar pattern:

- validate input with Zod
- infer or require an action
- translate tool actions to query-layer calls
- normalize results into a standard success/error envelope

The tools are intentionally consolidated rather than one-file-per-action.

### Query layer

- `src/db/queries/*.ts`

Responsibilities:

- enforce workspace/resource access
- execute SQL
- shape records for tool responses
- maintain embeddings and coordination state

This layer is the real application core.

## Data model shape

The database is used for both content and workflow state.

Broadly:

- content graph: workspaces, pages, blocks, databases, rows, links
- legacy identity/tenancy tables: users, orgs, memberships, OAuth-era records
- coordination: tasks, dependencies, events, inbox
- resumability: runs and checkpoints

This is why the project works well for long-lived agent workflows: both the knowledge graph and the execution state live in the same consistency boundary.

## Deployment shape

The repo includes:

- launcher-backed local stdio workflow
- local container workflow with Docker Compose
- AWS baseline deployment in Terraform

The AWS path is:

- ECR for the image
- ECS Fargate for the app
- ALB for ingress
- EFS for runtime state and model cache persistence
- RDS PostgreSQL for storage

See `docs/deployment.md` for the operational details.
