# migrations

`migrations/` is the schema history for Horizon Layer. Files run in lexical order at process startup through `src/db/migrate.ts`, and each applied filename is recorded in the `_migrations` table.

## Migration Sequence

- `001_extensions.sql`: enables foundational Postgres extensions, including `pgvector`.
- `002_schema.sql`: creates the first-pass content graph schema and search-related indexes.
- `003_workspace_sessions.sql`: adds workspace/session lifecycle and expiry support.
- `004_auth_and_multitenancy.sql`: adds users, organizations, memberships, OAuth, and multitenant ownership fields.
- `005_enterprise_identity.sql`: extends identity support for enterprise-style auth flows.
- `006_coordination_primitives.sql`: adds durable agent coordination tables such as tasks, dependencies, events, and inbox state.
- `007_schema_hardening.sql`: tightens constraints, uniqueness, and integrity assumptions after the initial schema shape existed.
- `008_billing.sql`: creates billing-related tables for subscription and webhook tracking.
- `009_agent_runs.sql`: adds durable run and checkpoint tracking.
- `010_sessions.sql`: expands session support and browser-session-related metadata.

## Reading Advice

- Read these in order. Later migrations assume the earlier data model.
- If query code looks surprising, the explanation is usually here.
- This folder is the source of truth for column names, foreign keys, indexes, and enum-like database constraints.

## Practical Rules

- Do not edit old migration files casually; add new ones instead.
- Keep the query layer aligned with the schema here.
- If a feature spans multiple domains, check whether it already has schema support before adding TypeScript abstractions.
