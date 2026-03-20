# API Reference

Horizon Layer exposes 8 MCP tools. Every tool returns the same success/error envelope.

## Response Envelope

Success:

```json
{
  "ok": true,
  "action": "create",
  "result": {},
  "error": null,
  "meta": {}
}
```

Error:

```json
{
  "ok": false,
  "action": "create",
  "result": null,
  "error": {
    "message": "name is required"
  },
  "meta": null
}
```

## Common Patterns

### Pagination

- `workspace`, `page`, `task`, and `run` use `limit` and `offset`
- `database` and `row` also support cursor-style pagination through `meta.next_cursor`

### Preview-only writes

`database`, `row`, and `link` support:

- `dry_run: true`
- `validate_only: true`

### Result shaping

`database`, `row`, and `link` support:

- `return: "minimal" | "full"`
- `fields: ["id", "name"]`

## Tool Summary

| Tool | Actions |
| --- | --- |
| `workspace` | `create`, `create_session`, `list`, `get`, `update`, `delete`, `start_session`, `list_sessions`, `get_session`, `resume_session_context`, `close_session` |
| `page` | `create`, `get`, `update`, `append_blocks`, `append_text`, `delete`, `list`, `block_update`, `block_delete` |
| `database` | `create`, `get`, `list`, `add_property`, `update`, `delete` |
| `row` | `create`, `get`, `update`, `delete`, `query`, `count`, `bulk_create`, `cleanup_expired` |
| `search` | `search` |
| `task` | `create`, `get`, `list`, `claim`, `heartbeat`, `complete`, `fail`, `handoff`, `ack`, `append_event`, `inbox_list`, `inbox_ack` |
| `run` | `start`, `get`, `list`, `checkpoint`, `complete`, `fail`, `cancel` |
| `link` | `create`, `list`, `delete` |

## `workspace`

Use `workspace` for top-level containers and workspace-scoped sessions.

Important fields:

- `id`: workspace id for `get`, `update`, `delete`
- `workspace_id`: workspace id for session actions
- `session_id`: session id for `get_session`, `resume_session_context`, `close_session`
- `name`: required for `create`
- `title`: session title for `start_session` or `create_session`

Example:

```json
{
  "tool": "workspace",
  "arguments": {
    "action": "create",
    "name": "Incident 2026-03-19",
    "description": "Investigate OAuth failure"
  }
}
```

## `page`

Use `page` for free-form notes and structured block content.

Important fields:

- `id`: page id for `get`, `update`, `delete`
- `page_id`: target page for `append_blocks` or appending text to an existing page
- `block_id`: target block for `block_update` or `block_delete`
- `workspace_id`: required when `append_text` creates a new journal page
- `session_id`: optional scope for create/list/get/append actions
- `blocks`: array of block objects for `create` and `append_blocks`

Supported block types:

- `paragraph`
- `text`
- `heading1`
- `heading2`
- `heading3`
- `code`
- `bulleted_list`
- `numbered_list`
- `quote`
- `callout`
- `divider`
- `image`
- `bookmark`
- `embed`

Example:

```json
{
  "tool": "page",
  "arguments": {
    "action": "append_text",
    "workspace_id": "workspace-uuid",
    "session_id": "session-uuid",
    "content": "Initial investigation notes."
  }
}
```

## `database`

Use `database` for typed schemas within a workspace or page.

Property types:

- `title`
- `text`
- `number`
- `date`
- `checkbox`
- `select`
- `multi_select`
- `url`
- `email`
- `phone`
- `relation`
- `files`

Important fields:

- `id`: database id for `get`, `update`, `delete`
- `database_id`: database id for `add_property`
- `workspace_id`: create/list scope
- `parent_page_id`: optional page parent
- `properties`: required for `create`

Example:

```json
{
  "tool": "database",
  "arguments": {
    "action": "create",
    "workspace_id": "workspace-uuid",
    "name": "Findings",
    "properties": [
      { "name": "title", "type": "title" },
      { "name": "severity", "type": "number" },
      { "name": "resolved", "type": "checkbox" }
    ]
  }
}
```

## `row`

Use `row` for records inside a database.

Important fields:

- `id`: row id for `get`, `update`, `delete`
- `database_id`: required for `create`, `query`, `count`, and `bulk_create`
- `values`: property values keyed by property name
- `filters`: typed query filters

Filter operators:

- `eq`
- `neq`
- `gt`
- `lt`
- `contains`
- `is_empty`
- `equals` and `not_equals` as aliases

Example:

```json
{
  "tool": "row",
  "arguments": {
    "action": "query",
    "database_id": "database-uuid",
    "filters": [
      { "property": "severity", "operator": "gt", "value": 7 }
    ],
    "limit": 20
  }
}
```

## `search`

Use `search` to query pages and rows.

Important fields:

- `query` or `q`: required search text
- `mode`: `similarity`, `similarity_recency`, `similarity_importance`, `full_text`, `grep`, `regex`, or `hybrid`
- `type`: shortcut of `all`, `page`, or `row`
- `content_types`: explicit override of `["pages"]`, `["rows"]`, or both
- `workspace_id`: optional workspace filter
- `session_id`: optional page-session filter
- `database_id`: restrict row results to one database

Example:

```json
{
  "tool": "search",
  "arguments": {
    "query": "oauth key rotation",
    "workspace_id": "workspace-uuid",
    "mode": "hybrid",
    "limit": 10
  }
}
```

## `task`

Use `task` for durable agent coordination.

Important fields:

- `workspace_id`: required for `create`, `list`, `claim`, and `inbox_list`
- `id`: task id for `get`, `heartbeat`, `complete`, `fail`, `handoff`, `ack`, `append_event`
- `agent_name`: required for `claim`, `heartbeat`, `complete`, `fail`, `ack`, and inbox actions
- `target_agent_name`: handoff target or event target
- `depends_on_task_ids`: dependency edges for `create`
- `required_ack_agent_names`: ack requirements for `create`

Example:

```json
{
  "tool": "task",
  "arguments": {
    "action": "claim",
    "workspace_id": "workspace-uuid",
    "id": "task-uuid",
    "agent_name": "worker-1",
    "lease_seconds": 300
  }
}
```

## `run`

Use `run` for long-lived execution attempts and checkpoints.

Important fields:

- `workspace_id`: required for `start` and `list`
- `id`: run id for `get`, `checkpoint`, `complete`, `fail`, `cancel`
- `agent_name`: required for `start`
- `task_id`: optional task association
- `state`: checkpoint payload
- `result`: completion or failure payload

Example:

```json
{
  "tool": "run",
  "arguments": {
    "action": "checkpoint",
    "id": "run-uuid",
    "summary": "Finished schema migration",
    "state": {
      "step": "migrations"
    }
  }
}
```

## `link`

Use `link` for typed relationships between entities.

Important fields:

- `from_type`, `from_id`, `to_type`, `to_id`: required for `create`
- `link_type`: optional relation label
- `item_type`, `item_id`: required for `list`
- `direction`: `from`, `to`, or `both`
- `link_id`: required for `delete`

Supported item types:

- `workspace`
- `page`
- `row`
- `database`
- `block`
- `database_row`

Example:

```json
{
  "tool": "link",
  "arguments": {
    "action": "create",
    "from_type": "row",
    "from_id": "row-uuid",
    "to_type": "page",
    "to_id": "page-uuid",
    "link_type": "documented_in"
  }
}
```
