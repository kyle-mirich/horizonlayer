# Horizon Layer

[![CI](https://github.com/kyle-mirich/horizonlayer/actions/workflows/ci.yml/badge.svg)](https://github.com/kyle-mirich/horizonlayer/actions/workflows/ci.yml)
![Node 22+](https://img.shields.io/badge/node-22%2B-339933)
![Postgres](https://img.shields.io/badge/postgres-pgvector-4169E1)
![License: MIT](https://img.shields.io/badge/license-MIT-black)

Horizon Layer is a self-hosted, local-first MCP server for durable agent memory and coordination. It gives agents one persistent system for saved context, resumable execution state, and multi-agent workflow primitives on top of PostgreSQL and pgvector.

The current runtime is deliberately local and system-only. This repository focuses on the MCP server, persistence model, and query layer. It does not include application-layer auth or SSO wiring.

## Why An Agent Uses It

Horizon Layer is meant to be mounted as an MCP server by an agent, not browsed as a human app.

The default core toolset is intentionally small. The core agent loop is:

1. start a session for the current job
2. append durable notes and findings as work progresses
3. create and claim durable tasks with leases and handoffs
4. checkpoint runs so execution can resume after interruption
5. search prior context across saved memory
6. resume the session later from one bundled context payload

If you want one file that shows the intended MCP story end to end, start with [examples/mcp-agent-loop.md](examples/mcp-agent-loop.md).

## Why This Project Exists

Most agent workflows need more than a vector store or a chat transcript. They need:

- durable workspaces and session context
- notes stored behind a small memory API
- task coordination with leases and handoffs
- run state and checkpoints for resumable execution
- hybrid semantic and keyword search across the same persistence layer

Horizon Layer puts those primitives behind a single MCP server so clients like Codex or Claude can interact with one coherent state model instead of stitching together multiple stores.

## What It Exposes

By default Horizon Layer exposes the compact first-product surface:

| Tool | Main actions |
| --- | --- |
| `session` | start, resume, close |
| `memory` | append, search |
| `coordination` | task_create, task_list, task_claim, task_heartbeat, task_complete, task_fail, task_handoff, run_start, run_checkpoint, run_complete, run_fail |

This keeps the MCP surface focused on agent memory and coordination.

## Quickstart

For most users, the MCP server installs with one command.

Codex:

```bash
codex mcp add horizonlayer -- npx -y --package=horizonlayer horizonlayer
```

Claude Code:

```bash
claude mcp add -s user horizonlayer -- npx -y --package=horizonlayer horizonlayer
```

That is enough to launch the published MCP server. The `npx` command starts HorizonLayer over stdio whenever the client needs it.

If you want the optional repo-backed Codex plugin skills as well, install from a checkout:

```bash
git clone https://github.com/kyle-mirich/horizonlayer.git
cd horizonlayer
bash scripts/install-codex-plugin.sh
```

The installer:

- installs package dependencies
- builds the HorizonLayer launcher
- registers the HorizonLayer Codex plugin for the current user
- refreshes Codex's installed plugin cache
- removes any older global HorizonLayer MCP entry to avoid duplicate servers

Restart Codex after plugin installation so the plugin skills and MCP server are loaded from the updated plugin cache.

On first launch, HorizonLayer prepares its database automatically:

- if `DATABASE_URL` is set, HorizonLayer uses it directly
- otherwise HorizonLayer tries local Postgres on `127.0.0.1:5432`
- if Postgres is still unavailable, HorizonLayer starts a local `pgvector/pgvector:pg17` Docker container
- HorizonLayer creates the `horizon_layer` database if needed
- HorizonLayer runs migrations before starting the MCP server
- HorizonLayer exposes the compact core toolset

Prerequisites:

- Node.js 22+
- Codex
- Docker Desktop or another Docker runtime, unless `DATABASE_URL` points to an existing PostgreSQL + pgvector instance

Docker is a fallback, not a requirement. To run without Docker, provide a PostgreSQL database with pgvector and export `DATABASE_URL` before starting Codex:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/horizon_layer
```

## Quick Agent Demo

If you want a fast proof that the MCP server supports the full agent loop, run:

```bash
npm ci
npm run build
npm run demo:agent
```

The demo connects through MCP over stdio and exercises the canonical flow:

- start a session
- write notes
- create and claim a task
- start and checkpoint a run
- search memory
- resume session context

By default it launches `dist/launcher.js`, so it follows the same package-style startup path as a real MCP client.

## Runtime Model

Horizon Layer defaults to stdio and is intended to be launched directly by MCP clients such as Codex and Claude. It can also run FastMCP's HTTP Stream transport for deliberately hosted deployments.

```
┌─────────────────────────────────────────────┐
│              MCP Clients                    │
│         (Claude, Codex, agents)             │
└──────────────────┬──────────────────────────┘
                   │  MCP over stdio or HTTP Stream
┌──────────────────▼──────────────────────────┐
│         Core Tool Layer (3 tools)           │
│     session · memory · coordination         │
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

## Design Principles

- Compact default tool layer: `session`, `memory`, and `coordination` cover the common agent loop.
- SQL lives in one place: application logic and persistence stay in `src/db/queries/*.ts`.
- Local-first operation: the launcher can bootstrap local PostgreSQL automatically when `DATABASE_URL` is unset.
- Shared persistence model: knowledge, coordination, and run state live in the same database instead of separate systems.
- Testable contract surface: linting, typechecking, unit tests, smoke tests, and markdown example validation are part of the repo workflow.

## Install Modes

### 1. Published npm package via `npx`

Use this when you want the fastest MCP setup for Codex or Claude Code.

Codex:

```bash
codex mcp add horizonlayer -- npx -y --package=horizonlayer horizonlayer
```

Claude Code:

```bash
claude mcp add -s user horizonlayer -- npx -y --package=horizonlayer horizonlayer
```

The explicit `--package=horizonlayer horizonlayer` form is the most reliable invocation for MCP clients.

### 2. Codex Plugin

Use this when you want Codex to load HorizonLayer skills and run the MCP server from this checkout.

```bash
git clone https://github.com/kyle-mirich/horizonlayer.git
cd horizonlayer
bash scripts/install-codex-plugin.sh
```

Behavior:

- if `DATABASE_URL` is set, the launcher uses it directly
- otherwise it tries `127.0.0.1:5432`
- if Postgres is still unavailable, it starts a local `pgvector/pgvector:pg17` Docker container
- it creates the `horizon_layer` database if needed
- it runs migrations before starting the server

The plugin is installed globally for the current user and remains connected to this checkout. The installer also refreshes Codex's plugin cache so Codex sees the latest plugin files immediately after restart.

### 3. Local build of the packaged launcher

Use this when you want package-equivalent behavior from a local checkout.

```bash
npm ci
npm run build
node dist/launcher.js
```

### 4. Local stdio development against an existing database

Use this when you are changing the server itself.

```bash
make db-up
make dev
```

## Common Commands

```bash
make help         # list common development commands
make install      # npm ci
make build        # compile TypeScript
make test         # run unit tests
make verify       # lint + typecheck + tests
make db-up        # start Postgres only
make db-down      # stop Postgres only
make dev          # local stdio server against an existing DB
make dev-stdio    # same as make dev
make smoke-live   # smoke test against an already running server
make smoke-local  # end-to-end stdio smoke test with local bootstrap
npm run install:codex-plugin # build and install the Codex plugin
```

## Quality Signals

If you are evaluating the project quickly, these are the highest-signal checks:

```bash
npm ci
npm run verify
make smoke-local
```

- `npm run verify` runs lint, typecheck, and the unit test suite.
- `make smoke-local` starts local PostgreSQL, builds the launcher, and runs the end-to-end smoke test over stdio.
- `npm run demo:agent` runs a narrative MCP workflow that shows the intended agent-facing product surface.
- GitHub Actions runs both verification and local smoke coverage on pushes and pull requests.

## MCP Client Setup

### Codex

Repo-backed plugin:

```bash
bash scripts/install-codex-plugin.sh
```

Published MCP only:

```bash
codex mcp add horizonlayer -- npx -y --package=horizonlayer horizonlayer
```

Official Codex CLI docs: <https://developers.openai.com/codex/cli>

### Claude Code

```bash
claude mcp add -s user horizonlayer -- npx -y --package=horizonlayer horizonlayer
```

Official Claude Code docs: <https://docs.anthropic.com/en/docs/claude-code/getting-started>

### Claude Desktop

This repo ships a raw stdio MCP server, not a packaged Claude Desktop extension bundle. The practical Anthropic path today is Claude Code.

Official Anthropic local MCP docs: <https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop>

## Configuration

Environment variables override `config.example.yaml`.

The most important ones are:

- `DATABASE_URL`: connect to an existing PostgreSQL instance and skip Docker bootstrap
- `APP_NAME`: MCP server name
Launcher-only variables:

- `HORIZONLAYER_DOCKER_CONTAINER_NAME`
- `HORIZONLAYER_DOCKER_VOLUME_NAME`
- `HORIZONLAYER_DOCKER_IMAGE`
- `HORIZONLAYER_DB_HOST`
- `HORIZONLAYER_DB_PORT`
- `HORIZONLAYER_DB_NAME`
- `HORIZONLAYER_DB_USER`
- `HORIZONLAYER_DB_PASSWORD`

More detail: [docs/configuration.md](docs/configuration.md)

## Documentation

- [docs/api.md](docs/api.md): tool reference
- [docs/architecture.md](docs/architecture.md): runtime layout
- [docs/database.md](docs/database.md): schema overview
- [docs/deployment.md](docs/deployment.md): Docker and AWS deployment
- [docs/flows.md](docs/flows.md): main application flows
- [docs/agent-playbook.md](docs/agent-playbook.md): contributor navigation and verification flow
- [examples/](examples/): copy-pasteable example workflows
- [examples/mcp-agent-loop.md](examples/mcp-agent-loop.md): canonical end-to-end agent workflow
- [CONTRIBUTING.md](CONTRIBUTING.md): contributor workflow
- [SECURITY.md](SECURITY.md): vulnerability reporting policy

## License

MIT. See [LICENSE](LICENSE).
