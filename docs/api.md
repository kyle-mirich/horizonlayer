# API Reference

Horizon Layer exposes 8 MCP tools. All tools follow the same response envelope and share common patterns for pagination, optimistic concurrency, and result projection.

---

## Response Envelope

Every tool call returns:

```json
{
  "ok": true,
  "action": "<action-name>",
  "result": { ... },
  "error": null,
  "meta": { ... }
}
```

On error:

```json
{
  "ok": false,
  "action": "<action-name>",
  "result": null,
  "error": "<message>",
  "meta": null
}
```

### Cursor Pagination

Paginated responses include a `meta.next_cursor` field. Pass it as `cursor` on the next call. Cursors are base64-encoded offset pointers.

```json
{
  "meta": {
    "limit": 50,
    "offset": 0,
    "next_cursor": "eyJvZmZzZXQiOjUwfQ==",
    "total": 120
  }
}
```

### Optimistic Concurrency

Update and delete operations accept `expected_updated_at` (ISO 8601 datetime). The server rejects the write if the record has been modified since that timestamp.

### Result Projection

Most list/query tools accept:

- `return`: `"minimal"` (id, name, type, timestamps) or `"full"` (default, all fields)
- `fields`: `["id", "title", "tags"]` — explicit field list (overrides `return`)

### Dry Run / Validate Only

Mutation tools accept `dry_run: true` or `validate_only: true` to preview the operation without writing to the database.

---

## `workspace`

Manages workspaces (top-level containers) and workspace-scoped sessions.

**Actions:** `create`, `list`, `get`, `update`, `delete`, `start_session`, `list_sessions`, `get_session`, `resume_session_context`, `close_session`

**Note:** `create_session` is a compatibility alias that creates a workspace and starts a session in one call.

### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `action` | enum | yes | — | Workspace action |
| `id` | uuid | for get/update/delete | — | Workspace ID |
| `workspace_id` | uuid | for session actions | — | Workspace ID (session actions) |
| `session_id` | uuid | for get_session/resume/close | — | Session ID |
| `name` | string (1–500) | for create | — | Workspace name |
| `title` | string (1–500) | for start_session | — | Session title |
| `description` | string | no | — | Workspace or session description |
| `icon` | string (max 100) | no | — | Workspace icon |
| `summary` | string | no | — | Session summary |
| `metadata` | object | no | — | Session metadata |
| `expected_updated_at` | datetime | no | — | Optimistic concurrency guard |
| `expires_in_days` | number | no | — | Workspace TTL in days |
| `limit` | int (max 500) | no | 50 | List page size |
| `offset` | int | no | 0 | List offset |
| `max_items` | int (max 100) | no | — | Per-section cap for resume_session_context |
| `max_bytes` | int (max 1 000 000) | no | — | Max inline payload for resume_session_context |

### Example

```json
{"tool":"workspace","arguments":{"action":"create","name":"Customer rollout","description":"Track investigation"}}
```

```json
{"tool":"workspace","arguments":{"action":"start_session","workspace_id":"<uuid>","title":"Sprint 12"}}
```

```json
{"tool":"workspace","arguments":{"action":"resume_session_context","workspace_id":"<uuid>","session_id":"<uuid>","max_items":10,"max_bytes":32768}}
```

---

## `page`

Manages pages and their block content within a workspace.

**Actions:** `create`, `get`, `update`, `delete`, `list`, `append_text`, `list_blocks`

### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `action` | enum | yes | — | Page action |
| `id` | uuid | for get/update/delete/append_text/list_blocks | — | Page ID |
| `workspace_id` | uuid | for create/list | — | Workspace scope |
| `session_id` | uuid | no | — | Session scope for create/list |
| `parent_page_id` | uuid | no | — | Parent page for create |
| `title` | string (max 500) | for create | — | Page title |
| `content` | string | no | — | Page content (create) or appended text (append_text) |
| `tags` | string[] | no | — | Tags for create/update |
| `importance` | number (0–1) | no | — | Importance score |
| `expires_in_days` | number | no | — | Page TTL |
| `expected_updated_at` | datetime | no | — | Optimistic concurrency guard |
| `limit` | int (max 500) | no | 50 | List page size |
| `offset` | int | no | 0 | List offset |
| `return` | `"minimal"` \| `"full"` | no | `"full"` | Result shape |
| `fields` | string[] | no | — | Explicit field projection |

### Example

```json
{"tool":"page","arguments":{"action":"create","workspace_id":"<uuid>","title":"Incident notes","content":"Initial observations."}}
```

```json
{"tool":"page","arguments":{"action":"append_text","id":"<uuid>","content":"Found root cause in auth layer."}}
```

---

## `database`

Manages structured databases (typed column schemas) within a workspace.

**Actions:** `create`, `get`, `update`, `delete`, `list`, `add_property`, `remove_property`

### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `action` | enum | yes | — | Database action |
| `id` | uuid | for get/update/delete/add_property/remove_property | — | Database ID |
| `workspace_id` | uuid | for create/list | — | Workspace scope |
| `name` | string (1–500) | for create | — | Database name |
| `description` | string | no | — | Database description |
| `properties` | PropertyDef[] | no | — | Column definitions for create |
| `property_name` | string | for add_property/remove_property | — | Property name |
| `property_type` | enum | for add_property | — | `text`, `number`, `date`, `bool`, `json` |
| `expected_updated_at` | datetime | no | — | Optimistic concurrency guard |
| `limit` | int (max 500) | no | 50 | List page size |
| `offset` | int | no | 0 | Offset |

### Example

```json
{"tool":"database","arguments":{"action":"create","workspace_id":"<uuid>","name":"Findings","properties":[{"name":"title","type":"text"},{"name":"severity","type":"number"}]}}
```

---

## `row`

Manages rows within a database. Supports typed filtering, sorting, bulk insert, and expiry.

**Actions:** `create`, `get`, `update`, `delete`, `query`, `count`, `bulk_create`, `cleanup_expired`

### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `action` | enum | no | inferred | Row action |
| `op` | enum | no | — | Alias for `action` |
| `id` | uuid | for get/update/delete | — | Row ID |
| `database_id` | uuid | for create/query/count/bulk_create | — | Database ID |
| `values` | object | for create/update | — | Property values keyed by name |
| `tags` | string[] | no | — | Row tags |
| `source` | string (max 500) | no | — | Source label for create |
| `importance` | number (0–1) | no | — | Importance score |
| `expires_in_days` | number | no | — | Row TTL |
| `expected_updated_at` | datetime | no | — | Optimistic concurrency guard for update/delete |
| `filters` | Filter[] | no | — | Filters for query/count |
| `sort_by` | string | no | — | Sort property name |
| `limit` | int (max 500) | no | 50 | Page size for query |
| `offset` | int | no | 0 | Offset for query |
| `cursor` | string | no | — | Pagination cursor for query |
| `rows` | RowInput[] | for bulk_create | — | Array of rows (max 100) |
| `return` | `"minimal"` \| `"full"` | no | `"full"` | Result shape |
| `fields` | string[] | no | — | Field projection |
| `dry_run` | bool | no | false | Preview without writing |
| `validate_only` | bool | no | false | Validate without writing |

#### Filter shape

```json
{"property": "severity", "operator": "gt", "value": 3}
```

Operators: `eq`, `neq`, `gt`, `lt`, `contains`, `is_empty` (also `equals`, `not_equals` as aliases)

### Example

```json
{"tool":"row","arguments":{"action":"create","database_id":"<uuid>","values":{"title":"Auth failure","severity":4},"tags":["bug"]}}
```

```json
{"tool":"row","arguments":{"action":"query","database_id":"<uuid>","filters":[{"property":"severity","operator":"gt","value":3}],"limit":20}}
```

---

## `search`

Searches pages and database rows with vector, full-text, and hybrid modes.

**Actions:** (single action — no `action` param required)

### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `query` | string | yes | — | Search query (alias: `q`) |
| `q` | string | no | — | Alias for `query` |
| `mode` | enum | no | `hybrid` | Search mode: `similarity`, `similarity_recency`, `similarity_importance`, `full_text`, `grep`, `regex`, `hybrid` |
| `type` | enum | no | `all` | Shorthand content filter: `all`, `page`, `row` |
| `content_types` | enum[] | no | — | Explicit types: `pages`, `rows` (overrides `type`) |
| `workspace_id` | uuid | no | — | Scope to a workspace |
| `session_id` | uuid | no | — | Scope to a session (pages only) |
| `database_id` | uuid | no | — | Scope to a database (rows only, sets content_types=rows) |
| `tags` | string[] | no | — | Filter by tags (any match) |
| `min_importance` | number (0–1) | no | — | Minimum importance threshold |
| `limit` | int (max 100) | no | 20 | Results per page |
| `offset` | int | no | 0 | Offset |

### Example

```json
{"tool":"search","arguments":{"query":"auth failure root cause","workspace_id":"<uuid>","mode":"hybrid","limit":10}}
```

---

## `task`

Durable task coordination with leases, heartbeats, dependencies, handoffs, and an agent inbox.

**Actions:** `create`, `get`, `list`, `claim`, `heartbeat`, `complete`, `fail`, `handoff`, `ack`, `append_event`, `inbox_list`, `inbox_ack`

### Task State Machine

```
pending → ready → claimed → done
                           → failed
                           → handoff_pending → claimed (by new agent)
blocked (waiting on dependencies or acks) → ready (when resolved)
cancelled (terminal)
```

### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `action` | enum | yes | — | Task action |
| `id` | uuid | for most actions | — | Task ID |
| `workspace_id` | uuid | for create/list/claim/inbox_list | — | Workspace scope |
| `session_id` | uuid | no | — | Session scope |
| `inbox_id` | uuid | for inbox_ack | — | Inbox item ID |
| `title` | string (1–500) | for create | — | Task title |
| `description` | string | no | — | Task description |
| `priority` | int ≥ 0 | no | — | Task priority |
| `owner_agent_name` | string (max 255) | no | — | Initial owner for create |
| `agent_name` | string (max 255) | for claim/heartbeat/ack | — | Acting agent name |
| `created_by_agent_name` | string (max 255) | no | — | Creator agent name |
| `target_agent_name` | string (max 255) | no | — | Target for handoff/append_event |
| `lease_seconds` | int (1–86400) | no | — | Lease duration for claim/heartbeat |
| `max_attempts` | int ≥ 0 | no | — | Max retry attempts |
| `unread_only` | bool | no | — | Inbox filter: unread items only |
| `depends_on_task_ids` | uuid[] | no | — | Dependencies for create |
| `required_ack_agent_names` | string[] | no | — | Agents that must ack before ready |
| `require_ack` | bool | no | — | Whether handoff requires ack before ready |
| `status` | enum[] | no | — | Status filter for list |
| `event_type` | string (max 64) | for append_event | — | Event type label |
| `blocker_reason` | string | for fail | — | Failure reason |
| `metadata` | object | no | — | Task metadata |
| `payload` | object | no | — | Structured payload for fail/handoff/ack/append_event |
| `limit` | int (max 500) | no | 50 | List page size |
| `offset` | int | no | 0 | Offset |

### Example

```json
{"tool":"task","arguments":{"action":"create","workspace_id":"<uuid>","title":"Verify auth fix","priority":1,"owner_agent_name":"reviewer"}}
```

```json
{"tool":"task","arguments":{"action":"claim","id":"<uuid>","agent_name":"worker-1","lease_seconds":300}}
```

```json
{"tool":"task","arguments":{"action":"heartbeat","id":"<uuid>","agent_name":"worker-1","lease_seconds":300}}
```

```json
{"tool":"task","arguments":{"action":"complete","id":"<uuid>"}}
```

---

## `run`

Models an actual agent execution attempt. Supports checkpoints for resumable execution state.

**Actions:** `start`, `get`, `list`, `checkpoint`, `complete`, `fail`, `cancel`

### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `action` | enum | yes | — | Run action |
| `id` | uuid | for get/checkpoint/complete/fail/cancel | — | Run ID |
| `workspace_id` | uuid | for start/list | — | Workspace scope |
| `session_id` | uuid | no | — | Session scope |
| `task_id` | uuid | no | — | Associated task ID |
| `parent_run_id` | uuid | no | — | Parent run ID |
| `agent_name` | string (max 255) | for start | — | Agent name |
| `title` | string (max 500) | no | — | Run title |
| `summary` | string | no | — | Checkpoint summary |
| `metadata` | object | no | — | Run or checkpoint metadata |
| `state` | object | no | — | Checkpoint state payload |
| `result` | object | no | — | Completion/failure result |
| `error_message` | string | for fail | — | Failure message |
| `status` | enum[] | no | — | Status filter for list: `running`, `completed`, `failed`, `cancelled` |
| `limit` | int (max 500) | no | 50 | List page size |
| `offset` | int | no | 0 | Offset |

### Example

```json
{"tool":"run","arguments":{"action":"start","workspace_id":"<uuid>","agent_name":"planner","title":"Triage run","session_id":"<uuid>"}}
```

```json
{"tool":"run","arguments":{"action":"checkpoint","id":"<uuid>","summary":"Completed phase 1","state":{"phase":1,"items_processed":42}}}
```

```json
{"tool":"run","arguments":{"action":"complete","id":"<uuid>","result":{"summary":"Done"}}}
```

---

## `link`

Creates and queries explicit typed edges between any two entities (workspaces, pages, databases, rows, blocks).

**Actions:** `create`, `get`, `delete`, `list`

### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `action` | enum | yes | — | Link action |
| `id` | uuid | for get/delete | — | Link ID |
| `workspace_id` | uuid | for create/list | — | Workspace scope |
| `source_type` | enum | for create | — | Source entity type: `workspace`, `page`, `database`, `row`, `block` |
| `source_id` | uuid | for create | — | Source entity ID |
| `target_type` | enum | for create | — | Target entity type |
| `target_id` | uuid | for create | — | Target entity ID |
| `relation` | string (max 100) | no | — | Relation label (e.g. `"references"`, `"blocks"`) |
| `filter_source_id` | uuid | no | — | Filter list by source entity |
| `filter_target_id` | uuid | no | — | Filter list by target entity |
| `filter_relation` | string | no | — | Filter list by relation |
| `limit` | int (max 500) | no | 50 | List page size |
| `offset` | int | no | 0 | Offset |

### Example

```json
{"tool":"link","arguments":{"action":"create","workspace_id":"<uuid>","source_type":"page","source_id":"<uuid>","target_type":"row","target_id":"<uuid>","relation":"references"}}
```

```json
{"tool":"link","arguments":{"action":"list","workspace_id":"<uuid>","filter_source_id":"<page-uuid>"}}
```
