# HorizonLayer flows

## Docker-managed local startup

1. Run `npx -y horizonlayer@latest setup`. In an interactive terminal, choose Knowledge, Issues, or Both and whether to install the matching bundled skills. For automation, use `--non-interactive --modules knowledge|issues|both --skills none|codex|claude|all`.
2. The launcher creates or reuses local runtime settings, starts PostgreSQL and Qdrant through Docker, initializes the canonical schema, and writes a portable `.horizonlayer.json` containing only the selected modules and default scope names.
3. Run `npx -y horizonlayer@latest doctor` to check the saved configuration, Docker, PostgreSQL, and Qdrant.
4. Run `npx -y horizonlayer@latest install codex` or `npx -y horizonlayer@latest install claude`, then restart that agent client.
5. Before destructive maintenance, run `npx -y horizonlayer@latest backup`, inspect its receipt, and preview recovery with `npx -y horizonlayer@latest recover FILE`. The preview is read-only.
6. Confirmed recovery keeps a safety Backup, restores PostgreSQL atomically, validates canonical data, clears Qdrant, and restarts the services.
7. To erase this managed runtime, first run `npx -y horizonlayer@latest backup` and `npx -y horizonlayer@latest doctor`, then confirm with `npx -y horizonlayer@latest reset --yes`. It removes that runtime's services, volumes, and saved configuration; the host-side `backups/` directory survives.

See the [README quickstart](../README.md#local-quickstart) for complete setup and recovery guidance.

## Typed knowledge workflow

The default MCP catalog exposes one compact `knowledge` tool when Knowledge is selected. Pass an operation family (`workspace`, `page`, `database`, `row`, `link`, `search`, `session`, `run`, or `navigate`) plus that operation's input object.

1. Use `knowledge` with the `workspace` operation and `list` action before creating a scope, then create a workspace only when no existing scope fits.
2. Use the `database` operation and `create` action to define a stable typed collection and its properties.
3. Use the `row` operation and `create` action with values keyed by exact property names; include the title property.
4. Use `row` `query` for deterministic typed filtering, or the `search` operation with `mode: "records"` for natural-language retrieval. Use `mode: "rag"` only when semantic evidence is needed; when concurrent writes prevent a stable index snapshot, RAG search returns the valid subset flagged `stale: true` instead of failing.
5. Before changing an existing object, read it, use its latest revision, and handle a conflict by rereading before retrying.

## Issue workflow

The default MCP catalog exposes one compact `issues` tool when Issues is selected. A project is the Jira-style container for Issues; it is independent from Knowledge workspaces.

1. Use `project.list` before creating a project. Project keys provide readable Issue identifiers such as `HL-12`.
2. Use `issue.create` for Issues and optional subtasks (`parent_issue`), then add `comment.add`, tags, and explicit dependencies as needed.
3. Use `issue.query` with compact AND-only filters such as `project = HL AND status = open AND assignee IS EMPTY`, `tag = backend`, `text ~ "recovery"`, or `ready = true`.
4. Use `issue.claim` with the latest revision for exclusive assignment. A claimed, assigned, non-open, or dependency-blocked Issue cannot be claimed by another agent. Use `issue.release` to clear the assignee and reset the Issue status to `open`.
5. Link an Issue and Knowledge Page only when the relationship matters. `link.list` returns direct metadata; `link.traverse` follows a bounded graph (maximum depth 3) without automatically expanding linked content.

Knowledge and Issues share one canonical PostgreSQL database and Backup artifact, but either module can be selected alone. The legacy eight-tool MCP catalog remains available explicitly through `horizonlayer legacy-mcp` for compatibility.

## MCP error taxonomy

Every tool failure returns a structured error envelope classified centrally (`src/tools/common.ts`): `{ ok: false, action, result: null, error: { code, message, retryable }, meta }`. The six codes are:

| Code | Meaning | `retryable` |
| --- | --- | --- |
| `INVALID_ARGUMENT` | Malformed input, unknown values, or rejected preconditions | `false` |
| `INVALID_REFERENCE` | A foreign-key target does not exist | `false` |
| `NOT_FOUND` | The named record does not exist | `false` |
| `CONFLICT` | A revision mismatch, duplicate, or lifecycle precondition failure | `false`, except serialization failures, deadlocks, unavailable locks, and stale-revision writes, which are `true` |
| `DEPENDENCY_UNAVAILABLE` | PostgreSQL, Qdrant, or the network is unreachable | `true` |
| `INTERNAL` | Anything unclassified | `false` |

`INTERNAL` messages are masked: the envelope carries only `HorizonLayer could not complete the request`, while the original detail is logged server-side tagged with the action. On any other code the envelope carries the actionable message, so agents can reconcile and retry without guessing.

This workflow stays local to the PostgreSQL instance selected by the launcher or `DATABASE_URL`. The dashboard is a loopback local interface; it is not a remote collaboration or hosting service.
