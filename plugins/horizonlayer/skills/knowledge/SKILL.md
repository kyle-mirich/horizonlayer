---
name: knowledge
description: Use HorizonLayer as durable, workspace-scoped agent knowledge. Trigger when an agent needs to find prior context, save decisions or implementation knowledge, maintain pages and blocks, relate stored entities, or choose between canonical record search and citation-ready RAG retrieval.
---

# HorizonLayer Knowledge

Use the HorizonLayer MCP tools as a shared source of truth, not as a transcript dump.

## Orient first

1. Call `workspace` with `action: "list"` and reuse the closest active workspace.
2. Create a workspace only when no existing scope represents the project or subject.
3. Keep the returned IDs and revisions. Mutations of existing entities require the latest revision.
4. Start a `session` when the work should be resumable across turns or agents. Skip it for a one-off lookup.

## Retrieve before writing

- Use `search` with `mode: "records"` first when the goal is to find a real page or row to inspect, update, or link. Its compact response is the default and avoids broad list crawls.
- Use `search` with `mode: "rag"` only when semantic evidence across stored content is needed. Treat its chunks as citation-ready evidence, then follow canonical IDs when an entity must be changed.
- Reuse compact typed references such as `p_…`, `r_…`, and `d_…` directly in later tool calls; they are lossless substitutes for UUIDs. Request `format: "full"` only when exact metadata is needed.
- Always provide a search `scope`. Prefer workspace scope unless a known session or database is narrower.
- Fetch the canonical entity with `page`, `row`, or `database` before mutating it. This prevents duplicate knowledge and stale revisions.
- Follow pagination while `page.has_more` is true and `page.next_offset` is not null.

## Store useful knowledge

- Use pages for decisions, plans, architecture, research, procedures, and other prose.
- Split a page into ordered, meaningful blocks. Prefer a few coherent blocks over one block per sentence.
- Update an existing page when it already owns the subject; do not create date-stamped duplicates by default.
- Use concise tags for stable retrieval dimensions and importance from `0` to `1` only when it changes retrieval priority.
- Use `link` for explicit relationships that an agent should traverse later. Both endpoints must belong to the same workspace.
- Never store credentials, access tokens, private keys, or noisy raw logs.

## Mutate safely

1. Read the latest entity and capture its `revision`.
2. Send the smallest valid update.
3. On `CONFLICT`, read the entity again, reconcile the intended change, and retry once with the new revision.
4. Archive instead of inventing hard-delete behavior. Include archived entities only for recovery or audit work.
5. Check the structured envelope: `ok: false` is a tool failure even when the MCP call itself completed.

When reporting back, name the workspace and the pages or rows used. Include IDs only when they help a later agent continue the work.
