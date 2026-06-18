# Agent Notes

## Required Maintenance

Keep this repo AI-first for coding agents with fresh context. If a change affects runtime behavior, scripts, schema, examples, plugin behavior, or agent workflow, update the related `AGENT.md`, `AGENTS.md`, README, and documentation before calling the work done. Every behavior change should also include focused tests or an explicit note explaining why the existing tests already cover it.

## HorizonLayer Codex Plugin

The canonical Codex plugin source lives at `plugins/horizonlayer`.

For local Codex usage, `~/plugins/horizonlayer` should point to this repo directory. Edit the repo copy, not a duplicated local copy. If the plugin path changes, rerun the installer so the symlink, marketplace entry, config, and plugin cache stay aligned.

The supported clone-to-global install path is:

```bash
bash scripts/install-codex-plugin.sh
```

The plugin MCP config should point at the cached wrapper `scripts/run-horizonlayer.mjs`, not the published npm package. Database startup belongs in `src/launcher.ts`: use `DATABASE_URL` when set, reuse local Postgres when reachable, and use Docker pgvector only as fallback.

Codex reads installed plugins from its cache, so rerun `bash scripts/install-codex-plugin.sh --skip-build` after changing plugin files. The cached MCP wrapper resolves the canonical repo through `~/plugins/horizonlayer`.
