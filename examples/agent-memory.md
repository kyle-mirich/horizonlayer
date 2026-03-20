# Example: Basic Agent Memory Session

This is the core Horizon Layer workflow: an agent creates a workspace, opens a session, writes notes, searches memory, and resumes context in a later run.

---

## 1. Create a workspace

A workspace is the top-level container. Create one per project or investigation.

```json
{
  "tool": "workspace",
  "arguments": {
    "action": "create",
    "name": "Ingestion incident 2026-03-13",
    "description": "Track the queue backlog investigation"
  }
}
```

Response: `{ "ok": true, "action": "create", "result": { "id": "ws-uuid", "name": "Auth incident 2026-03-13", ... } }`

---

## 2. Start a session

A session is a named slice of time within a workspace. It scopes pages and tasks so you can resume exactly where you left off.

```json
{
  "tool": "workspace",
  "arguments": {
    "action": "start_session",
    "workspace_id": "ws-uuid",
    "title": "Initial triage",
    "summary": "First look at the ingestion backlog"
  }
}
```

Response includes `session_id`. Save both IDs.

---

## 3. Write notes

Append text blocks to a session journal page. Each call extends the page.

```json
{
  "tool": "page",
  "arguments": {
    "action": "append_text",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "content": "Queue lag spiked at 14:32 UTC. Batch ingestion is delayed by roughly 18 minutes."
  }
}
```

```json
{
  "tool": "page",
  "arguments": {
    "action": "append_text",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "content": "Root cause: one worker pool was pinned after a bad deploy. Jobs are retrying but not draining."
  }
}
```

---

## 4. Search session memory

Search finds relevant pages and rows by semantic similarity, recency, or hybrid scoring.

```json
{
  "tool": "search",
  "arguments": {
    "query": "ingestion queue lag root cause",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "mode": "hybrid",
    "limit": 5
  }
}
```

Search will surface the pages written above, ranked by relevance to the query.

---

## 5. Create a task for follow-up

```json
{
  "tool": "task",
  "arguments": {
    "action": "create",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "title": "Recycle the stuck worker pool and verify queue drain",
    "priority": 0,
    "owner_agent_name": "ops-agent"
  }
}
```

---

## 6. Resume the session in a later run

When coming back to this investigation, resume context with a single call. This returns the most recent pages, tasks, and runs from the session in one payload.

```json
{
  "tool": "workspace",
  "arguments": {
    "action": "resume_session_context",
    "workspace_id": "ws-uuid",
    "session_id": "session-uuid",
    "max_items": 10,
    "max_bytes": 32768
  }
}
```

The response bundles session metadata, recent page content, open tasks, and active runs — everything needed to pick up mid-investigation.
