# examples

`examples/` shows how a client is expected to use the MCP tools in realistic workflows. These are usage narratives, not tests.

## Files

- `agent-memory.md`: basic session/memory loop for persistent agent context.
- `mcp-agent-loop.md`: canonical end-to-end loop across session, memory, tasks, runs, search, and resume.
- `task-coordination.md`: multi-agent coordination with leases, heartbeats, handoffs, and run checkpoints.

## Why This Folder Matters

The examples reveal the intended product shape more clearly than isolated function signatures do:

- sessions are the resumability boundary agents interact with
- memory entries are the main content form
- search recovers saved context
- tasks and runs turn the storage layer into a durable agent execution system

## Best Use

If you are editing tool schemas or response shapes, read the examples first. They act as lightweight contract documentation for how the repo expects external clients to think about the system.
