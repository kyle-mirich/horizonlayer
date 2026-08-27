# Repository Guidelines

## Project Structure & Module Organization

HorizonLayer is a Node.js 22+, TypeScript, local-first MCP server. Server and runtime code lives in `src/`; MCP tool contracts are under `src/tools/`, PostgreSQL access under `src/db/`, and optional semantic search under `src/search/`. The React dashboard lives in `dashboard/src/`, with static assets in `dashboard/public/`. Tests are co-located with implementation as `*.test.ts` or `*.test.tsx`; PostgreSQL suites use `*.integration.test.ts`. Canonical database setup is defined in `schema.sql`. User and architecture guidance belongs in `README.md`, `CONTRIBUTING.md`, and `docs/`.

## Build, Test, and Development Commands

- `npm ci`: install the exact lockfile dependencies.
- `npm run dev`: run the MCP launcher from TypeScript.
- `npm run dev:dashboard`: run the local dashboard through the launcher.
- `npm run verify`: run ESLint, server/dashboard type checks, and unit tests.
- `npm run test:coverage`: enforce the configured 90% branch, function, line, and statement thresholds.
- `npm run build`: compile the server and production dashboard into `dist/`.
- `npm run test:smoke:local`: exercise the Docker-backed local runtime.
- `npm run test:smoke:recovery`: pack the CLI and prove isolated backup/recovery.

Run focused Vitest files during development, for example `npx vitest run src/tools/core.test.ts`, then run `npm run verify`, coverage, and build before opening a PR.

## Coding Style & Naming Conventions

Use strict TypeScript, ES modules, two-space indentation, single quotes, and semicolons, matching existing files. Use `camelCase` for functions and variables, `PascalCase` for types and React components, and descriptive action-oriented test names. Keep modules focused and place dashboard hooks near their owning feature. ESLint is authoritative; unused parameters must start with `_`.

## Testing Guidelines

Vitest is the test runner; dashboard tests use Testing Library and jsdom. Add tests beside changed behavior. Ordinary unit and coverage runs must not require Docker or external services. PostgreSQL integration tests require a disposable `HORIZONLAYER_INTEGRATION_DATABASE_URL`; never target valuable data. Preserve workspace isolation, optimistic revisions, and archive/restore behavior.

## Agent skills

The HorizonLayer plugin bundles the engineering workflow skills for this repository, including `using-horizonlayer`, Wayfinder, specification and ticket planning, Implement, TDD, research, architecture, and code review. They use the HorizonLayer MCP for Knowledge and Issues; see `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, and `docs/agents/domain.md` before publishing workflow state.

## Commit & Pull Request Guidelines

Follow the repository’s concise, imperative commit style with prefixes such as `fix:`, `test:`, `refactor:`, `docs:`, or `release:`. Keep PRs narrowly scoped, link the relevant issue, explain behavioral and configuration changes, and list verification performed. Include screenshots for visible dashboard changes. Update user documentation when commands, configuration, data locations, or recovery behavior changes. Report security issues through `SECURITY.md`, not a public issue.
