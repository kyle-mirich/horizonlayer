# HorizonLayer flows

## Docker-managed local startup

1. Run `npx -y horizonlayer@2.0.0 setup`.
2. The launcher creates or reuses local runtime settings, starts PostgreSQL and Qdrant through Docker, initializes the canonical schema, and verifies the local embedding model and vector collection.
3. Run `npx -y horizonlayer@2.0.0 doctor` to check the saved configuration, Docker, PostgreSQL, and Qdrant.
4. Run `npx -y horizonlayer@2.0.0 install codex` or `install claude`, then restart that agent client. The Claude path stages a persistent local marketplace and uses Claude Code's native user-scope plugin installation flow.
5. To deliberately erase only this managed local runtime, first run `doctor`, then confirm with `npx -y horizonlayer@2.0.0 reset --yes`. It removes that runtime's Compose services, volumes, and saved configuration; it does not manage an external PostgreSQL instance.

The user-facing commands target the 2.0.0 release. See the [README quickstart](../README.md#local-quickstart) for the version-pinning note and full recovery guidance.

## Typed knowledge workflow

1. Use `workspace` `list` before creating a scope, then create a workspace only when no existing scope fits.
2. Use `database` `create` to define a stable typed collection and its properties.
3. Use `row` `create` with values keyed by exact property names; include the title property.
4. Use `row` `query` for deterministic typed filtering, or `search` with `mode: "records"` for natural-language retrieval.
5. Before changing an existing object, read it, use its latest revision, and handle a conflict by rereading before retrying.

This workflow stays local to the PostgreSQL instance selected by the launcher or `DATABASE_URL`. The dashboard is a loopback local interface; it is not a remote collaboration or hosting service.
