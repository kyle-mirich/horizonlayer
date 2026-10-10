# HorizonLayer database guide

## Canonical storage

HorizonLayer uses PostgreSQL as its canonical local store. Every MCP and dashboard launch re-applies the canonical [`schema.sql`](../schema.sql) schema under an advisory lock. There is no migration or compatibility layer because HorizonLayer has no supported legacy installations yet. Docker-managed setup runs PostgreSQL locally, while the advanced path in the [configuration guide](configuration.md#advanced-use-an-existing-postgresql-instance) can use a PostgreSQL instance you operate.

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

Existing workspace, database, property, page, row, project, Issue, dependency, and link mutations use optimistic revisions. Read the current entity before updating it and send its current `revision`. For a retryable conflict, reread and reconcile before retrying; for a nonretryable conflict, resolve the condition named in the error first. Issue assignment is exclusive: claim succeeds only for an unassigned, open, ready Issue at the supplied revision.

Page block mutations advance the containing Page's revision, Database property mutations advance the Database's revision, and Row value patches advance the Row's revision. Use the returned `page_revision`, `database_revision`, or Row `revision` for subsequent writes. Each accepted aggregate mutation advances its token once, even when only child records are written; a failed child write rolls the token back with the transaction. PostgreSQL distinguishes these explicit aggregate writes from ordinary revision-only touches, which remain semantic no-ops.

Archive a Page's active child Pages and Blocks before archiving the Page. Archival holds the Page lock while checking its children, so concurrent child creation or restoration either commits first and prevents archival, or observes the archived parent and fails. Restore parent Pages before their children.

Issue creation, reparenting, project changes, and dependency changes serialize through an internal PostgreSQL coordination row held until the transaction ends so concurrent writes cannot create a parent or blocking cycle. Ordinary Issue title, status, and assignment updates do not acquire that guard. Transactions using an older repeatable-read or serializable snapshot can receive a retryable conflict; retry the whole transaction after rereading. An existing dependency can be archived to remove an edge from a stored cycle, and a parent can be detached to repair a stored ancestry cycle. Existing cycles are not repaired automatically.

Archive and restore are the public lifecycle operations. Keep archived records out of normal queries unless you are auditing or restoring them. See the [quickstart](../README.md#local-quickstart) for a complete create/query example and the [local-reset guidance](configuration.md#reset-local-development-data-safely) before removing local data.
