# Contributing to HorizonLayer

Thanks for helping improve HorizonLayer. The project is a local-first PostgreSQL MCP server; changes should preserve its workspace isolation, canonical PostgreSQL model, optimistic revisions, archive/restore lifecycle, and local runtime behavior.

## Local setup

Use Node.js 22 or later. Docker is required for launcher-backed local smoke tests.

```bash
npm ci
npm run verify
npm run build
npm run test:smoke:local
```

`npm run verify` runs linting, type checks, and unit tests. Run the focused test suite that covers a change, then run the full verification gate before opening a pull request. Changes to launcher, installer, runtime configuration, or package contents also need a clean-environment and packed-artifact check.

## Pull requests

- Keep changes narrowly scoped and include tests for changed behavior.
- Update user-facing documentation when commands, configuration, local data locations, or recovery behavior changes.
- Do not add hosted infrastructure, remote deployment claims, migrations, or compatibility layers without an approved product decision.
- Preserve user data: public lifecycle operations are archive and restore, not broad destructive deletion.
- Describe verification performed and any Docker, platform, or external-service assumptions in the pull request.

For a bug or feature discussion, use the [issue tracker](https://github.com/kyle-mirich/horizonlayer/issues). For a security-sensitive issue, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
