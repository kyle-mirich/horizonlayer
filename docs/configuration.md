# Configuration

Horizon Layer reads configuration from one file source plus environment overrides.

## Precedence

1. `config.yaml` if present in the repo root
2. Otherwise `config.example.yaml`
3. Environment variables override whichever file was loaded

This behavior comes from `src/config.ts`. The file loader does not merge `config.yaml` with `config.example.yaml`; it picks the first one that exists, then overlays environment variables on top.

## Common local setups

### MCP client launcher

Use this when validating the public stdio flow:

```bash
make build
node dist/launcher.js
```

- If `DATABASE_URL` is unset, the launcher manages a local Docker Postgres container for you.
- Launcher-specific overrides use the `HORIZONLAYER_*` variables documented in `README.md`.

### Local stdio development

Use this when changing the server:

```bash
make db-up
make dev
```

- `make dev` uses `DATABASE_URL=postgres://postgres:postgres@localhost:5432/horizon_layer` by default.
- `make dev-stdio` is the same command surface with an explicit name.

## Important env groups

### Database

- `DATABASE_URL`
- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `DB_SSL_MODE`
- `DB_SSL_REJECT_UNAUTHORIZED`

### Server

- `APP_NAME`
- `APP_VERSION`

### Embeddings and runtime cache

- `EMBEDDING_MODEL`
- `EMBEDDING_DIMENSIONS`
- `XDG_CACHE_HOME`
- `HF_HOME`

## Practical guidance

- For local repo work, prefer `make db-up` plus `make dev` so database and server failures stay separate.
- For MCP client installation tests, prefer `node dist/launcher.js`.
- When changing config behavior, update both this file and the examples in `README.md` or `.env.docker.example` so the published surface stays synchronized.
