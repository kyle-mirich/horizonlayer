# Example: Canonical MCP Agent Loop

This example shows the core Horizon Layer story as an MCP server for agents: persist context, coordinate work, checkpoint execution, search memory, and resume later without reconstructing state from scratch.

---

## 1. Create a workspace and start a session

The workspace is the durable container. The session is the active slice of work the agent can return to later.

```json
{
  "tool": "session",
  "arguments": {
    "action": "start",
    "workspace_name": "Ingestion backlog incident",
    "title": "Initial triage",
    "summary": "Collect evidence, create follow-up tasks, and checkpoint the recovery run"
  }
}
```

---

## 2. Store free-text memory

The agent appends notes to a session page as it learns new facts.

```json
{
  "tool": "memory",
  "arguments": {
    "action": "append",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "title": "Incident journal",
    "content": "Queue lag spiked after the last deploy. One ingestion worker pool appears stuck and retries are not draining the backlog."
  }
}
```

```json
{
  "tool": "memory",
  "arguments": {
    "action": "append",
    "page_id": "page-uuid",
    "session_id": "session-uuid",
    "content": "Confirmed the issue is isolated to ingestion-worker-b. Restart looks safe if queue depth falls immediately after recovery."
  }
}
```

---

## 3. Create durable follow-up work

The agent records the next operational step as a task so ownership and progress survive process restarts.

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "task_create",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "title": "Restart ingestion-worker-b and verify queue drain",
    "priority": 0,
    "created_by_agent_name": "planner",
    "owner_agent_name": "ops-agent"
  }
}
```

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "task_claim",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "task_id": "task-uuid",
    "agent_name": "ops-agent",
    "lease_seconds": 300
  }
}
```

---

## 4. Checkpoint the execution attempt

The task is the durable unit of work. The run captures the concrete execution attempt and stores resumable checkpoints.

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "run_start",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "task_id": "task-uuid",
    "agent_name": "ops-agent"
  }
}
```

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "run_checkpoint",
    "run_id": "run-uuid",
    "agent_name": "ops-agent",
    "summary": "Prepared restart plan and confirmed the worker is isolated.",
    "state": {
      "next_step": "restart worker and watch queue depth",
      "worker": "ingestion-worker-b"
    }
  }
}
```

---

## 5. Search the agent's prior context

The same server can search saved notes without external glue.

```json
{
  "tool": "memory",
  "arguments": {
    "action": "search",
    "query": "stuck ingestion worker backlog restart plan",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "limit": 3
  }
}
```

The expected top hits are the incident notes above and any related saved memory in the workspace.

---

## 6. Complete the work and resume later

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "task_complete",
    "task_id": "task-uuid",
    "agent_name": "ops-agent",
    "payload": {
      "outcome": "restart completed and queue depth began to fall"
    }
  }
}
```

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "run_complete",
    "run_id": "run-uuid",
    "agent_name": "ops-agent",
    "result": {
      "status": "done",
      "summary": "Recovered the stuck worker and confirmed queue drain."
    }
  }
}
```

```json
{
  "tool": "session",
  "arguments": {
    "action": "resume",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "max_items": 10
  }
}
```

That final call is the key MCP value proposition: a later agent run can recover the recent notes, open tasks, and run state from one durable system instead of rebuilding context from logs and chat history.
