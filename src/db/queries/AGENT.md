# src/db/queries

`src/db/queries/` is the application core. Each file owns one domain and exposes typed functions that execute SQL, enforce workspace-level access, and shape records for the tool layer.

## Domain Map

- `workspaces.ts`: create, list, fetch, update, delete, and expiry cleanup for workspaces. Also returns page/database counts on fetch.
- `sessions.ts`: workspace-scoped session lifecycle, listing, touch/update behavior, and resume bundles used to reconstruct recent context.
- `pages.ts`: page CRUD, page hierarchy, append/update/delete block operations, and page listing.
- `blocks.ts`: low-level ordered block helpers used by `pages.ts`, including block text extraction for embedding rebuilds.
- `databases.ts`: structured database CRUD plus property-schema creation and mutation.
- `rows.ts`: typed row CRUD, filterable queries, counting, bulk insert, expiry cleanup, and row-value serialization.
- `search.ts`: mixed search across pages and rows using full-text, regex/grep, vector similarity, and hybrid ranking.
- `links.ts`: explicit graph edges between workspaces, pages, databases, rows, and blocks.
- `tasks.ts`: durable task coordination including dependencies, claim/lease handling, heartbeats, handoff, acknowledgements, events, and inbox views.
- `runs.ts`: long-running execution records and ordered checkpoints.
- `accessControl.ts`: assertion helpers that check read/write access for every entity type before query modules mutate data.

## Test Coverage In This Folder

- `workspaces.test.ts`
- `sessions.test.ts`
- `pages.test.ts`
- `databases.test.ts`
- `rows.test.ts`
- `search.test.ts`
- `tasks.test.ts`
- `runs.test.ts`

These tests are useful because they exercise the behavior closest to the data model, not just the MCP wrapper layer.

## Recurring Patterns

- Query modules accept an `AccessContext`, defaulting to system access.
- Most read/write functions are narrow and domain-specific rather than generic repositories.
- Optimistic concurrency is supported in update/delete paths via `expected_updated_at`.
- Expiry support appears in multiple domains: workspaces, pages, rows, and sessions.
- Searchable entities maintain embeddings or searchable text alongside their primary content.

## File-Level Notes

- `pages.ts` and `rows.ts` do extra work beyond CRUD because page text and row values feed search.
- `tasks.ts` is one of the heaviest files in the repo. It models a task state machine directly in SQL-backed operations.
- `search.ts` is where the project stops looking like a normal CRUD app. It combines semantic search, text search, tag filters, and importance/recency ranking.
- `accessControl.ts` matters whenever you add a new mutation path. It is the shared guardrail for entity-level authorization.

## Reading Order

1. `workspaces.ts`
2. `pages.ts` and `blocks.ts`
3. `databases.ts` and `rows.ts`
4. `search.ts`
5. `tasks.ts` and `runs.ts`
6. `sessions.ts` and `links.ts`

That order matches the way the product is explained externally: content first, then retrieval, then coordination.
