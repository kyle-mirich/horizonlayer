# Engineering notes

Design rationale for HorizonLayer, written for engineers evaluating the codebase. Each section explains a constraint, the decision it drove, and where the implementation lives.

## One compact tool per module

LLM tool-calling quality degrades as catalogs grow: every additional schema spends prompt tokens on every turn, and near-duplicate tools increase mis-selection. HorizonLayer exposes exactly one tool per enabled module — `knowledge` and `issues` — with an operation family in `action` and that operation's fields in `input` (`src/tools/modules.ts`). The legacy eight-tool catalog remains available behind an explicit `legacy-mcp` command for existing integrations, but new projects get two tools regardless of feature count.

Module selection happens before registration, not behind runtime branches: `HORIZONLAYER_MODULES=issues` produces a server whose catalog contains only issue operations. Setup writes this choice into `.horizonlayer.json`, so a project that never uses knowledge records never sees knowledge tools.

## Compact typed references

Search results and traversal responses return identifiers like `p_9nR3…` instead of 36-character UUIDs (`src/references.ts`). A compact reference is the UUID re-encoded as unpadded base64url with a one-letter kind prefix, so it is lossless: any tool accepts either form, and the parser validates both length and round-trip encoding rather than trusting the prefix. This keeps agent transcripts small without a second ID space to reconcile. The JSON Schema advertises the same grammar the runtime accepts, so validation errors are caught by the client before the call is made.

Issue work adds readable keys (`HL-12`) because humans join agents in triage; the resolver accepts all three forms at every boundary where an Issue is named.

## Canonical store, derived index

PostgreSQL is the only authoritative representation. The optional RAG pipeline chunks pages and rows, embeds them locally (the embedding model ships as an npm optional dependency, keeping the default install small and offline-capable), and upserts vectors into Qdrant. Every write enqueues a search-index change in PostgreSQL itself (`workspace_search_changes`), and the indexer drains that queue under a lock file so two processes never race.

The consequence is deliberate: Qdrant can be deleted at any time and rebuilt from canonical data with no user-visible loss. Recovery exploits this — restoring a backup restores PostgreSQL, clears the derived collection, and lets the rebuild path repopulate it.

## Optimistic revisions over locks

Every mutable record carries a monotonic `revision`. Mutations must echo the revision they read; a mismatch returns a structured `CONFLICT` envelope classified centrally (`src/tools/common.ts`), which agents are taught to handle by re-reading, reconciling, and retrying once. This fits agent traffic better than row locks or advisory locking: collisions are rare, but when they happen the losing writer gets a machine-readable reason, not a hang or a silent clobber.

Lifecycle is archive/restore only. Hard deletes are absent from the public surface by design, which makes "undo" a restore and makes recovery reasoning tractable.

## An issue tracker designed for non-human workers

The issue module encodes coordination rules that matter when most writers are software:

- **Exclusive assignment**: claiming requires the server-side precondition `status = open AND assignee IS NULL`; two agents racing to claim cannot both win.
- **A computed ready queue**: `ready = true` filters open, unassigned issues whose blocking dependencies are not active, so "what can I pick up next" is one query rather than client-side graph logic.
- **Cycle prevention in SQL**: dependency insertion checks reachability inside the transaction, so a blocker cycle is rejected atomically rather than detected later.
- **Same-project subtasks, cross-project dependencies**: subtasks model decomposition inside a team; dependencies model cross-team ordering.
- **AND-only Jira-style query language** (`src/tools/issueQuery.ts`): a small deterministic parser covering `project`, `status`, `priority`, `assignee`, `tag`, `text`, and `ready`, with `IN (...)` on enumerable fields. Restricting the grammar keeps generated queries valid and reviewable.

## Backup and recovery as a designed flow

Backups are single-file `.hlbackup` artifacts with magic bytes, a manifest, checksums, and compatibility versions, written collision-safe (never overwrite) via temp-then-rename (`src/backupArtifact.ts`, `src/localBackup.ts`). Recovery is deliberately two-step: a read-only preview prints the exact target and exits nonzero, so an unattended `recover FILE` cannot be mistaken for success. Confirmed recovery validates the artifact, takes a safety backup, stops services, restores in an isolated container, validates the canonical schema table-by-table, clears the derived index, and restarts — preserving the original state if any step fails (`src/localRecovery.ts`).

The whole journey — A→B→A recovery, safety-backup return to B, corruption refusal, interruption handling, reset survival — is exercised end-to-end against the packed public CLI by `scripts/smoke-recovery.sh`.

## Skills bundled beside the tools

The installer stages per-module skill libraries (`plugins/horizonlayer/skills/{knowledge,issues}`) into Codex and Claude Code alongside the MCP registration. Skills teach the query language, the claim/release protocol, pagination caps, and the conflict-retry pattern — the parts of the contract agents otherwise learn by failed experimentation. Staging filters skills to the project's enabled modules and adapts Windows launches (`cmd /c npx …`) while leaving the portable Agent Plugins 1.0 manifest untouched.

## Verification as an evaluation harness

The test suite treats behavior contracts as executable specifications:

- **657 unit tests across server and dashboard**, with v8 coverage gates at 90% for branches, functions, lines, and statements enforced in CI.
- **Contract tests** pin cross-layer agreements: emitted SQL vs `schema.sql` table sets, MCP envelope shapes, compact-reference grammar, and query-language parsing.
- **PostgreSQL integration suites** run real concurrency, optimistic-revision, and RAG-generation scenarios against disposable schemas, failing hard (not skipping) when the database variable is unset.
- **Docker-backed smoke journeys** drive the packed CLI exactly as users do: setup → MCP → dashboard → backup → recover, in isolated temporary homes.

This layered structure exists so refactors of internal seams (transaction helpers, editor state, tool definition registries) stay cheap: the outer contracts hold while internals move.
