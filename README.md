# HorizonLayer

[![CI](https://github.com/kyle-mirich/horizonlayer/actions/workflows/ci.yml/badge.svg)](https://github.com/kyle-mirich/horizonlayer/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/horizonlayer)](https://www.npmjs.com/package/horizonlayer)
[![license](https://img.shields.io/npm/l/horizonlayer)](LICENSE)
[![node](https://img.shields.io/node/v/horizonlayer)](package.json)

HorizonLayer is a local PostgreSQL MCP server for coding-agent knowledge and issue tracking. PostgreSQL is canonical; Qdrant is an optional derived index for semantic retrieval.

> **Status:** Early release on the 0.x line. Bundled plugin manifests pin the exact package version for reproducible agent configurations; the commands below track `@latest`.

## Why HorizonLayer exists

Coding agents lose context between sessions and coordinate poorly with each other. HorizonLayer gives them durable memory and shared work management through one MCP server:

- **A compact MCP surface.** One `knowledge` tool and one `issues` tool instead of dozens of narrow endpoints, so agents spend their context budget on work rather than tool descriptions. Module selection (`HORIZONLAYER_MODULES`) trims the catalog to what a project actually uses.
- **Canonical data with a disposable retrieval index.** PostgreSQL 17 stores pages, blocks, typed databases, rows, issues, comments, dependencies, and links. The optional Qdrant-backed RAG index is fully derived: drop it, and it rebuilds from canonical records.
- **Safe concurrent mutation.** Every mutation carries the record's revision; conflicts return a structured `CONFLICT` envelope agents can reconcile and retry. Lifecycle operations are archive and restore — there is no accidental hard delete.
- **Disaster recovery as a first-class flow.** Checksummed `.hlbackup` artifacts, a read-only recovery preview, atomic restore in an isolated container, schema validation, and an automatic safety backup before any recovery touches data.
- **Agent guidance bundled with the tools.** Per-module skill libraries stage into Codex and Claude Code so agents learn the query language and mutation protocol without trial and error.

## Architecture

```mermaid
flowchart LR
    subgraph agent["Coding agent (Codex CLI, Claude Code, any MCP client)"]
        calls["MCP tool calls"]
    end
    subgraph server["horizonlayer MCP server (stdio, Node.js 22)"]
        k["knowledge module"]
        i["issues module"]
        lc["launcher: setup, doctor, backup, recover, reset"]
    end
    subgraph docker["Docker-managed local runtime"]
        pg[("PostgreSQL 17 - canonical store")]
        qd[("Qdrant - derived search index")]
    end
    dash["Local dashboard on 127.0.0.1:4317"]

    calls --> k & i
    k & i --> pg
    pg --> qd
    lc --- docker
    dash --> pg
```

Deeper design writeups live in [docs/engineering-notes.md](docs/engineering-notes.md); the project vocabulary lives in [docs/glossary.md](docs/glossary.md).

## The local dashboard

`horizonlayer dashboard --open` serves a read-and-edit view of canonical knowledge on loopback only — workspaces, pages and blocks, typed databases with schema editing, archive, and search.

![HorizonLayer dashboard showing a Platform Engineering workspace](docs/assets/dashboard-home.png)

Typed databases render as tables with select, number, date, text, and checkbox properties:

![Decision Log typed database in the HorizonLayer dashboard](docs/assets/dashboard-database.png)

## Local quickstart

Use Docker-managed PostgreSQL and Qdrant with the bundled Codex plugin. No global npm installation is required.

### Prerequisites

- Node.js 22 or later.
- Docker Desktop on macOS or Windows, or a running Docker Engine on Linux. The first setup downloads the PostgreSQL, Qdrant, and local embedding-model assets.
- The Codex CLI for the Codex integration below, or the Claude Code CLI for the Claude Code integration. Any MCP-capable coding agent works through its own MCP configuration without either CLI.

### 1. Install HorizonLayer and provision local services

```bash
npx -y horizonlayer@latest setup
```

`setup` selects Knowledge, Issues, or Both and optionally installs the matching Codex or Claude Code skills. It starts local services, creates or reuses the shared `Default` Knowledge Workspace and an Issue Project named after the current directory, and writes a credential-free `.horizonlayer.json`. Rerunning setup is idempotent.

For scripts or CI, provide every choice without prompts:

```bash
npx -y horizonlayer@latest setup --non-interactive --modules both --skills none
```

Supported module values are `knowledge`, `issues`, and `both`; skill targets are `none`, `codex`, `claude`, and `all`. Runtime credentials remain only in the private local `runtime.json`, never in project configuration.

### 2. Verify health

```bash
npx -y horizonlayer@latest doctor
```

The command reports the configuration path and whether Docker Desktop, PostgreSQL, and Qdrant are ready. It exits nonzero if any required local service is unavailable.

### 3. Connect a coding agent

Install the bundled plugin for your agent and restart it:

```bash
npx -y horizonlayer@latest install all
```

`install all` installs the complete bundle; `install codex` and `install claude` target one host. The installer copies the plugin and only the skills selected for this project's enabled modules. It never edits project files outside its managed directories.

| Agent | What the installer does |
| --- | --- |
| Codex CLI and ChatGPT desktop | Copies the plugin to `~/plugins/horizonlayer` and registers it in the personal marketplace at `~/.agents/plugins/marketplace.json`. |
| Claude Code | Stages a durable marketplace at `~/.claude/horizonlayer-marketplace`, registers it with `claude plugin marketplace add`, and installs the plugin at user scope. |
| Any Agent Plugins 1.0 client (for example VS Code with GitHub Copilot or Kiro) | Load the same staged plugin directory with the client's native plugin flow; the bundle includes a root `plugin.json` manifest and portable `mcp.json` conforming to the Agent Plugins 1.0 specification. |

Any other MCP-capable agent works without the plugin: register a stdio MCP server whose command is `npx` with args `-y horizonlayer@latest mcp`. On Windows the installer writes the equivalent `cmd /c npx ...` launch into staged configurations automatically, because Windows cannot spawn `npx` directly; the portable `mcp.json` keeps the bare `npx` token as the Agent Plugins specification requires.

### 4. Create and query your first typed record

After restarting the agent, paste this into its chat. It uses the installed HorizonLayer MCP tools and returns the identifiers and query result in the chat:

```text
Use HorizonLayer's `knowledge` MCP tool. Create a workspace named "HorizonLayer Quickstart" unless one already exists with that name. In it, create a typed database named "Decisions" with a title property named "Name" and a select property named "Status" whose allowed value is "accepted". Create a row with Name "HorizonLayer local setup is verified" and Status "accepted". Then query the Decisions rows where Status equals accepted. Show the workspace, database, and row IDs plus the query result.
```

The `knowledge` tool selects an operation family and accepts that operation's action in `input`. Property names and select choices are exact and case-sensitive.

### 5. Inspect it in the local dashboard

```bash
npx -y horizonlayer@latest dashboard --open
```

The dashboard listens only on `http://127.0.0.1:4317` by default. This command stays in the foreground; press `Ctrl-C` to stop it without deleting data.

## Docker-managed local runtime

Use this path for the standard local installation. `setup` reuses the saved configuration and Docker volumes. A first `mcp` or `dashboard` launch without saved configuration or an explicit runtime override provisions the same managed runtime. After setup, explicit `DATABASE_URL`, `QDRANT_URL`, and `RAG_ENABLED` values take precedence. For an override on first launch, run `setup` first or use the external PostgreSQL path below.

| What | Location |
| --- | --- |
| Runtime configuration (macOS) | `~/Library/Application Support/HorizonLayer/runtime.json` |
| Runtime configuration (Windows) | `%LOCALAPPDATA%\HorizonLayer\runtime.json` |
| Runtime configuration (Linux) | `$XDG_CONFIG_HOME/horizonlayer/runtime.json`, or `~/.config/horizonlayer/runtime.json` |
| Configuration override | Set `HORIZONLAYER_HOME` to a dedicated HorizonLayer directory before its first setup. It receives a stable, dedicated Docker Compose project; the project name is recorded in `runtime.json`. |
| PostgreSQL and Qdrant data | Docker named volumes. The default runtime uses `horizonlayer_postgres-data` and `horizonlayer_qdrant-data`; an overridden home uses the project prefix recorded in its `runtime.json`. |
| Downloaded embedding model | `$XDG_CACHE_HOME/horizonlayer/models`, or `~/.cache/horizonlayer/models` |

Stop the managed services while keeping configuration and data:

```bash
npx -y horizonlayer@latest stop
```

### Back up and recover canonical data

Create a private, point-in-time Backup of the saved managed runtime:

```bash
npx -y horizonlayer@latest backup
npx -y horizonlayer@latest backup /path/to/horizonlayer-data.hlbackup
```

Without `FILE`, HorizonLayer writes a collision-safe `.hlbackup` file under the runtime's `backups/` directory. The receipt reports its absolute path, snapshot interval, size, checksum, and compatibility versions. A Backup contains the complete PostgreSQL Knowledge and Issue store and must be handled as sensitive data. It excludes Qdrant because the Derived Search Index is rebuilt from PostgreSQL after recovery.

Recovery is deliberately two-step. First preview the exact managed target; preview makes no changes and exits nonzero so it cannot be mistaken for completion:

```bash
npx -y horizonlayer@latest recover /path/to/horizonlayer-data.hlbackup
npx -y horizonlayer@latest recover /path/to/horizonlayer-data.hlbackup --yes
```

Only use `--yes` after checking the artifact path, saved configuration path, Compose project, compatibility, checksum, and trust warning. Confirmed recovery validates the archive, retains a safety Backup of the current database, stops published services, restores atomically in an isolated PostgreSQL container, validates the canonical schema, clears the derived Qdrant collection, and restarts healthy services. It never targets an explicit `DATABASE_URL` and never deletes Docker volumes. Keep the reported safety Backup until the recovered state has been inspected through MCP or the dashboard. See the [Backup and Runtime Recovery guide](docs/backup-and-recovery.md) for the failure model and troubleshooting workflow.

### Reset local development data safely

Resetting is destructive: it permanently removes the managed local PostgreSQL knowledge, Qdrant index, containers, volumes, and saved `runtime.json`. First create and inspect a `.hlbackup`, then run `doctor` and confirm the configuration path is the local runtime you intend to erase. The default `backups/` directory is outside Docker volumes and survives reset.

```bash
npx -y horizonlayer@latest backup
npx -y horizonlayer@latest doctor
npx -y horizonlayer@latest reset --yes
```

The command uses the saved Compose project, so it removes only that managed runtime. It never targets an external `DATABASE_URL`. Run `setup` again, then recover the retained Backup to return its canonical data to the fresh runtime.

## Advanced: use an existing PostgreSQL instance

This path is for a PostgreSQL instance you operate yourself. It does not start Docker-managed services. The database role must be allowed to apply the canonical schema on first connection.

```bash
DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DATABASE' \
  RAG_ENABLED=false \
  npx -y horizonlayer@latest mcp
```

The MCP server uses stdio. To use the dashboard against that same database instead, run:

```bash
DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DATABASE' \
  RAG_ENABLED=false \
  npx -y horizonlayer@latest dashboard --open
```

Set `RAG_ENABLED=true` and `QDRANT_URL` only when you also operate a compatible Qdrant instance. Do not run `setup`, `stop`, or `reset` to manage an external PostgreSQL instance.

## Troubleshooting

| Symptom | Recovery |
| --- | --- |
| `doctor` says configuration is missing | Run `setup` first. |
| Docker is missing or its daemon is unavailable | Install or start Docker Desktop (macOS/Windows), or start Docker Engine (Linux), then rerun `setup`. |
| PostgreSQL or Qdrant is unavailable | Run `doctor`, inspect Docker Desktop or the local containers, then rerun `setup`. The launcher reports the failed dependency and recovery direction. |
| No candidate local port is available | Free one of the reported loopback ports, then rerun `setup`. Setup chooses an available supported port automatically. |
| Another HorizonLayer lifecycle command is already running | Let it finish, then rerun the command. If it was interrupted and no lifecycle command remains, remove the reported `.setup.lock` file and retry. |
| Backup refuses an existing destination | Choose a new `.hlbackup` path. HorizonLayer never overwrites an existing file. |
| Recovery preview exits with status 1 | Expected: preview is read-only. Review its output, then append `--yes` to the exact displayed command only if the target and artifact are correct. |
| Backup validation or compatibility fails | Keep the current runtime running. Use an intact HorizonLayer `.hlbackup` produced by a compatible PostgreSQL 17 managed runtime; do not edit or rename another archive format. |
| Confirmed recovery fails | Read whether the receipt says the original state was preserved, the safety Backup was restored, or valid recovered data was retained. Keep both artifact paths, run `doctor`, and follow [recovery troubleshooting](docs/backup-and-recovery.md#failure-outcomes-and-troubleshooting). |
| `runtime.json` is invalid or unreadable | Restore a backup to retain existing data. For a disposable development runtime, inspect the saved project/volume names from that backup before manually removing only those resources and the invalid config; then run `setup`. |
| An external database cannot connect | Check `DATABASE_URL`, network access, and the role's schema permissions; then launch `mcp` or `dashboard` with the corrected environment. |

Run `npx -y horizonlayer@latest help` for the complete command list.

## Data model and behavior

- Knowledge records belong to isolated workspaces. Issues belong to separate Issue Projects.
- Pages store blocks; typed databases define properties and validated rows.
- Mutations use optimistic revisions. Archive and restore are the public lifecycle operations; there is no public hard-delete workflow.
- PostgreSQL record search is available in a workspace scope. The optional RAG index is derived and rebuildable.

The default MCP catalog exposes only the enabled `knowledge` and `issues` module tools. Set `HORIZONLAYER_MODULES=knowledge` or `HORIZONLAYER_MODULES=issues` to enable one module surface; unset it or use `both` for both. The tools share one PostgreSQL database and can create explicit Page-Issue links without automatically expanding either side. `knowledge` supports bounded `navigate` traversal and `issues` supports `link.traverse`, both capped at depth 3.

Issue queries use a compact, AND-only Jira-style language. Supported filters are `project`, `status`, `priority`, `assignee`, `tag`, `text` (or `summary`), and `ready`; `IN (...)` is supported for status, priority, and tags. For example: `project = HL AND status IN (open, blocked) AND assignee IS EMPTY`.

Existing integrations can temporarily launch `horizonlayer legacy-mcp` to expose the former `workspace`, `session`, `page`, `database`, `row`, `link`, `search`, and `run` catalog. This mode is explicitly opt-in. Search responses there retain compact, lossless typed references by default.

Read [the database guide](docs/database.md) for the typed model, [the flow guide](docs/flows.md) for the startup and MCP journeys, and [the glossary](docs/glossary.md) for the exact vocabulary the code and docs share.

## Development and verification

From a repository checkout:

```bash
npm ci
npm run verify
npm run test:coverage
npm run build
HORIZONLAYER_INTEGRATION_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/horizonlayer_test' npm run test:integration:postgres
npm run test:smoke:local
npm run test:smoke:recovery
npm pack --dry-run
```

The unit and coverage commands do not require Docker or external services. The integration command requires `HORIZONLAYER_INTEGRATION_DATABASE_URL`. `test:smoke:local` provisions an isolated Docker PostgreSQL instance; `test:smoke:recovery` packs the public CLI and proves the isolated A→B→A→safety-B, reset, corruption, interruption, MCP, dashboard, SQL, and semantic-search journey. See [CONTRIBUTING.md](CONTRIBUTING.md#postgresql-integration-tests) for setup details, [docs/engineering-notes.md](docs/engineering-notes.md) for design rationale, [CHANGELOG.md](CHANGELOG.md) for release history, and [SECURITY.md](SECURITY.md) for responsible disclosure.

License: [MIT](LICENSE).
