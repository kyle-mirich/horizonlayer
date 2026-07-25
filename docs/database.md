# HorizonLayer database guide

## Canonical storage

HorizonLayer uses PostgreSQL as its canonical local store. The first connection applies the fresh canonical [`schema.sql`](../schema.sql) schema; there are no compatibility migrations in this first-release model. Docker-managed setup runs PostgreSQL locally, while the advanced path in the [README](../README.md#advanced-use-an-existing-postgresql-instance) can use a PostgreSQL instance you operate.

Qdrant is optional and local by default. It holds a derived, rebuildable semantic index only; PostgreSQL remains authoritative. HorizonLayer does not provide hosted or multi-user database infrastructure.

## Model

- A **workspace** is the required isolation boundary.
- A **page** stores narrative knowledge as ordered blocks.
- A **database** belongs to one workspace and has exactly one required title property. It may also define `text`, `number`, `date`, `checkbox`, `url`, `select`, and `multi_select` properties.
- A **row** belongs to one database. Its value keys are exact active property names and its values must match their property types.

For select and multi-select properties, configured choices are exact and case-sensitive. A row create must provide a non-null value for the title property. Use `row` `query` for deterministic typed filters and sorting; use `search` with `mode: "records"` for natural-language retrieval across pages and rows.

## Safe changes

Existing workspace, database, property, page, and row mutations use optimistic revisions. Read the current entity before updating it, send its current `revision`, and retry only after rereading when the server returns a conflict.

Archive and restore are the public lifecycle operations. Keep archived records out of normal queries unless you are auditing or restoring them. See the [quickstart](../README.md#local-quickstart) for a complete create/query example and the [local-reset guidance](../README.md#reset-local-development-data-safely) before removing local data.
