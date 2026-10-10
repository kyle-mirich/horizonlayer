# Configuration and operations

## Docker-managed local runtime

Use this path for the standard local installation. `setup` reuses the saved configuration and Docker volumes. A first `mcp` or `dashboard` launch without saved configuration or an explicit runtime override provisions the same managed runtime. After setup, explicit `DATABASE_URL`, `QDRANT_URL`, and `RAG_ENABLED` values take precedence. For an override on first launch, run `setup` first or use the external PostgreSQL path below.

| What | Location |
| --- | --- |
| Runtime configuration (macOS) | `~/Library/Application Support/HorizonLayer/runtime.json` |
| Runtime configuration (Windows) | `%LOCALAPPDATA%\HorizonLayer\runtime.json` |
| Runtime configuration (Linux) | `$XDG_CONFIG_HOME/horizonlayer/runtime.json`, or `~/.config/horizonlayer/runtime.json` |
| Configuration override | Set `HORIZONLAYER_HOME` to a dedicated HorizonLayer directory before its first setup. Relative paths resolve from the current working directory. New runtimes receive a dedicated Docker Compose project based on the normalized absolute directory, so `.` and `..` path aliases share one runtime and equal relative paths in different directories stay separate. Existing saved project names are reused from `runtime.json`. |
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

Only use `--yes` after checking the artifact path, saved configuration path, Compose project, compatibility, checksum, and trust warning. Confirmed recovery validates the archive, retains a safety Backup of the current database, stops published services, restores atomically in an isolated PostgreSQL container, validates the canonical schema, clears the derived Qdrant collection, and restarts healthy services. It never targets an explicit `DATABASE_URL` and never deletes Docker volumes. Keep the reported safety Backup until the recovered state has been inspected through MCP or the dashboard. See the [Backup and Runtime Recovery guide](backup-and-recovery.md) for the failure model and troubleshooting workflow.

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

## Environment variable reference

Source of truth: [`src/config.ts`](https://github.com/kyle-mirich/horizonlayer/blob/main/src/config.ts) (`loadConfig`) for defaults, [`src/localRuntime.ts`](https://github.com/kyle-mirich/horizonlayer/blob/main/src/localRuntime.ts) (`hasExplicitRuntimeOverride`) for provisioning. When `DATABASE_URL` is present, it supplies the connection instead of `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`. Only `DATABASE_URL` suppresses managed provisioning; `RAG_ENABLED` and `QDRANT_URL` never do — they refine the managed runtime instead of replacing its PostgreSQL connection.

| Variable | Default | Scope | Provisioning and lifecycle effect |
| --- | --- | --- | --- |
| `DATABASE_URL` | (none) | `mcp`, `dashboard`, `backup`, `recover` | Suppresses managed provisioning and first-launch setup. Managed Backup and Runtime Recovery refuse it. |
| `DB_HOST` | `localhost` | `mcp`, `dashboard` (external PostgreSQL path) | Used only without `DATABASE_URL`. Managed launches supply a URL; use an explicit `DATABASE_URL` to select an external database. |
| `DB_PORT` | `5432` | `mcp`, `dashboard` (external PostgreSQL path) | None. |
| `DB_NAME` | `horizon_layer` | `mcp`, `dashboard` (external PostgreSQL path) | None. |
| `DB_USER` | `postgres` | `mcp`, `dashboard` (external PostgreSQL path) | None. |
| `DB_PASSWORD` | (empty) | `mcp`, `dashboard` (external PostgreSQL path) | None. |
| `DB_SSL_MODE` | `disable` | `mcp`, `dashboard` (external PostgreSQL path) | None. |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | `mcp`, `dashboard` (external PostgreSQL path) | None. |
| `DB_POOL_MAX` | `10` | `mcp`, `dashboard` | None. |
| `DB_IDLE_TIMEOUT_MS` | `30000` | `mcp`, `dashboard` | None. |
| `DB_CONNECTION_TIMEOUT_MS` | `10000` | `mcp`, `dashboard` | None. |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | `mcp`, `dashboard` | None. |
| `DASHBOARD_PORT` | `4317` | `dashboard` (`--port` overrides it per run) | None. |
| `RAG_ENABLED` | `false` (external); `true` (managed) | `mcp`, `dashboard`, `setup`, `doctor` | Never suppresses PostgreSQL provisioning. When false, managed launches start only PostgreSQL and setup skips embedding warm-up. Allowed for Backup and Recovery; Recovery still clears and verifies Qdrant. |
| `QDRANT_URL` | `http://127.0.0.1:6333` | `mcp`, `setup` | Never suppresses provisioning. Allowed for Backup; Runtime Recovery refuses it. |
| `QDRANT_API_KEY` | (none) | `mcp`, `setup` | None. Requires `https` on non-loopback hosts. |
| `QDRANT_COLLECTION` | `horizonlayer_rag` | `mcp`, `setup` | None. |
| `QDRANT_TIMEOUT_MS` | `5000` | `mcp` | None. |
| `EMBEDDING_MODEL` | `onnx-community/all-MiniLM-L6-v2-ONNX` | `mcp`, `setup` (warm-up) | None. |
| `EMBEDDING_REVISION` | `aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f` | `mcp`, `setup` (warm-up) | None. |
| `EMBEDDING_DTYPE` | `fp32` | `mcp`, `setup` (warm-up) | None. |
| `EMBEDDING_ALLOW_DOWNLOAD` | `true` | `mcp`, dashboard semantic search, `setup` (warm-up) | When false, embedding loads require the pinned model assets in the local cache. |
| `EMBEDDING_CACHE_DIR` | `$XDG_CACHE_HOME/horizonlayer/models`, or `~/.cache/horizonlayer/models` | `mcp`, `setup` (warm-up) | None. |
| `APP_NAME` | `Horizon Layer` | `mcp` (server display name) | None. |
| `HORIZONLAYER_HOME` | (none) | `setup`, launcher | Selects a dedicated runtime directory and stable dedicated Docker Compose project. |
| `HORIZONLAYER_MODULES` | (both modules) | `setup`, `mcp` | Selects the `knowledge`, `issues`, or `both` tool catalog. |
| `HORIZONLAYER_INTEGRATION_DATABASE_URL` | (none) | Integration tests only | Never read by the launcher or MCP server. |

## Troubleshooting

| Symptom | Recovery |
| --- | --- |
| `doctor` says configuration is missing | Run `setup` first. |
| `doctor` says configuration is invalid | Fix the named variable values against the [environment variable reference](#environment-variable-reference), then run `doctor` again. |
| `mcp` or `dashboard` reports no PostgreSQL connection | Run `setup` for the managed runtime, or set `DATABASE_URL` to an existing PostgreSQL instance. |
| `install` cannot stage the plugin | Check the reported host path for a conflicting file or directory, remove or rename it, then rerun `install`. Restart the agent client after installing. |
| Setup warns the embedding model could not load | Expected degradation: setup continues with RAG disabled. Rerun `setup` to retry the warm-up. |
| Docker is missing or its daemon is unavailable | Install or start Docker Desktop (macOS/Windows), or start Docker Engine (Linux), then rerun `setup`. |
| PostgreSQL or Qdrant is unavailable | Run `doctor`, inspect Docker Desktop or the local containers, then rerun `setup`. The launcher reports the failed dependency and recovery direction. |
| No candidate local port is available | Free one of the reported loopback ports, then rerun `setup`. Setup chooses an available supported port automatically. |
| Another HorizonLayer lifecycle command is already running | Let it finish, then rerun the command. If it was interrupted and no lifecycle command remains, remove the reported `.setup.lock` file and retry. |
| Backup refuses an existing destination | Choose a new `.hlbackup` path. HorizonLayer never overwrites an existing file. |
| Recovery preview exits with status 1 | Expected: preview is read-only. Review its output, then append `--yes` to the exact displayed command only if the target and artifact are correct. |
| Backup validation or compatibility fails | Keep the current runtime running. Use an intact HorizonLayer `.hlbackup` produced by a compatible PostgreSQL 17 managed runtime; do not edit or rename another archive format. |
| Confirmed recovery fails | Read whether the receipt says the original state was preserved, the safety Backup was restored, or valid recovered data was retained. Keep both artifact paths, run `doctor`, and follow [recovery troubleshooting](backup-and-recovery.md#failure-outcomes-and-troubleshooting). |
| `runtime.json` is invalid or unreadable | Preserve existing Docker volumes. Restore a valid backup of `runtime.json`, or repair its saved paths, ports, credentials, and Compose project before restarting or recovering. A `.hlbackup` contains database records, not runtime configuration; recovery requires valid saved configuration first. |
| An external database cannot connect | Check `DATABASE_URL`, network access, and the role's schema permissions; then launch `mcp` or `dashboard` with the corrected environment. |

Run `npx -y horizonlayer@latest help` for the complete command list. Help prints to stdout; `npx -y horizonlayer@latest --version` prints the package version.
