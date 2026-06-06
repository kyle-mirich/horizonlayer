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
4. The server registers the compact core toolset.
5. The server starts over stdio.

## 2. Core memory flow

The default content flow is centered on a session.

Typical flow:

1. Use `session.start` to create or enter a durable workspace/session boundary.
2. Use `memory.append` for concise notes, decisions, findings, and handoff summaries.
3. Use `memory.search` to recover prior context.
4. Use `session.resume` to recover the recent notes, open tasks, and run state later.

The write path also maintains embeddings so the content can be searched semantically.

## 3. Search

The default `memory.search` action uses hybrid search across saved notes.

Search pulls from pages written through `memory.append`. The result shape is normalized to a shared `SearchResult` shape so MCP clients can consume ranked memory without knowing the storage tables.

## 4. Task coordination

The default `coordination` tool is the durable coordination surface for agents.

Typical long-lived flow:

1. Create a task in a workspace with `coordination.task_create`.
2. Claim a ready task with `coordination.task_claim` and a lease.
3. Send `coordination.task_heartbeat` during long work.
4. Complete, fail, or hand off with `coordination.task_complete`, `coordination.task_fail`, or `coordination.task_handoff`.

The server persists:

- current task state
- claim and lease state
- handoff state
- execution attempts associated with the task

This is the main bridge from “content storage” to “durable agent workflow”.

## 5. Run and checkpoint flow

The default `coordination` tool also models actual execution attempts by an agent.

Typical flow:

1. Start a run with `coordination.run_start` for a workspace and, optionally, a task.
2. Emit checkpoints with `coordination.run_checkpoint` as the agent reaches durable milestones.
3. Complete or fail the run with `coordination.run_complete` or `coordination.run_fail`.

Runs are useful when tasks represent the durable unit of work, and checkpoints represent resumable execution state inside that unit.

## 6. Access model

The current runtime is system-only.

Tool execution maps MCP sessions to system access for both local stdio and the optional HTTP Stream transport. Hosted deployments must rely on trusted network boundaries until application-layer login flows are added.
