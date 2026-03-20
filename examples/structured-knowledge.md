# Example: Structured Knowledge with Databases, Rows, and Hybrid Search

This example shows how to use `database`, `row`, and `search` together to build a structured knowledge base within a workspace — and then retrieve it with hybrid semantic + keyword search.

---

## 1. Create a typed database

Databases have named, typed properties (columns). Common property types include `title`, `text`, `number`, `date`, `checkbox`, `select`, `multi_select`, `url`, `email`, `phone`, `relation`, and `files`.

```json
{
  "tool": "database",
  "arguments": {
    "action": "create",
    "workspace_id": "ws-uuid",
    "name": "Reliability findings",
    "description": "Structured reliability findings from the audit",
    "properties": [
      { "name": "title", "type": "title" },
      { "name": "severity", "type": "number" },
      { "name": "component", "type": "text" },
      { "name": "resolved", "type": "checkbox" },
      { "name": "details", "type": "text" }
    ]
  }
}
```

Response: `{ "result": { "id": "db-uuid", "name": "Reliability findings", ... } }`

---

## 2. Insert rows

Each row is a record with typed values keyed by property name.

```json
{
  "tool": "row",
  "arguments": {
    "action": "create",
    "database_id": "db-uuid",
    "values": {
      "title": "Stuck ingestion worker",
      "severity": 9,
      "component": "ingestion-service",
      "resolved": false,
      "details": "One worker pool stopped draining queued jobs after a deploy. Retries kept the backlog growing."
    },
    "tags": ["ingestion", "critical"],
    "importance": 0.9
  }
}
```

---

## 3. Bulk insert

Insert up to 100 rows in a single call.

```json
{
  "tool": "row",
  "arguments": {
    "action": "bulk_create",
    "database_id": "db-uuid",
    "rows": [
      {
        "values": { "title": "Missing queue depth alert", "severity": 6, "component": "ops-monitoring", "resolved": false, "details": "Backlog alerting only triggers on error rate. Queue depth can climb for 20 minutes before paging." },
        "tags": ["monitoring", "ops"]
      },
      {
        "values": { "title": "Slow reindex path", "severity": 8, "component": "search-api", "resolved": true, "details": "Fixed in v1.4.2. Batch writes now run with bounded concurrency." },
        "tags": ["search", "resolved"]
      }
    ]
  }
}
```

---

## 4. Query rows with typed filters

Filters support `eq`, `neq`, `gt`, `lt`, `contains`, `is_empty`.

```json
{
  "tool": "row",
  "arguments": {
    "action": "query",
    "database_id": "db-uuid",
    "filters": [
      { "property": "severity", "operator": "gt", "value": 7 },
      { "property": "resolved", "operator": "eq", "value": false }
    ],
    "sort_by": "severity",
    "limit": 20
  }
}
```

---

## 5. Hybrid search across pages and rows

The `search` tool searches both page content and database rows simultaneously, ranked by semantic similarity + recency.

```json
{
  "tool": "search",
  "arguments": {
    "query": "stuck ingestion worker",
    "workspace_id": "ws-uuid",
    "mode": "hybrid",
    "limit": 10
  }
}
```

This surfaces both the row for "Stuck ingestion worker" and any pages where the same topic was discussed.

---

## 6. Narrow search to rows in a specific database

```json
{
  "tool": "search",
  "arguments": {
    "query": "unresolved critical ingestion issues",
    "workspace_id": "ws-uuid",
    "database_id": "db-uuid",
    "mode": "similarity_importance",
    "min_importance": 0.7,
    "limit": 5
  }
}
```

---

## 7. Link a row to a page

Use `link` to connect structured rows to free-text page content for cross-reference.

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

Then list all links from that row:

```json
{
  "tool": "link",
  "arguments": {
    "action": "list",
    "item_type": "row",
    "item_id": "row-uuid",
    "direction": "both"
  }
}
```
