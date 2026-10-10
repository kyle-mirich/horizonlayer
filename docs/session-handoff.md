# A decision that survives the session

This walkthrough records real calls through the public `knowledge` and `issues` MCP tools. A scripted client saves a decision and linked task, disconnects, and then a second client starts a fresh server process. The second client discovers the workspace by name, searches for the decision, reads its persisted rationale, verifies the task link, and claims the ready task using its current revision.

![Recorded session handoff](https://raw.githubusercontent.com/kyle-mirich/horizonlayer/main/docs/assets/session-handoff.gif)

The animation presents the captured stdout with reading pauses added. It is a scripted protocol demonstration, not a recording of an LLM, a speed measurement, or an evaluation of model performance. Record search is PostgreSQL-native; this demonstration does not use Qdrant or embeddings. The transcript below is also available as [plain text](https://raw.githubusercontent.com/kyle-mirich/horizonlayer/main/docs/assets/session-handoff.txt).

## Recorded output

```text
HorizonLayer / recorded MCP session handoff
Scripted clients | PostgreSQL 17 | no LLM or embeddings

SESSION A / capture a decision
Saved decision: Use PostgreSQL as the source of truth
Linked task: DEMO-1 / Document the search rebuild procedure
Session A disconnected; its MCP process stopped.

SESSION B / retrieve context in a fresh MCP process
Found decision: Use PostgreSQL as the source of truth
Read rationale: Keep canonical records in PostgreSQL. Rebuild the search index from those records.
Claimed DEMO-1: in_progress / session-b
Ready queue after claim: 0 tasks

PASS / decision, rationale, and task link survived the process restart.
```

## Reproduce from a checkout

Requirements: Node.js 22+, npm, Bash, and a running Docker Engine or Docker Desktop. On Windows, run the script in WSL with Docker integration enabled. The first run may download `postgres:17`.

```bash
npm ci
npm run demo:handoff
```

The script compiles the server and creates a uniquely named PostgreSQL container on a dynamically assigned loopback port. Its database lives on a temporary filesystem. It overrides any ambient `DATABASE_URL`, forces both MCP modules on, and disables semantic search. An exit trap removes only the demo container and its anonymous volumes, including on normal errors or interruption. It does not run `setup` or touch the saved managed runtime.

The demo exits nonzero if the persisted decision, rationale, link, claim, or ready queue differs from the expected result. See [the client](https://github.com/kyle-mirich/horizonlayer/blob/main/src/testing/sessionHandoff.ts) and [the isolated runner](https://github.com/kyle-mirich/horizonlayer/blob/main/scripts/demo-handoff.sh).

To refresh the recording after a behavior change:

```bash
npm run --silent demo:handoff > docs/assets/session-handoff.txt
python3 scripts/render-handoff.py
```

The optional animation renderer requires Python 3 and Pillow (`python3 -m pip install Pillow`). Review the text and animation together before committing them. The live demo itself needs no Python dependencies.
