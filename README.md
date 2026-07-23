# HorizonLayer

HorizonLayer is a local-first MCP knowledge layer for coding agents. PostgreSQL is the canonical store for workspaces, pages, structured databases, sessions, links, and resumable run checkpoints.

This repository starts at version `0.0.1` with a fresh schema and no compatibility surface.

The current server is intentionally small and stdio-only. It exposes eight tools:

| Tool | Purpose |
| --- | --- |
| `workspace` | Discover and manage isolated knowledge scopes |
| `session` | Start, resume, list, and close agent work sessions |
| `page` | Store nested, block-based unstructured knowledge |
| `database` | Define structured collections and typed properties |
| `row` | Create and query structured records |
| `link` | Relate stored entities inside one workspace |
| `search` | Run PostgreSQL-native retrieval in one workspace |
| `run` | Journal one execution attempt and its checkpoints |

Existing knowledge mutations use optimistic revisions, and archive/restore replaces public hard deletion. The database is initialized directly from one canonical [`schema.sql`](schema.sql).

Search responses are compact by default to keep agent context small. They return lossless typed references such as `p_wrEjJOuSTVWohCth0LT9MA`, rounded relevance scores, and UTC timestamps precise to the second. RAG results deduplicate repeated entity metadata in `sources`; each chunk citation points to its zero-based source index. Compact references work anywhere the corresponding UUID works. Pass `format: "full"` to `search` when exact UUIDs, millisecond timestamps, tags, importance, or relationship metadata are needed.

## Install for coding agents

One command installs the HorizonLayer plugin, its focused agent skills, and its MCP server configuration for both Codex and Claude Code:

```bash
npx -y horizonlayer@0.0.1 install
```

Install for only one client with `install codex` or `install claude`. Restart the client after installation. The MCP server starts through the plugin and will reuse an existing `DATABASE_URL` or launch its own local PostgreSQL container through Docker.

## Agent-friendly local commands

HorizonLayer can provision the complete local runtime through Docker Desktop on macOS and Windows. Setup starts Docker Desktop when it is installed, launches PostgreSQL and Qdrant with persistent volumes, initializes the schema, downloads the pinned local embedding model, and verifies the vector collection:

```bash
horizonlayer setup
horizonlayer doctor
horizonlayer dashboard --open
```

`dashboard` reuses the saved runtime configuration and keeps running in the foreground so an agent or process supervisor can own its lifecycle. `--open` launches the system browser. Stop the managed PostgreSQL and Qdrant services with:

```bash
horizonlayer stop
```

Runtime configuration is stored in `~/Library/Application Support/HorizonLayer` on macOS and `%LOCALAPPDATA%\\HorizonLayer` on Windows. Explicit environment variables such as `DATABASE_URL` still override saved local configuration.

## Local development

Requirements: Node.js 22+ and PostgreSQL 17+ (or Docker for the launcher's local fallback).

```bash
npm ci
npm run build
npm run verify
```

Run against an existing database:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/horizon_layer npm run dev
```

Or let the packaged launcher reuse/start local PostgreSQL:

```bash
node dist/launcher.js
```

The next product phases will add optional, fully local vector/RAG retrieval and then a new human web interface. PostgreSQL remains the source of truth; vector indexes will be derived and rebuildable.

## Verification

```bash
npm run verify
npm run build
DATABASE_URL=postgres://postgres:postgres@localhost:5432/horizon_layer npm run test:smoke:live
```

The live smoke test connects through the official MCP client over stdio and exercises the complete eight-tool workflow against the configured database.

License: MIT.
