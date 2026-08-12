# HorizonLayer flows

## Docker-managed local startup

1. Run `npx horizonlayer setup`. In an interactive terminal, choose Knowledge, Issues, or Both and whether to install the matching bundled skills. For automation, use `--non-interactive --modules knowledge|issues|both --skills none|codex|claude|all`.
2. The launcher creates or reuses local runtime settings, starts PostgreSQL and Qdrant through Docker, initializes the canonical schema, and writes a portable `.horizonlayer.json` containing only the selected modules and default scope names.
3. Run `npx -y horizonlayer@2.0.0 doctor` to check the saved configuration, Docker, PostgreSQL, and Qdrant.
4. Run `npx -y horizonlayer@2.0.0 install codex` or `install claude`, then restart that agent client. The Claude path stages a persistent local marketplace and uses Claude Code's native user-scope plugin installation flow.
5. Before destructive maintenance, run `backup`, inspect its receipt, and preview it with `recover FILE`. The preview is read-only and prints the exact confirmation command.
6. Confirmed `recover FILE --yes` retains a safety Backup, stops published services, restores PostgreSQL atomically through an isolated container, validates canonical Knowledge and Issue data, clears the Derived Search Index, and restarts healthy services.
7. To deliberately erase only this managed local runtime, first run `backup` and `doctor`, then confirm with `reset --yes`. It removes that runtime's Compose services, volumes, and saved configuration, but the default host-side `backups/` directory survives.

See the [README quickstart](../README.md#local-quickstart) for complete setup and recovery guidance.

## Typed knowledge workflow

The default MCP catalog exposes one compact `knowledge` tool when Knowledge is selected. Pass an operation family (`workspace`, `page`, `database`, `row`, `link`, `search`, `session`, `run`, or `navigate`) plus that operation's input object.

1. Use `knowledge` with the `workspace` operation and `list` action before creating a scope, then create a workspace only when no existing scope fits.
2. Use the `database` operation and `create` action to define a stable typed collection and its properties.
3. Use the `row` operation and `create` action with values keyed by exact property names; include the title property.
4. Use `row` `query` for deterministic typed filtering, or the `search` operation with `mode: "records"` for natural-language retrieval.
5. Before changing an existing object, read it, use its latest revision, and handle a conflict by rereading before retrying.

## Issue workflow

The default MCP catalog exposes one compact `issues` tool when Issues is selected. A project is the Jira-style container for Issues; it is independent from Knowledge workspaces.

1. Use `project.list` before creating a project. Project keys provide readable Issue identifiers such as `HL-12`.
2. Use `issue.create` for Issues and optional subtasks (`parent_issue`), then add `comment.add`, tags, and explicit dependencies as needed.
3. Use `issue.query` with compact AND-only filters such as `project = HL AND status = open AND assignee IS EMPTY`, `tag = backend`, `text ~ "recovery"`, or `ready = true`.
4. Use `issue.claim` with the latest revision for exclusive assignment. A claimed, assigned, non-open, or dependency-blocked Issue cannot be claimed by another agent.
5. Link an Issue and Knowledge Page only when the relationship matters. `link.list` returns direct metadata; `link.traverse` follows a bounded graph (maximum depth 3) without automatically expanding linked content.

Knowledge and Issues share one canonical PostgreSQL database and Backup artifact, but either module can be selected alone. The legacy eight-tool MCP catalog remains available explicitly through `horizonlayer legacy-mcp` for compatibility.

This workflow stays local to the PostgreSQL instance selected by the launcher or `DATABASE_URL`. The dashboard is a loopback local interface; it is not a remote collaboration or hosting service.
