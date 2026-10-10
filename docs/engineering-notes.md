# Engineering notes

Design rationale for HorizonLayer, written for engineers evaluating the codebase.

## Tool catalog

HorizonLayer exposes one tool per enabled module — `knowledge` and `issues` — with an operation family in `operation` for `knowledge` (in `action` for `issues`) and that operation's fields in `input` (`src/tools/modules.ts`). This keeps the top-level catalog small; there is no comparative agent evaluation behind the choice. Operation discovery also depends on the bundled skills. The legacy eight-tool catalog remains available behind an explicit `legacy-mcp` command for existing integrations.

Module selection happens before registration: `HORIZONLAYER_MODULES=issues` produces a server whose catalog contains only issue operations. Only enabled modules are registered. Setup writes this choice into `.horizonlayer.json`, so a project that never uses knowledge records never sees knowledge tools.

## Compact typed references

Search results and traversal responses return identifiers like `p_9nR3…` instead of 36-character UUIDs (`src/references.ts`). A compact reference is the UUID re-encoded as unpadded base64url with a one-letter kind prefix, so it is lossless: any tool accepts either form, and the parser validates both length and round-trip encoding rather than trusting the prefix. The JSON Schema advertises the same grammar the runtime accepts.

Issue work adds readable keys (`HL-12`) because humans join agents in triage; the resolver accepts all three forms at every boundary where an Issue is named.

## Canonical store and derived index

![Conceptual illustration of a durable record stack feeding a rebuildable index](https://raw.githubusercontent.com/kyle-mirich/horizonlayer/main/docs/assets/canonical-and-derived.png)

The illustration is a visual metaphor; the README's architecture diagram shows the actual components.

PostgreSQL is the only authoritative representation. The optional RAG pipeline chunks pages and rows, embeds them locally using the optional `@huggingface/transformers` runtime, and upserts vectors into Qdrant. Search-relevant mutations enqueue a search-index change in PostgreSQL itself (`workspace_search_changes`), and the indexer drains that queue under a PostgreSQL advisory lock so two processes never race.

Model weights are downloaded separately and cached on first use. Offline embeddings require the runtime and pinned model assets to be available already; the npm package does not bundle the weights.

Qdrant can be rebuilt from canonical data without losing the underlying records. Semantic retrieval can be unavailable or stale while the index is rebuilding. Recovery restores PostgreSQL, clears the derived collection, and lets the rebuild path repopulate it.

## Revisions and database invariants

Revisioned records carry a monotonic `revision`. Updates must echo the revision the client read; a mismatch returns a retryable `CONFLICT` envelope classified centrally (`src/tools/common.ts`). Agents reread, reconcile, and retry once. Nonretryable conflicts describe conditions that must be resolved first. PostgreSQL locks also protect invariants that span records, such as Page archive checks racing with child writes.

Lifecycle is archive/restore only. Hard deletes are absent from the public surface, which makes "undo" a restore.

## Issue coordination

The issue module encodes coordination rules for concurrent writers:

- **Exclusive assignment**: claiming requires the server-side precondition `status = open AND assignee IS NULL`; two agents racing to claim cannot both win.
- **A computed ready queue**: `ready = true` filters open, unassigned issues whose blocking dependencies are not active — a blocker that is `done` or `closed` no longer blocks — so "what can I pick up next" is one query rather than client-side graph logic.
- **Cycle prevention in SQL**: a statement trigger writes an internal `issue_graph_state` row before Issue creation, reparenting, project changes, or dependency changes. Reachability checks run after that serialization point. The real row write also rejects repeatable-read and serializable snapshots made stale by an intervening committed graph write with `40001`, which is classified as a retryable conflict. Parent traversal detects repeated ancestors and terminates even when older data contains a cycle; dependency archive can remove an edge from one. Existing cycles require explicit repair.
- **Same-project subtasks, cross-project dependencies**: subtasks model decomposition inside a team; dependencies model cross-team ordering.
- **AND-only Jira-style query language** (`src/tools/issueQuery.ts`): a small deterministic parser covering `project`, `status`, `priority`, `assignee`, `tag`, `text`, and `ready`, with `IN (...)` on enumerable fields. Restricting the grammar keeps generated queries valid and reviewable.

## Backup and recovery

Backups are single-file `.hlbackup` artifacts with magic bytes, a manifest, checksums, and compatibility versions, written collision-safe (never overwrite) via a private temp file plus hard-link publish (`src/backupArtifact.ts`, `src/localBackup.ts`). Staging happens beside the destination, so publish is a same-filesystem hard link that fails atomically when the destination already exists. Every MCP and dashboard launch re-applies the canonical `schema.sql` under an advisory lock (`src/db/initialize.ts`), so there is no migration layer. Recovery is deliberately two-step: a read-only preview prints the exact target and exits nonzero, so an unattended `recover FILE` cannot be mistaken for success. Confirmed recovery validates the artifact, takes a safety backup, stops services, restores in an isolated container, checks that the 16 required canonical tables are present, clears the derived index, and restarts (`src/localRecovery.ts`). A failure before commit preserves the original database; a failure after commit but before canonical and index validation triggers safety rollback. If the final service restart fails after those validations succeed, valid recovered data is retained. The internal Issue graph coordination table is included in new PostgreSQL dumps and recreated on schema initialization when an earlier backup lacks it; it does not change the artifact version or the required-table check. See [the recovery failure phases](backup-and-recovery.md#failure-outcomes-and-troubleshooting) before choosing a follow-up action.

The whole journey — A→B→A recovery, safety-backup return to B, corruption refusal, interruption handling, reset survival — is exercised end-to-end against the packed public CLI by `scripts/smoke-recovery.sh`.

## Bundled skills

The installer stages per-module skill libraries (`plugins/horizonlayer/skills/{knowledge,issues}`) into Codex and Claude Code alongside the MCP registration. It also stages the adapted Matt Pocock engineering workflow and `using-horizonlayer` orientation skill for every installation; module filtering trims only the product skills. The skills cover the query language, the claim/release protocol, pagination caps, the conflict-retry pattern, and the Wayfinder-to-Implement handoff. Staging adapts Windows launches (`cmd /c npx …`) while leaving the portable Agent Plugins 1.0 manifest untouched. Attribution is retained in `plugins/horizonlayer/THIRD_PARTY_NOTICES.md`.

## Tests

- **Unit tests across server and dashboard**, with v8 coverage gates at 90% for branches, functions, lines, and statements enforced in CI.
- **Contract tests** pin cross-layer agreements: emitted SQL vs `schema.sql` table sets, MCP envelope shapes, compact-reference grammar, and query-language parsing.
- **PostgreSQL integration suites** run real concurrency, optimistic-revision, and RAG-generation scenarios against disposable schemas, failing hard (not skipping) when the database variable is unset.
- **Docker-backed smoke journeys** drive the packed CLI exactly as users do: setup → MCP → dashboard → backup → recover, in isolated temporary homes.
