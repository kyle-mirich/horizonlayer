# src/tools

`src/tools/` is the MCP-facing layer. It defines the public tool schemas, validates incoming arguments with Zod, translates actions into query-layer calls, and normalizes results into a common response envelope.

The public surface is the compact core toolset in `core.ts`: `session`, `memory`, and `coordination`.

## Tool Files

- `core.ts`: session lifecycle, memory append/search, task coordination, and run checkpoints.
- `common.ts`: shared success/error envelopes, response sanitization, and session-to-access translation.

## Tests In This Folder

- `core.test.ts`
- `common.test.ts`

The tool tests matter because they catch schema mismatches and response-shape regressions that query-layer tests will not see.

## Conventions

- Each tool declares an action enum and a strict Zod schema.
- Missing required fields are handled inside the action switch with user-facing error messages.
- Success responses are wrapped with `successEnvelope()`.
- Failures are wrapped with `errorEnvelope()`.
- Embedding payloads are stripped out by `sanitizeResponseValue()` before returning results to clients.

## Current Auth Reality

- `accessFromSession()` currently returns `SYSTEM_ACCESS`.
- That means the tool layer is structurally ready for session-aware auth, but the OSS/local branch behaves as a single-user system by default.

## Where Behavior Actually Lives

If you need to change:

- argument names, response shapes, or validation: edit `src/tools/core.ts`
- database behavior, filtering, ranking, or state transitions: edit `src/db/queries/`

This folder is intentionally thin. Most of the complexity should stay below it.
