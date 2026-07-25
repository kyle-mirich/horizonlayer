# Changelog

All notable changes to HorizonLayer are documented here.

## [Unreleased]

## [2.0.0]

### Added

- Local-first PostgreSQL MCP server for workspace-scoped pages, typed databases and rows, links, search, sessions, and resumable run checkpoints.
- Docker-managed local PostgreSQL and Qdrant runtime with persistent volumes, health checks, dashboard, and diagnostic commands.
- Bundled Codex and Claude Code plugin installation flows, including Claude Code's native user-scope marketplace registration, focused agent skills, and the stdio MCP launcher.
- Canonical fresh schema, optimistic revisions, archive/restore semantics, PostgreSQL-native record search, and optional derived local RAG indexing.

### Changed

- Consolidated local Docker lifecycle management into `horizonlayer setup`, `doctor`, and `stop`; removed conflicting standalone PostgreSQL and Qdrant helper commands.
- Added a confirmation-gated `horizonlayer reset --yes` command for safely removing the saved managed runtime and its Docker volumes.
- Added recoverable configuration, port, dependency, installer, first-run concurrency, Codex plugin ownership, and per-`HORIZONLAYER_HOME` Docker-isolation safeguards for the packaged local runtime.

This breaking release replaces the incompatible legacy 1.x package lineage with the fresh canonical schema. It has no compatibility migration path.
