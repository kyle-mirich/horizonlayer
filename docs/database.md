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
- `006_coordination_primitives.sql`: tasks, dependencies, events, acknowledgements, inbox
- `007_schema_hardening.sql`: integrity checks, unique indexes, trigger hardening
- `009_agent_runs.sql`: durable runs and checkpoints
- `010_sessions.sql`: browser session lifecycle and session metadata support
- `011_search_fts_indexes.sql`: block and row-value full-text indexes for search
- `012_remove_historical_auth_schema.sql`: drops the legacy auth, tenancy, and billing schema

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

## Coordination tables

The task system is backed by:

- `tasks`
- `task_dependencies`
- `task_events`
- `task_acknowledgements`
- `agent_inbox`

Key coordination concepts already modeled in SQL:

- ready vs pending work
- leases and heartbeats
- handoff targets
- required acknowledgements
- append-only event history
- per-agent inbox state

## Run and checkpoint tables

Long-running execution state is stored in:

- `agent_runs`
- `run_checkpoints`

Runs are workspace-scoped and can optionally point at a task. Checkpoints provide ordered resumability for agent execution state.

## Operational notes

- Migrations run automatically on process startup.
- The stdio launcher can create the target database automatically when it is managing the local Docker Postgres instance.
- RDS deployments should use SSL; the app now supports `DB_SSL_MODE=require`.
- The schema assumes `pgvector` is available in the target PostgreSQL instance.
