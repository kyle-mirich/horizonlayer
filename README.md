# Horizon Layer

Horizon Layer is a self-hosted, local-first MCP server for agent memory and coordination backed by PostgreSQL and pgvector.

It gives agents one durable place for:

- workspaces and session-scoped context
- pages and block content
- typed databases and rows
- cross-entity links
- task coordination and inboxes
- run/checkpoint state
- hybrid semantic and keyword search

The current runtime is local and system-only. The repo does not include application-layer auth or SSO wiring.

## Quickstart

For most users on macOS, Linux, or WSL, this is the shortest working path from clone to a usable MCP server:

```bash
git clone https://github.com/kyle-mirich/horizonlayer.git
cd horizonlayer
./setup.sh
codex mcp add horizondb -- node "$(pwd)/dist/launcher.js"
```

`./setup.sh`:

- checks for Node.js 22+
- checks Docker only when `DATABASE_URL` is not already set
- installs dependencies with `npm ci`
- builds the project
- prints the exact MCP add commands for Codex and Claude

If your project lives in a path with spaces, keep the launcher path quoted:

```bash
codex mcp add horizondb -- node "$(pwd)/dist/launcher.js"
claude mcp add -s user horizondb -- node "$(pwd)/dist/launcher.js"
```

Windows note: `setup.sh` is a Bash script. Use WSL for the one-command flow, or use the manual commands below from PowerShell.

## Contributor Shortcuts

If you are changing the repo itself rather than just consuming the MCP server:

```bash
npm ci
npm run verify
make smoke-local
```

- `npm run verify` runs lint, typecheck, and the unit test suite.
- `make smoke-local` starts local PostgreSQL, boots the HTTP server, waits for `/healthz`, runs the end-to-end smoke test, then shuts the database back down.
- [docs/agent-playbook.md](docs/agent-playbook.md) maps the repo structure and the recommended edit/verification flow.
- [docs/configuration.md](docs/configuration.md) explains config precedence and the local dev env surface.

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
| `page` | create, get, update, delete, list, append_blocks, append_text, block_update, block_delete |
| `database` | create, get, update, delete, list, add_property |
| `row` | create, get, update, delete, query, count, bulk_create, cleanup_expired |
| `search` | hybrid, similarity, similarity_recency, similarity_importance, full_text, grep, regex |
| `task` | create, get, list, claim, heartbeat, complete, fail, handoff, ack, append_event, inbox_list, inbox_ack |
| `run` | start, get, checkpoint, list, complete, fail, cancel |
| `link` | create, list, delete |

## Install modes

There are two supported ways to run Horizon Layer:

1. `stdio` for local MCP clients such as Codex and Claude
2. HTTP for a long-running local or hosted server

For most users, `stdio` is the easiest place to start. The launcher can automatically provision a local Docker-backed PostgreSQL container when `DATABASE_URL` is not set.

## Prerequisites

- Node.js 22 or newer
- Docker, unless you already have a PostgreSQL instance and will set `DATABASE_URL`

## Install Modes

Horizon Layer supports three practical local install modes.

### 1. Stdio launcher with managed Postgres

This is the easiest MCP-client path.

```bash
npm ci
npm run build
node dist/launcher.js
```

Behavior:

- if `DATABASE_URL` is set, the launcher uses it directly
- otherwise it tries `127.0.0.1:5432`
- if Postgres is still unavailable, it starts a local `pgvector/pgvector:pg17` Docker container
- it creates the `horizon_layer` database if needed
- it runs migrations before starting the server

### 2. Local HTTP server with local Node

Use this when you want an MCP endpoint at `http://127.0.0.1:3000/mcp`.

```bash
make db-up
make dev
```

### 3. Full Docker Compose stack

Use this when you want both the app and Postgres in containers.

```bash
docker compose up --build
```

The MCP endpoint is then available at:

```text
http://127.0.0.1:3000/mcp
```

If you need different host ports, pass them in your shell when starting Compose:

```bash
APP_PORT=4000 DB_PORT=55432 docker compose up --build
```

## Manual Setup

If you do not want to use `setup.sh`, the manual flow is:

```bash
npm ci
npm run build
```

Then choose one runtime:

```bash
node dist/launcher.js
```

or:

```bash
make db-up
make dev
```

or:

```bash
docker compose up --build
```

## MCP Client Setup

### Codex

```bash
codex mcp add horizondb -- node "$(pwd)/dist/launcher.js"
```

For HTTP mode:

```bash
codex mcp add horizondb-http --url http://127.0.0.1:3000/mcp
```

Official Codex CLI docs: <https://developers.openai.com/codex/cli>

### Claude Code

```bash
claude mcp add -s user horizondb -- node "$(pwd)/dist/launcher.js"
```

For HTTP mode:

```bash
claude mcp add -s user --transport http horizondb-http http://127.0.0.1:3000/mcp
```

Official Claude Code docs: <https://docs.anthropic.com/en/docs/claude-code/getting-started>

### Claude Desktop

This repo ships a raw MCP server, not a packaged Claude Desktop extension bundle. The practical Anthropic path today is Claude Code.

If you want a long-running local endpoint for a desktop client, run HTTP mode and point the client at:

```text
http://127.0.0.1:3000/mcp
```

Official Anthropic local MCP docs: <https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop>

## Common Commands

```bash
make install      # npm ci
make build        # compile TypeScript
make test         # run unit tests
make verify       # lint + typecheck + tests
make db-up        # start Postgres only
make db-down      # stop Postgres only
make dev          # local HTTP server
make dev-stdio    # local stdio server against an existing DB
make docker-up    # app + Postgres in containers
make docker-down  # stop the Docker stack
make smoke-live   # live MCP smoke test against a running HTTP server
```

## Configuration

Environment variables override `config.example.yaml`.

The most important ones are:

- `DATABASE_URL`: connect to an existing PostgreSQL instance and skip Docker bootstrap
- `SERVER_TRANSPORT`: `stdio` or `http`
- `APP_NAME`: MCP server name
- `APP_BASE_URL`: base URL for HTTP mode
- `HOST` and `PORT`: HTTP bind address
- `MCP_RESOURCE_PATH`: MCP endpoint path in HTTP mode

Launcher-only variables:

- `HORIZONDB_DOCKER_CONTAINER_NAME`
- `HORIZONDB_DOCKER_VOLUME_NAME`
- `HORIZONDB_DOCKER_IMAGE`
- `HORIZONDB_DB_HOST`
- `HORIZONDB_DB_PORT`
- `HORIZONDB_DB_NAME`
- `HORIZONDB_DB_USER`
- `HORIZONDB_DB_PASSWORD`

## Tool Surface

Horizon Layer exposes 8 MCP tools:

| Tool | Actions |
| --- | --- |
| `workspace` | `create`, `create_session`, `list`, `get`, `update`, `delete`, `start_session`, `list_sessions`, `get_session`, `resume_session_context`, `close_session` |
| `page` | `create`, `get`, `update`, `append_blocks`, `append_text`, `delete`, `list`, `block_update`, `block_delete` |
| `database` | `create`, `get`, `list`, `add_property`, `update`, `delete` |
| `row` | `create`, `get`, `update`, `delete`, `query`, `count`, `bulk_create`, `cleanup_expired` |
| `search` | `search` |
| `task` | `create`, `get`, `list`, `claim`, `heartbeat`, `complete`, `fail`, `handoff`, `ack`, `append_event`, `inbox_list`, `inbox_ack` |
| `run` | `start`, `get`, `list`, `checkpoint`, `complete`, `fail`, `cancel` |
| `link` | `create`, `list`, `delete` |

## Documentation

- [docs/api.md](docs/api.md): tool reference
- [docs/architecture.md](docs/architecture.md): runtime layout
- [docs/database.md](docs/database.md): schema overview
- [docs/deployment.md](docs/deployment.md): Docker and AWS deployment
- [docs/flows.md](docs/flows.md): main application flows
- [examples/](examples/): example workflows
- [CONTRIBUTING.md](CONTRIBUTING.md): contributor workflow

## License

MIT. See [LICENSE](LICENSE).
