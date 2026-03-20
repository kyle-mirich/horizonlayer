DATABASE_URL ?= postgres://postgres:postgres@localhost:5432/horizon_layer
APP_BASE_URL ?= http://127.0.0.1:3000
HOST ?= 127.0.0.1
PORT ?= 3000

.PHONY: install db-up db-down db-reset dev dev-http dev-stdio build typecheck lint test verify smoke-live smoke-local docker-up docker-down codex-mcp claude-mcp

install:
	npm ci

db-up:
	docker compose up -d db

db-down:
	docker compose stop db

db-reset:
	docker compose down -v

dev:
	DATABASE_URL=$(DATABASE_URL) APP_NAME="Horizon Layer" APP_BASE_URL=$(APP_BASE_URL) HOST=$(HOST) PORT=$(PORT) npm run dev:http

dev-http:
	DATABASE_URL=$(DATABASE_URL) APP_NAME="Horizon Layer" APP_BASE_URL=$(APP_BASE_URL) HOST=$(HOST) PORT=$(PORT) npm run dev:http

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

docker-up:
	docker compose up --build

docker-down:
	docker compose down

codex-mcp:
	@echo codex mcp add horizondb -- node $(CURDIR)/dist/launcher.js

claude-mcp:
	@echo claude mcp add -s user horizondb -- node $(CURDIR)/dist/launcher.js
