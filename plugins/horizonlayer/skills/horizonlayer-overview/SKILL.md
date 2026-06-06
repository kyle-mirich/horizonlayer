---
name: horizonlayer-overview
description: Use when deciding how Codex should use HorizonLayer MCP for durable memory, search, tasks, runs, or resumable agent work.
---

# HorizonLayer Overview

HorizonLayer is agent-first durable state. Use it when work should survive the chat, be searched later, or coordinate multiple agents/runs.

## Pick The Surface

- Use `horizonlayer-memory` for sessions, notes, summaries, search, and resume context.
- Use `horizonlayer-coordination` for tasks, leases, handoffs, runs, checkpoints, and resumable execution.

## Default Loop

1. Search first with `memory.search` when prior context may exist.
2. Start or resume a session for the user goal.
3. Write concise facts, decisions, and next steps with `memory.append`.
4. Use `coordination.task_create` for durable follow-up work.
5. Use `coordination.run_checkpoint` after meaningful execution phases.
6. Resume later with `session.resume`.

## Tool Map

- `session`: session lifecycle and resume context.
- `memory`: append notes and search saved context.
- `coordination`: task leases, handoffs, and run checkpoints.

Keep writes intentional. HorizonLayer is memory, not a transcript dump.
