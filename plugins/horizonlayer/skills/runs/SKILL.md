---
name: runs
description: Use HorizonLayer sessions and run checkpoints for resumable agent work. Trigger when work spans turns or agents, when an agent must recover prior progress, persist a compact handoff, journal one execution attempt, or finish a run with a durable result or failure.
---

# HorizonLayer Runs

Sessions group related knowledge and attempts. A run journals one execution attempt; it is not a task queue, lock, or claim system.

## Resume before starting over

1. Resolve the existing workspace with `knowledge` operation `workspace` and `input.action: "list"`.
2. Use `knowledge` operation `session` with `input.action: "list"` for active sessions.
3. Resume the closest session to retrieve its recent knowledge and execution context.
4. Inspect active runs through the `knowledge` `run` operation with `list` and `get` before creating another attempt.

Create a session only when the work needs continuity. Start a new run when beginning a distinct attempt with an identifiable agent, not for every tool call.

## Checkpoint meaningful state

Checkpoint after a material transition, before a risky or long operation, before handoff or compaction, and whenever another agent could continue from the saved state.

A useful checkpoint contains:

- a short summary of what is now true;
- structured `state` with stable IDs, current phase, decisions, and the next safe action;
- optional metadata for small machine-readable diagnostics.

Do not store full chat transcripts, repeated status messages, secrets, or large command output. Completely blank checkpoints are rejected.

## Finish accurately

- Use `completed` only when the attempt achieved its intended outcome.
- Use `cancelled` when the attempt intentionally stopped without failure.
- Use `failed` for an actual failed attempt and include a concise `error_message` when useful.
- Put durable product knowledge in pages or rows before finishing; a run result is execution history, not the canonical knowledge store.
- Close the session only when the broader body of work is no longer active.

When handing work to another agent, provide the workspace, session, and run IDs plus the latest checkpoint summary.
