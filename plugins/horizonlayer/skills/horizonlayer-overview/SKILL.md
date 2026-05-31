---
name: horizonlayer-overview
description: Use when deciding how Codex should use HorizonLayer MCP for durable memory, structured databases, search, links, tasks, runs, or resumable agent work.
---

# HorizonLayer Overview

HorizonLayer is agent-first durable state. Use it when work should survive the chat, be searched later, become structured rows, or coordinate multiple agents/runs.

## Pick The Surface

- Use `horizonlayer-memory` for workspaces, sessions, pages, notes, summaries, and resume context.
- Use `horizonlayer-database` for structured records, status tables, research rows, entities, and repeatable fields.
- Use `horizonlayer-coordination` for tasks, leases, handoffs, runs, checkpoints, and resumable execution.

## Default Loop

1. Search first when prior context may exist.
2. Reuse an existing workspace/session when it matches the user goal.
3. Create only the smallest useful structure.
4. Write concise facts, decisions, links, and next steps.
5. Prefer rows for structured facts and pages for narrative context.
6. Link related pages, rows, tasks, and runs when relationships matter.

## Tool Map

- `workspace`: workspace/session lifecycle and `resume_session_context`.
- `page`: notes, journals, summaries, block content.
- `database` and `row`: structured state.
- `search`: hybrid, full-text, grep, regex, and scoped lookup.
- `task` and `run`: coordination and checkpoints.
- `link`: relationships between stored objects.

Keep writes intentional. HorizonLayer is memory, not a transcript dump.
