# Main Flows

This document describes the main runtime flows in Horizon Layer.

## 1. Server startup

There are two startup paths:

### Launcher-backed stdio startup

1. `src/launcher.ts` starts the process.
2. If `DATABASE_URL` is unset, it checks whether local PostgreSQL is reachable.
3. If PostgreSQL is unavailable, it starts or resumes the managed Docker container.
4. It creates the target database if needed.
5. It calls `runServer()` in `src/runServer.ts`.

### Direct server startup

1. `src/index.ts` starts the process.
2. `runServer()` applies pending migrations.
3. `createAppServer()` builds the FastMCP server.
4. The server starts in either HTTP or stdio mode based on config.

On HTTP transport, the server:

- enforces OAuth-backed auth when enabled
- exposes `/healthz`
- registers all MCP tools

## 2. Content authoring

The content graph is centered on a workspace.

Typical flow:

1. Create or pick a workspace.
2. Create pages in that workspace, optionally with ordered blocks.
3. Create databases under the workspace or under a page.
4. Insert rows into those databases.
5. Connect entities with explicit `link` relationships.

The write path also maintains embeddings so the content can be searched semantically.

## 3. Search

The `search` tool supports:

- `full_text`
- `grep`
- `regex`
- `similarity`
- `similarity_recency`
- `similarity_importance`
- `hybrid`

Search pulls from both:

- pages and their blocks
- databases rows and typed row values

The result shape is normalized to a shared `SearchResult` shape so MCP clients can page through mixed content.

## 4. Task coordination

The `task` tool is the durable coordination surface for agents.

Typical long-lived flow:

1. Create a task in a workspace.
2. Add dependencies or required acknowledgements.
3. Claim a ready task with a lease.
4. Send periodic heartbeats while the task is in progress.
5. Complete, fail, or hand off the task.
6. Append explicit task events and consume per-agent inbox items.

The server persists:

- current task state
- dependency edges
- acknowledgement state
- append-only task events
- inbox notifications

This is the main bridge from “content storage” to “durable agent workflow”.

## 5. Run and checkpoint flow

The `run` tool models an actual execution attempt by an agent.

Typical flow:

1. Start a run for a workspace and, optionally, a task.
2. Emit checkpoints as the agent reaches durable milestones.
3. Complete, fail, or cancel the run.

Runs are useful when tasks represent the durable unit of work, and checkpoints represent resumable execution state inside that unit.

## 6. Auth

The HTTP server supports optional OAuth-backed auth via the FastMCP auth provider.

When `auth.enabled = true`, the server enforces OIDC-backed access at the MCP endpoint. Local auth (username/password) is available for single-user self-hosted deployments without an external identity provider.
