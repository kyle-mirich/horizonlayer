---
name: databases
description: Manage HorizonLayer typed databases and records through MCP. Trigger when an agent needs shared structured data, a stable property schema, filtered or sorted row queries, record updates, schema evolution, or a decision between storing information as a page versus typed rows.
---

# HorizonLayer Databases

Use databases for repeated entities that benefit from validation, filtering, and exact field names. Use a page when the information is primarily narrative.

## Inspect before changing

1. Resolve the workspace with `workspace` `list`.
2. Call `database` `list`, then `database` `get` for the closest existing database.
3. Reuse its schema when it represents the same entity type. Do not create a new database per task or agent.
4. Keep database, property, and row revisions separately; each mutation needs the revision of the entity it changes.

## Design stable schemas

- Every database has exactly one required `title` property. HorizonLayer adds `Title` when creation omits one.
- Choose property types by durable meaning: `text`, `number`, `date`, `checkbox`, `url`, `select`, or `multi_select`.
- Define select choices when the allowed vocabulary is known. Choice matching is exact and case-sensitive.
- Prefer a small stable schema. Add a property only when multiple records will use it.
- Rename properties deliberately: row keys, filters, and sorting always use the exact active property name, not a property ID.
- Archive obsolete properties; restore them when the same field returns.

## Work with rows

- On create, include a non-null title value. Value keys must exactly match active property names.
- Encode values by type: finite JSON number, boolean, ISO-8601 date string, one select string, or a string array for multi-select.
- Use `null` to clear a non-title value. Row updates patch only supplied keys.
- Read a row immediately before updating it when another agent may have changed it.
- On `CONFLICT`, get the latest row, merge field-level intent, and retry once.

## Query precisely

- Use `row` `query` for deterministic filtering and sorting; use `search` `records` when the user describes a record in natural language.
- All query filters are combined with AND.
- `contains` is case-insensitive substring matching for textual fields and exact membership for multi-select.
- Use `gt` and `lt` only for number or date properties. `is_empty` takes no value.
- Do not sort multi-select properties.
- Follow pagination until the needed records are found; avoid loading the whole database without a reason.

Archive rows instead of deleting them. Use `include_archived` only for restoration, audits, or explicit historical requests.
