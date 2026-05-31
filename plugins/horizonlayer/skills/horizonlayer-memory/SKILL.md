---
name: horizonlayer-memory
description: Use when Codex should persist, search, resume, or update long-lived context in HorizonLayer workspaces, sessions, pages, or notes.
---

# HorizonLayer Memory

Use memory for durable context: project notes, decisions, user preferences, research findings, handoff summaries, and resume points.

## Workflow

1. Search with `search` before creating new memory.
2. Use `workspace.list` or create a workspace for the durable boundary.
3. Start or resume a session for the active job.
4. Use `page.append_text` for concise journals, findings, decisions, and next steps.
5. At the end of meaningful work, write a short summary and open follow-ups.
6. For later continuation, call `workspace.resume_session_context`.

## Write Shape

Good page entries are short and factual:

- what changed or was learned
- decisions and assumptions
- file paths, IDs, commands, URLs, or evidence
- next action and owner, if known

Use tags and `importance` when a note should be easy to recover. Do not store secrets or raw logs unless the user asks and the content is safe.
