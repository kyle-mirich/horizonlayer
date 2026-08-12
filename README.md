# HorizonLayer

HorizonLayer is a local-first PostgreSQL MCP server for durable coding-agent knowledge. It keeps workspace-scoped pages, typed databases and rows, relationships, searches, and resumable run checkpoints on your machine.

PostgreSQL is the canonical store. Qdrant is a local, derived index used for optional semantic retrieval; it is not a second source of truth. HorizonLayer does not configure hosted, multi-user, or remote deployment services.

> **Release line:** `2.0.0` is the fresh-schema major release. The commands below pin `@2.0.0` for reproducibility and to distinguish it from the incompatible legacy 1.x package lineage.

## Local quickstart

This is the shortest supported path: Docker-managed PostgreSQL and Qdrant, then the bundled Codex plugin. It does not require a global npm installation.

### Prerequisites

- Node.js 22 or later.
- Docker Desktop on macOS or Windows, or a running Docker Engine on Linux. The first setup downloads the PostgreSQL, Qdrant, and local embedding-model assets.
- The Codex CLI for the Codex integration below. Claude Code is also supported.

### 1. Install HorizonLayer and provision local services

```bash
npx -y horizonlayer@2.0.0 setup
```

`setup` starts Docker when supported, chooses unused loopback ports, persists a local runtime configuration, starts PostgreSQL and Qdrant with Docker volumes, initializes [`schema.sql`](schema.sql), and verifies the local embedding model and vector collection.

### 2. Verify health

```bash
npx -y horizonlayer@2.0.0 doctor
```

The command reports the configuration path and whether Docker Desktop, PostgreSQL, and Qdrant are ready. It exits nonzero if any required local service is unavailable.

### 3. Connect a coding agent

For Codex, install the bundled plugin and restart Codex:

```bash
npx -y horizonlayer@2.0.0 install codex
```

The installer copies the Codex plugin into `~/plugins/horizonlayer`, registers its local marketplace entry under `~/.agents/plugins/marketplace.json`, and asks the Codex CLI to add it. To install only the Claude Code integration instead, run `npx -y horizonlayer@2.0.0 install claude`. It stages a durable local marketplace at `~/.claude/horizonlayer-marketplace`, registers it with Claude Code, and installs `horizonlayer@horizonlayer` at user scope. Restart the relevant agent client after installation.

### 4. Create and query your first typed record

After restarting the agent, paste this into its chat. It uses the installed HorizonLayer MCP tools and returns the identifiers and query result in the chat:

```text
Use HorizonLayer's `knowledge` MCP tool. Create a workspace named "HorizonLayer Quickstart" unless one already exists with that name. In it, create a typed database named "Decisions" with a title property named "Name" and a select property named "Status" whose allowed value is "accepted". Create a row with Name "HorizonLayer local setup is verified" and Status "accepted". Then query the Decisions rows where Status equals accepted. Show the workspace, database, and row IDs plus the query result.
```

The `knowledge` tool selects an operation family (`workspace`, `database`, `row`, and others) and accepts that operation's action in `input`. Property names and select choices are exact and case-sensitive.

### 5. Inspect it in the local dashboard

```bash
npx -y horizonlayer@2.0.0 dashboard --open
```

The dashboard listens only on `http://127.0.0.1:4317` by default. This command stays in the foreground; press `Ctrl-C` to stop the dashboard process without deleting data. You can also inspect the row query returned by the agent in the previous step.

## Docker-managed local runtime

Use this path for the normal local installation. `setup` is idempotent: it reuses the saved configuration and Docker volumes on later runs. A first `mcp` or `dashboard` launch with neither a saved configuration nor an explicit runtime override provisions this same managed runtime; it never creates a separate fallback database. `setup` always targets its managed local runtime. Once it exists, explicit `DATABASE_URL`, `QDRANT_URL`, and `RAG_ENABLED` values take precedence for `mcp` and `dashboard`. For a first launch with an override, run `setup` first or use the external PostgreSQL path below.

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
npx -y horizonlayer@2.0.0 stop
```

### Back up and recover Canonical Knowledge

Create a private, point-in-time Backup of the saved managed runtime:

```bash
npx -y horizonlayer@2.0.0 backup
npx -y horizonlayer@2.0.0 backup /path/to/knowledge.hlbackup
```

Without `FILE`, HorizonLayer writes a collision-safe `.hlbackup` file under the runtime's `backups/` directory. The receipt reports its absolute path, snapshot interval, size, checksum, and compatibility versions. A Backup contains the complete PostgreSQL Canonical Knowledge store and must be handled as sensitive data. It excludes Qdrant because the Derived Search Index is rebuilt from PostgreSQL after recovery.

Recovery is deliberately two-step. First preview the exact managed target; preview makes no changes and exits nonzero so it cannot be mistaken for completion:

```bash
npx -y horizonlayer@2.0.0 recover /path/to/knowledge.hlbackup
npx -y horizonlayer@2.0.0 recover /path/to/knowledge.hlbackup --yes
```

Only use `--yes` after checking the artifact path, saved configuration path, Compose project, compatibility, checksum, and trust warning. Confirmed recovery validates the archive, retains a safety Backup of the current database, stops published services, restores atomically in an isolated PostgreSQL container, validates the canonical schema, clears the derived Qdrant collection, and restarts healthy services. It never targets an explicit `DATABASE_URL` and never deletes Docker volumes. Keep the reported safety Backup until the recovered state has been inspected through MCP or the dashboard. See the [Backup and Runtime Recovery guide](docs/backup-and-recovery.md) for the failure model and troubleshooting workflow.

### Reset local development data safely

Resetting is destructive: it permanently removes the managed local PostgreSQL knowledge, Qdrant index, containers, volumes, and saved `runtime.json`. First create and inspect a `.hlbackup`, then run `doctor` and confirm the configuration path is the local runtime you intend to erase. The default `backups/` directory is outside Docker volumes and survives reset.

```bash
npx -y horizonlayer@2.0.0 backup
npx -y horizonlayer@2.0.0 doctor
npx -y horizonlayer@2.0.0 reset --yes
```

The command uses the saved Compose project, so it removes only that managed runtime. It never targets an external `DATABASE_URL`. Run `setup` again, then recover the retained Backup to return its Canonical Knowledge to the fresh runtime.

## Advanced: use an existing PostgreSQL instance

This path is for a PostgreSQL instance you operate yourself. It does not start Docker-managed services. The database role must be allowed to apply the canonical schema on first connection.

```bash
DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DATABASE' \
  RAG_ENABLED=false \
  npx -y horizonlayer@2.0.0 mcp
```

The MCP server uses stdio. To use the dashboard against that same database instead, run:

```bash
DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DATABASE' \
  RAG_ENABLED=false \
  npx -y horizonlayer@2.0.0 dashboard --open
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

Run `npx -y horizonlayer@2.0.0 help` for the complete command list.

## Data model and behavior

- Knowledge records belong to isolated workspaces. Issues belong to Jira-style Issue Projects; these scopes stay distinct.
- Pages store block-based narrative knowledge; typed databases define properties and rows store validated records.
- Existing knowledge mutations use optimistic revisions. Archive and restore are the public lifecycle operations; there is no public hard-delete workflow.
- PostgreSQL-native record search is available in a workspace scope. The optional local RAG index is derived and rebuildable.

The default MCP catalog exposes only the enabled `knowledge` and `issues` module tools. Set `HORIZONLAYER_MODULES=knowledge` or `HORIZONLAYER_MODULES=issues` to enable one module surface; unset it or use `both` for both. The tools share one PostgreSQL database and can create explicit Page-Issue links without automatically expanding either side. `knowledge` supports bounded `navigate` traversal and `issues` supports `link.traverse`, both capped at depth 3.

Issue queries use a compact, AND-only Jira-style language. Supported filters are `project`, `status`, `priority`, `assignee`, `tag`, `text` (or `summary`), and `ready`; `IN (...)` is supported for status, priority, and tags. For example: `project = HL AND status IN (open, blocked) AND assignee IS EMPTY`.

Existing integrations can temporarily launch `horizonlayer legacy-mcp` to expose the former `workspace`, `session`, `page`, `database`, `row`, `link`, `search`, and `run` catalog. This mode is explicitly opt-in. Search responses there retain compact, lossless typed references by default.

Read [the database guide](docs/database.md) for the typed model and [the flow guide](docs/flows.md) for the startup and MCP journeys.

## Development and verification

From a repository checkout:

```bash
npm ci
npm run verify
npm run test:coverage
npm run build
npm run test:integration:postgres
npm run test:smoke:local
npm run test:smoke:recovery
npm pack --dry-run
```

The unit and coverage commands do not require Docker or external services. The integration command requires `HORIZONLAYER_INTEGRATION_DATABASE_URL`. `test:smoke:local` provisions an isolated Docker PostgreSQL instance; `test:smoke:recovery` packs the public CLI and proves the isolated A→B→A→safety-B, reset, corruption, interruption, MCP, dashboard, SQL, and semantic-search journey. See [CONTRIBUTING.md](CONTRIBUTING.md#postgresql-integration-tests) for setup details, [CHANGELOG.md](CHANGELOG.md) for release history, and [SECURITY.md](SECURITY.md) for responsible disclosure.

License: [MIT](LICENSE).
