---
name: horizonlayer-memory
description: Use when Codex should persist, search, resume, or update long-lived context in HorizonLayer workspaces, sessions, pages, or notes.
---

# HorizonLayer Memory

Use memory for durable context: project notes, decisions, user preferences, research findings, handoff summaries, and resume points.

## Workflow

1. Search with `memory.search` before creating new memory.
2. Start or resume the durable boundary with `session.start` or `session.resume`.
3. Use `memory.append` for concise journals, findings, decisions, and next steps.
4. Keep `workspace_id` and `session_id` from `session.start` available for later calls.
5. At the end of meaningful work, write a short summary and open follow-ups.
6. For later continuation, call `session.resume`.

## Write Shape

Good page entries are short and factual:

- what changed or was learned
- decisions and assumptions
- file paths, IDs, commands, URLs, or evidence
- next action and owner, if known

Use tags when a note should be easy to recover. Do not store secrets or raw logs unless the user asks and the content is safe.
