# Example: Structured Knowledge with Databases, Rows, and Hybrid Search

This example shows how to use `database`, `row`, and `search` together to build a structured knowledge base within a workspace — and then retrieve it with hybrid semantic + keyword search.

---

## 1. Create a typed database

Databases have named, typed properties (columns). Common property types include `title`, `text`, `number`, `date`, `checkbox`, `select`, and `multi_select`.

```json
{
  "tool": "database",
  "arguments": {
    "action": "create",
    "workspace_id": "ws-uuid",
    "name": "Vulnerability findings",
    "description": "Structured security findings from the audit",
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

Response: `{ "result": { "id": "db-uuid", "name": "Vulnerability findings", ... } }`

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
      "title": "JWKS key rotation failure",
      "severity": 9,
      "component": "auth-service",
      "resolved": false,
      "details": "RSA key in JWKS endpoint expired silently. OAuth login returns 500."
    },
    "tags": ["auth", "critical"],
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
        "values": { "title": "Unrotated session cookies", "severity": 6, "component": "session-service", "resolved": false, "details": "Session cookies use 90-day TTL. Compliance policy requires 30-day max." },
        "tags": ["session", "compliance"]
      },
      {
        "values": { "title": "SQL injection in search endpoint", "severity": 8, "component": "search-api", "resolved": true, "details": "Fixed in v1.4.2. Parameterized queries applied." },
        "tags": ["sql", "resolved"]
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
    "query": "authentication key rotation failure",
    "workspace_id": "ws-uuid",
    "mode": "hybrid",
    "limit": 10
  }
}
```

This surfaces both the row for "JWKS key rotation failure" and any pages where the same topic was discussed.

---

## 6. Narrow search to rows in a specific database

```json
{
  "tool": "search",
  "arguments": {
    "query": "unresolved critical auth issues",
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
