# src/testing

This folder holds runtime-oriented verification code rather than unit tests.

## Files

- `liveSmoke.ts`: a live smoke test entrypoint that exercises the running stack against a real environment.

## When To Use It

Use this folder when unit tests are not enough and you need a lightweight real-system check, especially for startup, tool wiring, or database-backed flows that are easier to validate end to end.

## Relationship To Other Tests

- `src/db/queries/*.test.ts` focuses on the data layer.
- `src/tools/*.test.ts` focuses on MCP schema and tool behavior.
- `src/testing/liveSmoke.ts` is the place for "does the assembled system actually work against a live backend?"
