DATABASE_URL ?= postgres://postgres:postgres@localhost:5432/horizon_layer

.PHONY: help install dev build typecheck lint test verify smoke-live smoke-local

help:
	@printf "%-14s %s\n" "install" "Install dependencies with npm ci"
	@printf "%-14s %s\n" "dev" "Run the stdio server against the local database"
	@printf "%-14s %s\n" "build" "Compile TypeScript"
	@printf "%-14s %s\n" "test" "Run the unit test suite"
	@printf "%-14s %s\n" "verify" "Run lint, typecheck, and tests"
	@printf "%-14s %s\n" "smoke-live" "Run the stdio MCP smoke test against the configured database"
	@printf "%-14s %s\n" "smoke-local" "Run the launcher-backed local smoke test"

install:
	npm ci

dev:
	DATABASE_URL=$(DATABASE_URL) APP_NAME="Horizon Layer" npm run dev

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
	DATABASE_URL=$(DATABASE_URL) npm run test:smoke:live

smoke-local:
	npm run test:smoke:local
