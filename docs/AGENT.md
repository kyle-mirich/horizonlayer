# docs

`docs/` contains the human-readable reference material for the repository. These files explain the system from different angles; they are not the source of truth, but they are the fastest way to orient yourself before diving into code.

## Files

- `architecture.md`: high-level runtime shape, key modules, and deployment model.
- `database.md`: schema-oriented guide to migrations, tables, and data-model layers.
- `api.md`: tool surface, shared response envelope, and request parameter conventions.
- `flows.md`: the main runtime and product flows, from startup to search to task coordination.
- `deployment.md`: local and AWS deployment paths, including the Terraform-backed production baseline.

## How To Use This Folder

- Start with `architecture.md` if you are new to the repo.
- Read `database.md` before editing migrations or query files.
- Read `api.md` before changing MCP tool schemas or examples.
- Read `flows.md` if you are trying to understand user-facing behavior rather than implementation details.
- Read `deployment.md` before touching `Dockerfile`, `docker-compose.yml`, or `infra/terraform/`.

## Important Caveat

Some docs describe capabilities in broader product terms than the current code tree exposes. When docs and code disagree, treat `src/` plus `migrations/` as authoritative and update the prose later.
