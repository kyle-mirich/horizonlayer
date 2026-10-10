## Summary

- What changed?
- Why was the change needed?

## Validation

Run these checks locally before pushing or merging, following `AGENTS.md`. Include their results and any unavailable dependencies; GitHub Actions does not run CI for this repository.

- [ ] `npm run verify`
- [ ] `npm run test:coverage`
- [ ] `npm run build`
- [ ] `npm run test:integration:postgres` (if PostgreSQL behavior changed)
- [ ] `npm run test:smoke:local` (if startup, transport, schema, or cross-tool behavior changed)
- [ ] `npm run test:smoke:recovery` and `npm pack --dry-run` (if launcher, installer, runtime, recovery, or package contents changed)
- [ ] Real retrieval benchmark (if retrieval or indexing changed)
- [ ] `git diff --check`

## Notes

- Docs updated if the public surface changed
- New tests added for new tool actions or bug fixes
