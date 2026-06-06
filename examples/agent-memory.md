# Example: Basic Agent Memory Session

This is the core Horizon Layer workflow: an agent starts a session, writes notes, searches memory, and resumes context in a later run.

---

## 1. Start a session

A session is the durable slice of work the agent can resume later.

```json
{
  "tool": "session",
  "arguments": {
    "action": "start",
    "workspace_name": "Ingestion incident 2026-03-13",
    "title": "Initial triage",
    "summary": "Track the queue backlog investigation"
  }
}
```

Response includes `workspace.id` and `session.id`. Save both IDs.

---

## 2. Write notes

Append concise memory entries to the session.

```json
{
  "tool": "memory",
  "arguments": {
    "action": "append",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "content": "Queue lag spiked at 14:32 UTC. Batch ingestion is delayed by roughly 18 minutes."
  }
}
```

```json
{
  "tool": "memory",
  "arguments": {
    "action": "append",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "content": "Root cause: one worker pool was pinned after a bad deploy. Jobs are retrying but not draining."
  }
}
```

---

## 3. Search session memory

Search finds relevant saved memory.

```json
{
  "tool": "memory",
  "arguments": {
    "action": "search",
    "query": "ingestion queue lag root cause",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "limit": 5
  }
}
```

Search will surface the pages written above, ranked by relevance to the query.

---

## 4. Create a task for follow-up

```json
{
  "tool": "coordination",
  "arguments": {
    "action": "task_create",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "title": "Recycle the stuck worker pool and verify queue drain",
    "priority": 0,
    "owner_agent_name": "ops-agent"
  }
}
```

---

## 5. Resume the session in a later run

When coming back to this investigation, resume context with a single call. This returns the most recent pages, tasks, and runs from the session in one payload.

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

The response bundles session metadata, recent page content, open tasks, and active runs — everything needed to pick up mid-investigation.
