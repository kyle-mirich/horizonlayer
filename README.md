# Horizon Layer

A self-hosted, local-first MCP server for agent memory backed by PostgreSQL and pgvector.

Horizon Layer gives agents a persistent knowledge and coordination layer: workspaces, pages, structured databases, tasks, runs, links, and hybrid vector search in one PostgreSQL-backed MCP server.

```
┌─────────────────────────────────────────────┐
│              MCP Clients                    │
│         (Claude, Codex, agents)             │
└──────────────────┬──────────────────────────┘
                   │  MCP over stdio or HTTP
┌──────────────────▼──────────────────────────┐
│            Tool Layer (8 tools)             │
│  workspace · page · database · row          │
│  search · task · run · link                 │
└──────────────────┬──────────────────────────┘
                   │  typed query calls
┌──────────────────▼──────────────────────────┐
│         Query Layer (src/db/queries)        │
│   access control · SQL · embeddings         │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│     PostgreSQL + pgvector (local or RDS)    │
└─────────────────────────────────────────────┘
```

## What it exposes

| Tool | Actions |
|------|---------|
| `workspace` | create, list, get, update, delete, start_session, list_sessions, get_session, resume_session_context, close_session |
| `page` | create, get, update, delete, list, append_text, list_blocks |
| `database` | create, get, update, delete, list, add_property, remove_property |
| `row` | create, get, update, delete, query, count, bulk_create, cleanup_expired |
| `search` | hybrid, similarity, similarity_recency, similarity_importance, full_text, grep, regex |
| `task` | create, get, update, delete, list, claim, heartbeat, complete, fail, handoff, acknowledge, list_events, add_event, list_inbox |
| `run` | start, get, update, list, complete, fail, cancel, add_checkpoint, list_checkpoints |
| `link` | create, get, delete, list |

## Install modes

There are two supported ways to run Horizon Layer:

1. `stdio` for local MCP clients such as Codex and Claude
2. HTTP for a long-running local or hosted server

For most users, `stdio` is the easiest place to start. The launcher can automatically provision a local Docker-backed PostgreSQL container when `DATABASE_URL` is not set.

## Prerequisites

- Node.js 22
- Docker

## Quickstart

```bash
make install
```

### Option A: One-command local stdio

Build the project once, then use the launcher:

```bash
npm run build
node dist/launcher.js
```

What the launcher does:

- uses `DATABASE_URL` directly when it is set
- otherwise checks for a local PostgreSQL instance at the managed defaults
- if needed, starts a Docker container named `horizondb-postgres`
- creates the `horizon_layer` database if it does not exist
- runs migrations and starts the MCP server over `stdio`

The managed local defaults are:

- host: `127.0.0.1`
- port: `5432`
- database: `horizon_layer`
- user: `postgres`
- password: `postgres`
- image: `pgvector/pgvector:pg17`

If Docker is unavailable, the launcher prints a user-friendly error telling the user to start Docker Desktop or set `DATABASE_URL`.

### Option B: Full Docker stack

Starts Postgres and the app in containers. MCP endpoint available at `http://127.0.0.1:3000/mcp`.

```bash
make docker-up
```

Stop with:

```bash
make docker-down
```

### Option C: App local, Postgres in Docker

```bash
make db-up
make dev
```

Or run as stdio:

```bash
make dev-stdio
```

Migrations run automatically on boot.

## MCP Client Setup

### Codex via stdio launcher

```bash
make build
codex mcp add horizondb -- node "$(pwd)/dist/launcher.js"
```

The launcher works with an existing database too:

```bash
codex mcp remove horizondb
codex mcp add horizondb --env DATABASE_URL=postgres://postgres:postgres@db.example.com:5432/horizon_layer -- node "$(pwd)/dist/launcher.js"
```

### Claude via stdio launcher

```bash
make build
claude mcp add -s user horizondb -- node "$(pwd)/dist/launcher.js"
```

### HTTP MCP setup

After `make docker-up` or `make dev`:

```bash
codex mcp add horizondb-http --url http://127.0.0.1:3000/mcp
claude mcp add -s user --transport http horizondb-http http://127.0.0.1:3000/mcp
```

## Common Commands

```bash
make db-up          # start Postgres only
make db-down        # stop Postgres
make db-reset       # wipe and recreate volumes
make dev            # run app locally (HTTP)
make dev-stdio      # run app locally (stdio)
make build          # compile TypeScript
make test           # run unit tests
make smoke-live     # exercise all 8 tools against a running server
make docker-up      # full Docker stack
make docker-down    # stop Docker stack
```

## Configuration

`config.example.yaml` contains the server and database defaults. Environment variables override YAML values.

Common runtime variables:

- `DATABASE_URL`: use an existing PostgreSQL instance and skip Docker bootstrap
- `SERVER_TRANSPORT`: `stdio` or `http`
- `APP_NAME`: FastMCP server name
- `APP_BASE_URL`: public base URL for HTTP mode
- `HOST` and `PORT`: HTTP bind address

Launcher-only variables:

- `HORIZONDB_DOCKER_CONTAINER_NAME`
- `HORIZONDB_DOCKER_VOLUME_NAME`
- `HORIZONDB_DOCKER_IMAGE`
- `HORIZONDB_DB_HOST`
- `HORIZONDB_DB_PORT`
- `HORIZONDB_DB_NAME`
- `HORIZONDB_DB_USER`
- `HORIZONDB_DB_PASSWORD`

See [`docs/api.md`](docs/api.md) for the full parameter reference.

## Troubleshooting

### Docker is installed but not running

If the launcher cannot talk to Docker, it exits before starting the MCP server and prints a message telling the user to start Docker Desktop or set `DATABASE_URL`.

### Port `5432` is already in use

Set `DATABASE_URL` to the PostgreSQL instance already using that port, or run the launcher with a different managed port:

```bash
HORIZONDB_DB_PORT=55432 node dist/launcher.js
```

### I want a pure local contributor workflow

Use the existing make targets:

```bash
make db-up
make dev
```

Or for raw stdio without launcher bootstrap:

```bash
make dev-stdio
```

## Documentation

- [`docs/api.md`](docs/api.md) — complete tool parameter reference
- [`docs/architecture.md`](docs/architecture.md) — system design
- [`docs/database.md`](docs/database.md) — schema and data model
- [`docs/deployment.md`](docs/deployment.md) — Docker and AWS deployment
- [`docs/flows.md`](docs/flows.md) — runtime flows
- [`examples/`](examples/) — annotated workflow examples

## License

MIT — see [LICENSE](LICENSE).
