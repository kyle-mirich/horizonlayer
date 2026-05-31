---
name: horizonlayer-database
description: Use when Codex should model, create, query, or update structured HorizonLayer databases and rows for agent-first state.
---

# HorizonLayer Database

Use databases when the agent needs structured records instead of prose: entities, findings, issues, leads, tasks metadata, experiments, sources, or status boards.

## Workflow

1. Search/list existing databases before creating one.
2. Create a small schema with stable names and only fields the agent will use.
3. Use `validate_only` or `dry_run` for schema changes when uncertain.
4. Write rows with `row.create` or `row.bulk_create`.
5. Query with filters/sort before scanning many rows.
6. Link rows to pages, tasks, runs, or other rows when context matters.

## Schema Defaults

Prefer fields like:

- `title` (`title`)
- `status` (`select`)
- `summary` (`text`)
- `source` (`url` or `text`)
- `confidence` (`number`)
- `owner` (`text`)
- `due_date` (`date`)
- `tags` via row tags, not extra columns unless needed

Keep prose in pages. Keep repeatable facts in rows.
