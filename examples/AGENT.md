# examples

`examples/` shows how a client is expected to use the MCP tools in realistic workflows. These are usage narratives, not tests.

## Files

- `agent-memory.md`: basic workspace/session/page/search loop for persistent agent memory.
- `structured-knowledge.md`: structured databases, typed rows, and hybrid search across rows plus page content.
- `task-coordination.md`: multi-agent coordination with dependencies, leases, heartbeats, handoffs, acknowledgements, and inbox items.

## Why This Folder Matters

The examples reveal the intended product shape more clearly than isolated function signatures do:

- workspaces are the top-level boundary
- sessions are resumability slices inside a workspace
- pages and rows are the two main content forms
- search spans both content forms
- tasks and runs turn the storage layer into a durable agent execution system

## Best Use

If you are editing tool schemas or response shapes, read the examples first. They act as lightweight contract documentation for how the repo expects external clients to think about the system.
