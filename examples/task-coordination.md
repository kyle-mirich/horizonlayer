# Example: Multi-Agent Task Coordination

This example shows how multiple agents coordinate work using the `task` tool. Tasks support dependencies, leases, heartbeats, handoffs, and an inbox for per-agent notifications.

---

## Task state machine

```
pending  ──(deps resolved)──→  ready  ──(claim)──→  claimed  ──(complete)──→  done
                                                               ──(fail)──────→  failed
                                                               ──(handoff)───→  handoff_pending ──→ claimed
blocked  ──(acks received)──→  ready
```

---

## 1. Create tasks with dependencies

Planner agent creates two tasks. Task B cannot start until Task A is done.

```json
{
  "tool": "task",
  "arguments": {
    "action": "create",
    "workspace_id": "ws-uuid",
    "title": "Collect system metrics",
    "priority": 0,
    "created_by_agent_name": "planner"
  }
}
```

Response: `{ "result": { "id": "task-a-uuid", "status": "ready", ... } }`

```json
{
  "tool": "task",
  "arguments": {
    "action": "create",
    "workspace_id": "ws-uuid",
    "title": "Analyze metrics and produce report",
    "depends_on_task_ids": ["task-a-uuid"],
    "created_by_agent_name": "planner"
  }
}
```

Response: `{ "result": { "id": "task-b-uuid", "status": "pending", ... } }`

Task B stays `pending` until Task A reaches `done`.

---

## 2. Claim a task with a lease

Worker agents claim ready tasks. The lease prevents two agents from grabbing the same task.

```json
{
  "tool": "task",
  "arguments": {
    "action": "claim",
    "workspace_id": "ws-uuid",
    "id": "task-a-uuid",
    "agent_name": "worker-1",
    "lease_seconds": 300
  }
}
```

---

## 3. Send heartbeats

Long-running tasks must heartbeat before the lease expires to retain ownership.

```json
{
  "tool": "task",
  "arguments": {
    "action": "heartbeat",
    "id": "task-a-uuid",
    "agent_name": "worker-1",
    "lease_seconds": 300
  }
}
```

---

## 4. Complete a task

When done, the worker marks the task complete. This unblocks dependent tasks automatically.

```json
{
  "tool": "task",
  "arguments": {
    "action": "complete",
    "id": "task-a-uuid",
    "agent_name": "worker-1"
  }
}
```

Task B now transitions from `pending` → `ready`.

---

## 5. Handoff to a specialist agent

If the worker can't finish, it hands off to a specific agent. Optionally requires acknowledgement before the task becomes ready again.

```json
{
  "tool": "task",
  "arguments": {
    "action": "handoff",
    "id": "task-b-uuid",
    "target_agent_name": "analyst",
    "require_ack": true,
    "payload": { "reason": "Needs domain expertise for anomaly detection" }
  }
}
```

The analyst's inbox receives a notification.

---

## 6. Acknowledge from the inbox

The target agent checks its inbox and acknowledges the handoff.

```json
{
  "tool": "task",
  "arguments": {
    "action": "inbox_list",
    "workspace_id": "ws-uuid",
    "agent_name": "analyst",
    "unread_only": true
  }
}
```

```json
{
  "tool": "task",
  "arguments": {
    "action": "inbox_ack",
    "inbox_id": "inbox-item-uuid",
    "agent_name": "analyst"
  }
}
```

After ack, the task transitions to `ready` and can be claimed by the analyst.

---

## 7. Append events

Any agent can append structured events to a task's event log for audit or coordination.

```json
{
  "tool": "task",
  "arguments": {
    "action": "append_event",
    "id": "task-b-uuid",
    "event_type": "analysis_note",
    "payload": { "note": "Detected 3 anomaly clusters in the 14:30–15:00 window" }
  }
}
```
