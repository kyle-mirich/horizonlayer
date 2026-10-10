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

## Local Verification and Delivery

Run verification locally. GitHub Actions is reserved for release/deployment (CD); do not add CI workflows or run tests, coverage, lint, type checks, mutation tests, or benchmarks in Actions on pushes or pull requests.

Delivery runs only for stable `vX.Y.Z` tags through `.github/workflows/release.yml`: build and pack the tagged source, publish to npm through trusted publishing, then create a GitHub release with the tarball. Before creating or pushing a release tag, complete the local checks, align the package/lockfile/plugin versions and MCP pins, and update the dated changelog. Do not create a new version or tag unless the user requests a release. A tag must match `package.json` and point to a commit on `main`.

Before pushing changes or merging a PR, run the relevant focused tests, then `npm run verify`, `npm run test:coverage`, `npm run build`, and `git diff --check` locally. Fix failures before publishing the change and record the commands and results in the PR. A previous commit's successful run is not evidence for a changed tree.

For schema, database query, or concurrency changes, also run `npm run test:integration:postgres` against a disposable `HORIZONLAYER_INTEGRATION_DATABASE_URL`. For launcher, installer, runtime, recovery, or package-content changes, run `npm run test:smoke:local`, `npm run test:smoke:recovery`, and `npm pack --dry-run`. For retrieval or indexing changes, run the relevant real retrieval benchmark following `docs/retrieval-benchmarks.md`. Keep Docker-backed checks isolated from the user's managed runtime. Report unavailable dependencies explicitly; do not describe skipped checks as passed.

## Coding Style & Naming Conventions

Use strict TypeScript, ES modules, two-space indentation, single quotes, and semicolons, matching existing files. Use `camelCase` for functions and variables, `PascalCase` for types and React components, and descriptive action-oriented test names. Keep modules focused and place dashboard hooks near their owning feature. ESLint is authoritative; unused parameters must start with `_`.

## Testing Guidelines

Vitest is the test runner; dashboard tests use Testing Library and jsdom. Add tests beside changed behavior. Ordinary unit and coverage runs must not require Docker or external services. PostgreSQL integration tests require a disposable `HORIZONLAYER_INTEGRATION_DATABASE_URL`; never target valuable data. Preserve workspace isolation, optimistic revisions, and archive/restore behavior.

## Agent skills

The HorizonLayer plugin bundles the engineering workflow skills for this repository, including `using-horizonlayer`, Wayfinder, specification and ticket planning, Implement, TDD, research, architecture, and code review. They use the HorizonLayer MCP for Knowledge and Issues; see `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, and `docs/agents/domain.md` before publishing workflow state.

## Commit & Pull Request Guidelines

Follow the repository’s concise, imperative commit style with prefixes such as `fix:`, `test:`, `refactor:`, `docs:`, or `release:`. Keep PRs narrowly scoped, link the relevant issue, explain behavioral and configuration changes, and list verification performed. Include screenshots for visible dashboard changes. Update user documentation when commands, configuration, data locations, or recovery behavior changes. Report security issues through `SECURITY.md`, not a public issue.
