---
name: issues
description: Manage agent-friendly HorizonLayer Issues through MCP. Trigger when an agent needs Jira-style projects, searchable work items, exclusive assignment, comments, tags, subtasks, dependencies, readiness filtering, or explicit links between Issues and knowledge pages.
---

# HorizonLayer Issues

Use the single `issues` MCP tool. Put the operation in `action` and its fields in `input`.

## Find work before creating it

1. Start with `project.list` and reuse the configured Issue Project.
2. Use `issue.query` with the smallest useful AND-only query, such as `project = HL AND status IN (open, blocked)`.
3. Use `ready = true` to find open, unassigned Issues without unfinished blockers.
4. Call `issue.get` for one candidate. Set `include_comments` or `include_links` only when needed.

## Coordinate safely

- Treat assignment as exclusive. Never claim an Issue with a non-null assignee.
- Use `issue.claim` with the latest revision. On `CONFLICT`, read again and choose different work.
- Release only work currently owned by the acting agent.
- Change status explicitly; never infer completion from a comment, dependency, or subtask.
- Add durable progress notes with `comment.add`; keep transient logs out of comments.

## Structure work

- Create a subtask with `parent_issue`; parent and child must belong to the same Issue Project.
- Use `dependency.create` when one Issue must finish before another becomes ready. Dependencies may cross projects and cannot form cycles.
- Prefer a few stable tags that improve queries.
- Link an Issue to a page with `link.create`. Use `link.traverse` at depth 1 first and never beyond depth 3; traversal returns references, not expanded content.

Mutations require the latest revision. Archive instead of inventing hard deletes. Check the structured envelope: `ok: false` is a tool failure even when the MCP call completed.
