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
