# Horizon Layer

A self-hosted, local-first MCP server for agent memory backed by PostgreSQL and pgvector.

Horizon Layer gives agents a persistent knowledge and coordination layer: workspaces, pages, structured databases, tasks, runs, links, and hybrid vector search in one PostgreSQL-backed MCP server.

## Quickstart

If you want the shortest path from `git clone` to a working local setup:

```bash
git clone https://github.com/kyle-mirich/horizonlayer.git
cd horizonlayer
./setup.sh
```

What `./setup.sh` does:

- detects your operating system
- checks whether `node`, `npm`, and `docker` are installed
- checks whether Docker is actually running
- installs project dependencies
- builds the project
- prints the exact MCP setup command for Codex and Claude

If it cannot continue, it prints:

- the operating system it detected
- which required tools are missing
- what version of Node.js you have, if it is too old
- where to install the missing tools

After `./setup.sh` succeeds, add the MCP server to your client:

```bash
codex mcp add horizondb -- node "$(pwd)/dist/launcher.js"
```

Or:

```bash
claude mcp add -s user horizondb -- node "$(pwd)/dist/launcher.js"
```

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

- [Node.js](https://nodejs.org/en/download/) 22 or newer
- [Docker Desktop](https://docs.docker.com/get-started/get-docker/) or another local Docker runtime

## Install the client you want to use

You only need one MCP client. Pick the one you already use:

### By platform

#### macOS

- Node.js: [Download from nodejs.org](https://nodejs.org/en/download/)
- Docker: [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/)
- Codex CLI:

```bash
npm install -g @openai/codex
codex
```

- Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
claude
```

Native installer alternative from Anthropic:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

- Claude Desktop: [Install Claude Desktop for macOS](https://support.anthropic.com/en/articles/10065433-installing-claude-for-desktop)

#### Windows

- Node.js: [Download from nodejs.org](https://nodejs.org/en/download/)
- Docker: [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
- Codex CLI:

```powershell
npm install -g @openai/codex
codex
```

OpenAI's Codex CLI docs currently describe Windows support as experimental and recommend WSL for the best experience.

- Claude Code:

```powershell
npm install -g @anthropic-ai/claude-code
claude
```

Native installer alternative from Anthropic:

```powershell
irm https://claude.ai/install.ps1 | iex
```

- Claude Desktop: [Install Claude Desktop for Windows](https://support.anthropic.com/en/articles/10065433-installing-claude-for-desktop)

#### Linux

- Node.js: [Download from nodejs.org](https://nodejs.org/en/download/)
- Docker:
  - [Docker Desktop for Linux](https://docs.docker.com/desktop/setup/install/linux/)
  - [Docker Engine install guides](https://docs.docker.com/engine/install/)
- Codex CLI:

```bash
npm install -g @openai/codex
codex
```

- Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
claude
```

Native installer alternative from Anthropic:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

- Claude Desktop: Anthropic's current install docs list macOS and Windows only, so on Linux the practical Anthropic path today is Claude Code.

### Codex CLI

Official install docs: [OpenAI Codex CLI](https://developers.openai.com/codex/cli)

Install:

```bash
npm install -g @openai/codex
codex
```

The first time you run `codex`, OpenAI prompts you to sign in.

### Claude Code

Official install docs: [Set up Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started)

Install:

```bash
npm install -g @anthropic-ai/claude-code
claude
```

Anthropic currently documents Node.js 18+ for Claude Code. This repo itself targets Node.js 22.

### Claude Desktop

Official install docs: [Installing Claude Desktop](https://support.anthropic.com/en/articles/10065433-installing-claude-for-desktop)

Official local MCP docs: [Getting Started with Local MCP Servers on Claude Desktop](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

Install Claude Desktop first, sign in, then read the Claude Desktop setup section below. Anthropic's current local MCP flow is centered on desktop extensions.

## Full User Flow

### Codex + stdio from a fresh clone

If you want the literal first-run path, use this sequence:

```bash
git clone https://github.com/kyle-mirich/horizonlayer.git
cd horizonlayer
npm ci
npm run build
codex mcp add horizondb -- node "$(pwd)/dist/launcher.js"
```

Then start Codex and use the `horizondb` MCP server. On first launch, the launcher will:

1. use `DATABASE_URL` if you provided one
2. otherwise check for local PostgreSQL
3. otherwise start a Docker `pgvector/pgvector:pg17` container
4. create the `horizon_layer` database if needed
5. run migrations
6. start the MCP server over `stdio`

If Docker Desktop is closed, startup fails with a message telling you to start Docker Desktop or set `DATABASE_URL`.

### Claude + stdio from a fresh clone

```bash
git clone https://github.com/kyle-mirich/horizonlayer.git
cd horizonlayer
npm ci
npm run build
claude mcp add -s user horizondb -- node "$(pwd)/dist/launcher.js"
```

### Claude Desktop from a fresh clone

1. Install Claude Desktop using Anthropic's official guide:
   [Installing Claude Desktop](https://support.anthropic.com/en/articles/10065433-installing-claude-for-desktop)
2. Read Anthropic's local MCP guide:
   [Getting Started with Local MCP Servers on Claude Desktop](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
3. Clone and build this repo:

```bash
git clone https://github.com/kyle-mirich/horizonlayer.git
cd horizonlayer
npm ci
npm run build
```

4. Today, the smooth Anthropic path for this repo is still Claude Code, because this repository currently ships a raw `stdio` launcher, not a packaged Claude Desktop extension (`.mcpb`).
5. If you want native Claude Desktop installation, package this server as a desktop extension and install it through Claude Desktop's extension flow:
   Settings > Extensions > Advanced settings > Install Extension…

Notes:

- The launcher will still auto-start Docker-backed PostgreSQL when `DATABASE_URL` is not set.
- This repo does not yet include a published `.mcpb` desktop extension bundle.
- Exact Claude Desktop menus can change by version, so use Anthropic's local MCP guide above as the source of truth.

### Full local HTTP flow from a fresh clone

Use this when you want a long-running endpoint at `http://127.0.0.1:3000/mcp` instead of `stdio`:

```bash
git clone https://github.com/kyle-mirich/horizonlayer.git
cd horizonlayer
npm ci
docker compose up --build
```

Then point your MCP client at:

```text
http://127.0.0.1:3000/mcp
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

### Claude Desktop via local MCP config

Anthropic's current official local MCP flow for Claude Desktop is desktop-extension-based. This repo does not yet ship a `.mcpb` extension bundle, so Claude Code is the recommended Anthropic client today. If you want true Claude Desktop installation, package the server as an extension and install it from:

```text
Settings > Extensions > Advanced settings > Install Extension…
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
