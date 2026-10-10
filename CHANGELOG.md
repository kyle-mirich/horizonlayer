# Changelog

All notable changes to HorizonLayer are documented here.

## [Unreleased]

### Added

- A reproducible session-handoff demo using two separate MCP processes and an isolated PostgreSQL database, with a recorded walkthrough.
- Advisory mutation testing for reference parsing, tool envelopes, issue queries, and search formatting.
- Public contributor guidance, a dedicated configuration reference, and README illustrations.
- Reproducible retrieval and packed-recovery benchmarks with scoped quality measurements and commit-specific CI evidence.

### Changed

- Verification now runs locally under the required `AGENTS.md` policy; GitHub Actions CI and its README badge have been removed. Actions is reserved for release/deployment.
- A delivery-only workflow publishes stable version tags to npm and creates matching GitHub releases, using npm trusted publishing and preserving the packed artifact on retries.
- Consolidated the interview workflow into `grill-with-docs`; removed the bundled `grill-me` and `grilling` commands and updated their callers.
- Shared the managed-directory staging and rollback implementation between Codex and Claude plugin installs.
- Simplified dashboard home, archive, and error-state copy.

### Fixed

- Stable search indexing across whitespace-only and no-op mutations, and stale-result fallback when concurrent writes prevent a fresh RAG index.
- Issue readiness and claiming when blockers are done, closed, or archived; consistent workflow behavior and workspace scoping for link traversal.
- First-run setup, invalid-configuration errors, and dependency-failure messages that identify recovery steps.
- Self-contained references in installed plugins and usable dashboard copy-and-paste instructions.
- Cross-platform `npm ci` compatibility by regenerating the lockfile with npm 10.
- PostgreSQL integration coverage includes the issue-blocker suite.
- Documentation now distinguishes public GitHub reports from internal planning, links directly to private vulnerability reporting, and describes embedding downloads and recovery failure outcomes precisely.
- Aggregate revision and archive invariants, queued dashboard edits, stable catalog pagination, canonical search results, and concurrent Issue graph writes.
- PostgreSQL-only launches honor disabled RAG, and relative runtime homes retain separate managed services.
- The handoff demo waits for PostgreSQL's final TCP listener before connecting; configuration guidance accurately describes connection precedence and invalid runtime configuration recovery.

## [0.1.1] - 2026-08-26

### Added

- HorizonLayer-oriented engineering workflow skills in the bundled plugin: capability orientation, Wayfinder planning, specification and ticket planning, Implement, TDD, research, architecture, diagnosis, and review, with Matt Pocock attribution.

## [0.1.0] - 2026-08-26

### Added

- Local-first PostgreSQL MCP server for workspace-scoped pages, typed databases and rows, links, search, sessions, and resumable run checkpoints.
- A compact module-aware tool surface: one `knowledge` and one `issues` tool with operation families, structured envelopes, conflict classification, and a bounded Jira-style issue query language.
- Docker-managed local PostgreSQL 17 and Qdrant runtime with persistent volumes, loopback ports, health checks, and `setup`, `doctor`, `stop`, and `reset --yes` lifecycle commands.
- Checksummed `.hlbackup` artifacts and two-step recovery: read-only preview, safety backup, isolated atomic restore, canonical schema validation, and derived-index rebuild.
- Bundled Codex, Claude Code, and Agent Plugins 1.0 installation flows with per-module agent skills and Windows-safe MCP staging.
- Local React dashboard for workspaces, pages, blocks, and typed databases over a loopback-only bridge.
- Optimistic revisions and archive/restore lifecycle across every mutable record; PostgreSQL-native record search plus an optional rebuildable RAG index fed by local embeddings.
- Engineering notes ([docs/engineering-notes.md](docs/engineering-notes.md)) and project glossary ([docs/glossary.md](docs/glossary.md)).
- Verification gates: 657 unit tests, 90% coverage thresholds, PostgreSQL integration suites, and Docker-backed smoke journeys for the packed CLI.

[Unreleased]: https://github.com/kyle-mirich/horizonlayer/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/kyle-mirich/horizonlayer/releases/tag/v0.1.1
[0.1.0]: https://github.com/kyle-mirich/horizonlayer/releases/tag/v0.1.0
