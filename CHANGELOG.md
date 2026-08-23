# Changelog

All notable changes to HorizonLayer are documented here.

## [Unreleased]

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

[Unreleased]: https://github.com/kyle-mirich/horizonlayer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kyle-mirich/horizonlayer/releases/tag/v0.1.0
