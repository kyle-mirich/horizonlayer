# HorizonLayer database guide

## Canonical storage

HorizonLayer uses PostgreSQL as its canonical local store. The first connection applies the fresh canonical [`schema.sql`](../schema.sql) schema; existing supported schemas receive forward-only compatibility migrations during initialization. Docker-managed setup runs PostgreSQL locally, while the advanced path in the [README](../README.md#advanced-use-an-existing-postgresql-instance) can use a PostgreSQL instance you operate.

Qdrant is optional and local by default. It holds a derived, rebuildable semantic index only; PostgreSQL remains authoritative. HorizonLayer does not provide hosted or multi-user database infrastructure.

## Model

- A Knowledge **workspace** is the required isolation boundary for pages and typed databases. Setup creates or reuses a `Default` workspace when Knowledge is selected.
- A **page** stores narrative knowledge as ordered blocks.
- A **database** belongs to one workspace and has exactly one required title property. It may also define `text`, `number`, `date`, `checkbox`, `url`, `select`, and `multi_select` properties.
- A **row** belongs to one database. Its value keys are exact active property names and its values must match their property types.
- An Issue **project** is the Jira-style container for Issues and has a readable key. It is not a Knowledge workspace.
- An **Issue** belongs to one project and may have tags, comments, an assignee, a parent Issue for subtasks, and explicit blocking dependencies.
- A **record link** may connect Knowledge and Issue records. Links are optional, explicit, independently archivable, and traversed with bounded depth rather than automatic content expansion.

For select and multi-select properties, configured choices are exact and case-sensitive. A row create must provide a non-null value for the title property. Use `row` `query` for deterministic typed filters and sorting; use `search` with `mode: "records"` for natural-language retrieval across pages and rows.

## Safe changes

Existing workspace, database, property, page, row, project, Issue, dependency, and link mutations use optimistic revisions. Read the current entity before updating it, send its current `revision`, and retry only after rereading when the server returns a conflict. Issue assignment is exclusive: claim succeeds only for an unassigned, open, ready Issue at the supplied revision.

Archive and restore are the public lifecycle operations. Keep archived records out of normal queries unless you are auditing or restoring them. See the [quickstart](../README.md#local-quickstart) for a complete create/query example and the [local-reset guidance](../README.md#reset-local-development-data-safely) before removing local data.
