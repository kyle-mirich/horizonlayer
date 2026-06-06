# Example: Multi-Agent Task Coordination

This example shows how agents coordinate durable work with the `coordination` tool. The public surface covers the common loop: create, claim, heartbeat, complete, fail, hand off, and checkpoint runs.

---

## Task state machine

```text
ready -> claimed -> done
                 -> failed
                 -> handoff_pending -> claimed
```

---

## 1. Create a task

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "task_create",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "title": "Collect system metrics",
    "priority": 0,
    "created_by_agent_name": "planner",
    "owner_agent_name": "worker-1"
  }
}
```

Response: `{ "result": { "id": "task-uuid", "status": "ready", ... } }`

---

## 2. Claim the task with a lease

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "task_claim",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "task_id": "task-uuid",
    "agent_name": "worker-1",
    "lease_seconds": 300
  }
}
```

---

## 3. Heartbeat during long work

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "task_heartbeat",
    "task_id": "task-uuid",
    "agent_name": "worker-1",
    "lease_seconds": 300
  }
}
```

---

## 4. Checkpoint an execution run

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "run_start",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "task_id": "task-uuid",
    "agent_name": "worker-1",
    "title": "Metrics collection run"
  }
}
```

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "run_checkpoint",
    "run_id": "run-uuid",
    "agent_name": "worker-1",
    "summary": "Collected host metrics and started log review.",
    "state": {
      "phase": "log_review"
    }
  }
}
```

---

## 5. Complete or hand off

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "task_complete",
    "task_id": "task-uuid",
    "agent_name": "worker-1",
    "payload": {
      "summary": "Metrics collected and attached to session notes."
    }
  }
}
```

If the work needs a different agent:

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "task_handoff",
    "task_id": "task-uuid",
    "agent_name": "worker-1",
    "target_agent_name": "analyst",
    "payload": {
      "reason": "Needs deeper anomaly analysis"
    }
  }
}
```
