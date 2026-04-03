# src/tools

`src/tools/` is the MCP-facing layer. These files define the public tool schemas, validate incoming arguments with Zod, translate actions into query-layer calls, and normalize results into a common response envelope.

## Tool Files

- `workspaces.ts`: `workspace` tool for workspace CRUD plus workspace-scoped session actions.
- `pages.ts`: `page` tool for page creation, listing, updates, block appends, and block inspection.
- `databases.ts`: `database` tool for structured database creation and property-schema changes.
- `rows.ts`: `row` tool for typed row CRUD, querying, bulk creation, and cleanup.
- `search.ts`: `search` tool for hybrid, vector, full-text, grep, and regex search.
- `links.ts`: `link` tool for graph edges between stored entities.
- `tasks.ts`: `task` tool for coordination primitives like claim, heartbeat, handoff, inbox, and append-only events.
- `runs.ts`: `run` tool for execution tracking and checkpoints.
- `common.ts`: shared success/error envelopes, response sanitization, and session-to-access translation.
- `utils.ts`: helper utilities shared by tool implementations.

## Tests In This Folder

- `workspaces.test.ts`
- `pages.test.ts`
- `search.test.ts`
- `tasks.test.ts`
- `runs.test.ts`
- `common.test.ts`
- `session-flow.test.ts`

The tool tests matter because they catch schema mismatches and response-shape regressions that query-layer tests will not see.

## Conventions

- Each tool file declares an action enum and a strict Zod schema.
- Missing required fields are handled inside the action switch with user-facing error messages.
- Success responses are wrapped with `successEnvelope()`.
- Failures are wrapped with `errorEnvelope()`.
- Embedding payloads are stripped out by `sanitizeResponseValue()` before returning results to clients.

## Current Auth Reality

- `accessFromSession()` currently returns `SYSTEM_ACCESS`.
- That means the tool layer is structurally ready for session-aware auth, but the OSS/local branch behaves as a single-user system by default.

## Where Behavior Actually Lives

If you need to change:

- argument names, response shapes, or validation: edit files here
- database behavior, filtering, ranking, or state transitions: edit `src/db/queries/`

This folder is intentionally thin. Most of the complexity should stay below it.
