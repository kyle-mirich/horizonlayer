# Deployment

Horizon Layer defaults to stdio for local MCP clients and can run FastMCP's HTTP Stream transport for explicitly hosted deployments.

The practical deployment shapes in this repo are:

1. Local stdio via the launcher in `dist/launcher.js`
2. Local stdio during development via `tsx src/index.ts`
3. Local PostgreSQL via Docker Compose for the database only
4. HTTP Stream on ECS via `infra/terraform/`

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

## HTTP Stream transport

Use HTTP Stream only when the server is protected by trusted network controls:

```bash
SERVER_TRANSPORT=httpStream \
HOST=0.0.0.0 \
PORT=3000 \
MCP_ENDPOINT=/mcp \
HEALTH_CHECK_PATH=/healthz \
node dist/index.js
```

The MCP endpoint is `http://<host>:3000/mcp`. The health endpoint is `GET /healthz`.

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

## Terraform ECS deployment

`infra/terraform/` runs the app with `SERVER_TRANSPORT=httpStream`, exposes `/mcp` through the ALB, and uses `var.health_check_path` for the FastMCP health endpoint. Keep `allowed_ingress_cidrs` restricted to trusted client networks because the local-first access model currently maps MCP sessions to system access.
