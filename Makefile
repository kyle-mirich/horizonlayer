DATABASE_URL ?= postgres://postgres:postgres@localhost:5432/horizon_layer

.PHONY: help install db-up db-down db-reset dev dev-stdio build typecheck lint test verify smoke-live smoke-local codex-mcp claude-mcp

help:
	@printf "%-14s %s\n" "install" "Install dependencies with npm ci"
	@printf "%-14s %s\n" "db-up" "Start local PostgreSQL with Docker Compose"
	@printf "%-14s %s\n" "db-down" "Stop local PostgreSQL"
	@printf "%-14s %s\n" "db-reset" "Remove local PostgreSQL volume"
	@printf "%-14s %s\n" "dev" "Run the stdio server against the local database"
	@printf "%-14s %s\n" "build" "Compile TypeScript"
	@printf "%-14s %s\n" "test" "Run the unit test suite"
	@printf "%-14s %s\n" "verify" "Run lint, typecheck, and tests"
	@printf "%-14s %s\n" "smoke-live" "Run the live smoke test against a running server"
	@printf "%-14s %s\n" "smoke-local" "Run the launcher-backed local smoke test"

install:
	npm ci

db-up:
	docker compose up -d db

db-down:
	docker compose stop db

db-reset:
	docker compose down -v

dev:
	DATABASE_URL=$(DATABASE_URL) APP_NAME="Horizon Layer" npm run dev:stdio

dev-stdio:
	DATABASE_URL=$(DATABASE_URL) APP_NAME="Horizon Layer" npm run dev:stdio

build:
	npm run build

typecheck:
	npm run typecheck

lint:
	npm run lint

test:
	npm test

verify:
	npm run verify

smoke-live:
	npm run test:smoke:live

smoke-local:
	npm run test:smoke:local

codex-mcp:
	@echo codex mcp add horizonlayer -- npx -y --package=horizonlayer horizonlayer

claude-mcp:
	@echo claude mcp add -s user horizonlayer -- npx -y --package=horizonlayer horizonlayer
