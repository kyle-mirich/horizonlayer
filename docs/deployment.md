# Deployment

Horizon Layer is a stdio-only MCP server.

The practical deployment shapes in this repo are:

1. Local stdio via the launcher in `dist/launcher.js`
2. Local stdio during development via `tsx src/index.ts`
3. Local PostgreSQL via Docker Compose for the database only

## Local stdio launcher

Use this when an MCP client such as Codex or Claude will launch the server:

```bash
npm ci
npm run build
node dist/launcher.js
```

If `DATABASE_URL` is unset, the launcher will try to use local Postgres and then fall back to a managed Docker-backed PostgreSQL container.

## Local development

Use this when changing the server itself:

```bash
make db-up
make dev
```

This runs the server over stdio against your local database.

## Local database only

The repo still includes `docker-compose.yml`, but it now exists only to run PostgreSQL:

```bash
docker compose up -d db
```

## MCP client setup

Codex:

```bash
codex mcp add horizonlayer -- npx -y --package=horizonlayer horizonlayer
```

Claude Code:

```bash
claude mcp add -s user horizonlayer -- npx -y --package=horizonlayer horizonlayer
```
