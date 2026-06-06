# API Reference

Horizon Layer exposes three MCP tools: `session`, `memory`, and `coordination`. This is the whole public OSS tool surface.

All tools return the same response envelope.

```json
{
  "ok": true,
  "action": "<action-name>",
  "result": { },
  "error": null,
  "meta": { }
}
```

On error:

```json
{
  "ok": false,
  "action": "<action-name>",
  "result": null,
  "error": { "message": "<message>" },
  "meta": { }
}
```

## `session`

Starts, resumes, and closes task-scoped work sessions.

**Actions:** `start`, `resume`, `close`

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | enum | yes | `start`, `resume`, or `close` |
| `workspace_id` | uuid | no | Existing workspace for `start` or scope check for `resume` |
| `workspace_name` | string | no | Workspace to create when `workspace_id` is omitted |
| `session_id` | uuid | for `resume`/`close` | Session ID |
| `title` | string | no | Session title for `start` |
| `summary` | string | no | Session summary for `start` |
| `max_items` | int | no | Per-section cap for `resume` |

```json
{"tool":"session","arguments":{"action":"start","workspace_name":"Customer rollout","title":"Sprint 12","summary":"Track rollout tasks and decisions"}}
```

```json
{"tool":"session","arguments":{"action":"resume","workspace_id":"<uuid>","session_id":"<uuid>","max_items":10}}
```

## `memory`

Appends concise notes and searches stored context.

**Actions:** `append`, `search`

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | enum | yes | `append` or `search` |
| `workspace_id` | uuid | for new append/search scope | Workspace scope |
| `session_id` | uuid | no | Optional session scope |
| `page_id` | uuid | no | Existing page to append to |
| `title` | string | no | Page title when appending without `page_id` |
| `content` | string | for `append` | Text to store |
| `query` | string | for `search` | Search query |
| `tags` | string[] | no | Tags for append or search filtering |
| `limit` | int | no | Search limit, default 20 |

```json
{"tool":"memory","arguments":{"action":"append","workspace_id":"<uuid>","session_id":"<uuid>","title":"Incident journal","content":"Queued follow-up to drain the ingestion backlog."}}
```

```json
{"tool":"memory","arguments":{"action":"search","workspace_id":"<uuid>","session_id":"<uuid>","query":"queue lag root cause","limit":10}}
```

## `coordination`

Coordinates durable work through task leases, handoffs, and run checkpoints.

**Actions:** `task_create`, `task_list`, `task_claim`, `task_heartbeat`, `task_complete`, `task_fail`, `task_handoff`, `run_start`, `run_checkpoint`, `run_complete`, `run_fail`

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | enum | yes | Coordination action |
| `workspace_id` | uuid | for task create/list/claim and run start | Workspace scope |
| `session_id` | uuid | no | Optional session scope |
| `task_id` | uuid | for task mutations and run association | Task ID |
| `run_id` | uuid | for run mutations | Run ID |
| `title` | string | for `task_create`; optional for `run_start` | Task or run title |
| `description` | string | no | Task description |
| `priority` | int | no | Task priority |
| `owner_agent_name` | string | no | Initial task owner |
| `agent_name` | string | for claim/heartbeat/complete/fail/run actions | Acting agent |
| `target_agent_name` | string | for `task_handoff` | Handoff target |
| `lease_seconds` | int | no | Lease duration for task claim/heartbeat |
| `status` | enum[] | no | Task status filters for `task_list` |
| `payload` | object | no | Structured task payload |
| `blocker_reason` | string | no | Task failure/blocker reason |
| `summary` | string | no | Checkpoint summary |
| `state` | object | no | Checkpoint state |
| `result` | object | no | Run completion/failure result |
| `error_message` | string | no | Run failure message |
| `limit` | int | no | List limit |

```json
{"tool":"coordination","arguments":{"action":"task_create","workspace_id":"<uuid>","session_id":"<uuid>","title":"Verify queue drain fix","priority":1,"owner_agent_name":"reviewer"}}
```

```json
{"tool":"coordination","arguments":{"action":"task_claim","workspace_id":"<uuid>","session_id":"<uuid>","task_id":"<uuid>","agent_name":"worker-1","lease_seconds":300}}
```

```json
{"tool":"coordination","arguments":{"action":"run_start","workspace_id":"<uuid>","session_id":"<uuid>","task_id":"<uuid>","agent_name":"worker-1","title":"Verification run"}}
```

```json
{"tool":"coordination","arguments":{"action":"run_checkpoint","run_id":"<uuid>","agent_name":"worker-1","summary":"Completed phase 1","state":{"phase":1,"items_processed":42}}}
```
