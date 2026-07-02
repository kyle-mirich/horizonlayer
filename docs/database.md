# Database

Horizon Layer uses PostgreSQL as both the content store and the coordination store.

The schema is migration-driven and organized into four main layers:

1. Base extensions and content graph
2. Session/expiry support
3. Coordination primitives for agents
4. Run/checkpoint state

## Migration sequence

- `001_extensions.sql`: enables `vector` and `uuid-ossp`
- `002_schema.sql`: content graph tables and vector/search indexes
- `003_workspace_sessions.sql`: workspace expiry support
- `006_coordination_primitives.sql`: task coordination primitives
- `007_schema_hardening.sql`: integrity checks, unique indexes, trigger hardening
- `009_agent_runs.sql`: durable runs and checkpoints
- `010_sessions.sql`: browser session lifecycle and session metadata support
- `011_search_fts_indexes.sql`: block and row-value full-text indexes for search
- `012_remove_historical_auth_schema.sql`: drops the legacy auth, tenancy, and billing schema
- `013_agentic_integrity.sql`: hardens agentic property uniqueness
- `014_core_integrity_and_indexes.sql`: enforces core workspace/session scope invariants and adds query-path indexes

## Core content tables

### Workspaces

`workspaces` is the top-level container for content and coordination state.

Important fields:

- `expires_at`

Workspaces are the main content and coordination boundary for most tool operations.

### Pages and blocks

- `pages` stores page metadata, hierarchy, tags, importance, expiry, and embeddings
- `blocks` stores ordered page content

Blocks are ordered by `(page_id, position)` and page embeddings are rebuilt from page title plus block text.

Session-scoped pages are required to belong to the same workspace as their session. Page tags are non-null arrays, block positions are non-negative, and block metadata is constrained to JSON objects.

### Databases, rows, and row values

- `databases` stores the table-like container
- `database_properties` stores the schema for each database
- `database_rows` stores per-row metadata, tags, importance, expiry, and embeddings
- `database_row_values` stores typed row cell values

Rows use a typed-column model:

- `value_text`
- `value_number`
- `value_date`
- `value_bool`
- `value_json`

Row values are constrained so a single cell can populate at most one typed value column. Property options are JSON objects, property positions are non-negative, and row tags are non-null arrays.

## Graph and search support

### Links

`links` stores explicit typed edges between workspaces, pages, databases, rows, and blocks.

### Search-related columns and indexes

- `pages.embedding`
- `database_rows.embedding`
- `pages_fts_idx`
- `pages_embedding_idx`
- `database_rows_embedding_idx`

This supports:

- vector similarity
- hybrid similarity + recency/importance
- title full-text search
- grep/regex search across page blocks and row values

Tag filters are backed by GIN indexes on page, database, and row tag arrays. Session resume and dashboard reads are backed by session/workspace recency indexes on pages, tasks, and runs.

## Coordination tables

The compact OSS coordination API is backed by:

- `tasks`
- `task_events`

Key coordination concepts modeled in SQL and exposed through `coordination`:

- ready vs pending work
- leases and heartbeats
- handoff targets
- event history

The schema may contain additional internal tables for future coordination features. They are not separate public MCP tools in this OSS surface.

Task sessions, task events, inbox records, and task dependencies are enforced to stay within their workspace. Claimed tasks must carry lease ownership/timing data, and terminal task states must carry their corresponding timestamp.

## Run and checkpoint tables

Long-running execution state is stored in:

- `agent_runs`
- `run_checkpoints`

Runs are workspace-scoped and can optionally point at a task. Checkpoints provide ordered resumability for agent execution state.

Run session, task, and parent-run references are enforced to share the same workspace and session. Run/checkpoint JSON payloads are constrained to objects, checkpoint sequence numbers are positive, and run list/resume queries have recency indexes.

## Operational notes

- Migrations run automatically on process startup.
- The stdio launcher can create the target database automatically when it is managing the local Docker Postgres instance.
- RDS deployments should use SSL; the app now supports `DB_SSL_MODE=require`.
- The schema assumes `pgvector` is available in the target PostgreSQL instance.
