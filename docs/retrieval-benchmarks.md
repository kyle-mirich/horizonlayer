# Retrieval and recovery evidence

HorizonLayer's benchmark uses the actual PostgreSQL lexical/trigram search and the
actual PostgreSQL → local ONNX embeddings → Qdrant semantic path. It does not use a
simulated vector store, an LLM judge, paid APIs, or production customer data. The
fixture is intentionally small and synthetic. Its relevance grades were authored
by an AI coding assistant, not independently reviewed by humans. Results establish
behavior on these scenarios, not general retrieval accuracy or hostile multi-tenant
security. Workspaces remain the documented local organizational scope.

## Reproduce retrieval

Use Node.js 22+, install the exact dependencies, and start disposable PostgreSQL 17
and Qdrant 1.18.2 instances. These commands use separate Docker containers that you
own; they do not call the HorizonLayer managed launcher:

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
docker run --rm --name hl-benchmark-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=horizonlayer_benchmark -p 127.0.0.1:55438:5432 -d postgres:17
docker run --rm --name hl-benchmark-qdrant -e QDRANT__TELEMETRY_DISABLED=true \
  -p 127.0.0.1:6338:6333 -d qdrant/qdrant:v1.18.2-unprivileged
# Wait for both services to be ready before running the benchmark.
HORIZONLAYER_BENCHMARK_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55438/horizonlayer_benchmark' \
HORIZONLAYER_BENCHMARK_QDRANT_URL='http://127.0.0.1:6338' \
EMBEDDING_CACHE_DIR="$PWD/.benchmark-model-cache" \
  npm run benchmark:retrieval -- --backend both --output benchmarks/results/retrieval.json
# Remove only the two disposable containers created above.
docker stop hl-benchmark-pg hl-benchmark-qdrant
```

Never point the benchmark at valuable data. It creates and drops one randomly
named `hl_bench_*` PostgreSQL schema and Qdrant collection per invocation. It applies
the canonical schema, which may install `pgcrypto` and `pg_trgm` extensions in the
disposable database. It refuses to fall back to `DATABASE_URL` or a saved managed
runtime. URL connection options are overridden to select the isolated schema and
checked before fixture writes. Credentials and connection strings are not included
in result JSON. Cleanup failures produce a failing result; interrupted processes
may require removing their synthetic schema/collection from the disposable service.

Options:

- `--backend lexical`, `semantic`, or `both` (default: both)
- `--output PATH` (default: `benchmarks/results/retrieval.json`)
- `--repeats N`, 1–20 warm runs per query (default: 3)
- `--sizes 1000,10000` (default), or `--sizes none` for the small quality/lifecycle run

This benchmark process defaults to a 300-second PostgreSQL statement budget and
a 30-second Qdrant request budget for larger indexing/cleanup measurements. Explicit
`DB_STATEMENT_TIMEOUT_MS` and `QDRANT_TIMEOUT_MS` values override these budgets.
The normal production defaults are unchanged. The actual budgets and whether model
downloads were allowed are recorded in every result. A run with the normal
interactive 30-second SQL/5-second Qdrant budgets exposed scaling timeouts locally;
retain such failure reports rather than interpreting a longer-budget run as proof
that interactive deadlines always succeed.

Missing the disposable database URL exits 2 with a blocked report. Unavailable
semantic dependencies are reported as blocked, never silently replaced by mocks
or lexical search. Correctness, unexpected execution, and cleanup failures exit 1.
Poor relevance scores are recorded without failing the run against an invented quality
threshold. Normal no-answer retrieval has no calibrated abstention threshold.

On memory-constrained machines, set `HORIZONLAYER_TEST_MAX_WORKERS=1` for
`npm run verify` or `npm run test:coverage`. This preserves test coverage while
serializing workers; the default CPU-based limit remains unchanged. The allowed
override is 1–32. Keep heavy verification jobs separate from latency measurements.

## What is measured

The [frozen v1 fixture](../benchmarks/fixtures/v1/README.md) has 120 active primary
pages, eight foreign-workspace pages, eight archived pages, and 80 queries. Eight
entire scenario families are development data and eight are held out. Every query
grades every fixture document, including grade-zero hard negatives. The fixture
was frozen before measuring either backend; no held-out ranking optimization has
been performed.

- Recall@5 uses all positive-labeled unique documents as its denominator
- nDCG@5 uses gains `2^grade − 1` and logarithmic rank discount
- Both metrics are averaged over positive queries and warm repetitions
- No-answer cases are excluded from recall/nDCG and reported separately, including
  how many returned any results; absence of a threshold is not an accuracy guarantee
- Lexical search requests five records; semantic search requests up to 20 chunks,
  deduplicates by page, and reports the first five unique pages. This chunk-budget
  difference is explicit and reflects the existing APIs, not identical query cost
- Warm p50/p95 are nearest-rank observed percentiles, not interpolated estimates.
  Citation validation SQL is outside the timed query interval
- Cold is the first query in a fresh derived collection, including model loading,
  any permitted model download, and initial indexing. OS/database caches are not
  flushed; it is not a claim of a cold machine
- Scaling adds unlabeled short padding pages to totals of 1,000 and 10,000 pages.
  It reports seed time, first-query reconciliation/index time, and ten warm query
  samples per size. Padding is not scored for quality and is removed between
  backends. This measures one specified corpus shape, not arbitrary large documents

The JSON retains individual rankings, repeat latencies, relevance scores, split and
query-kind summaries, failure examples, correctness probes, cleanup status, exact
Git HEAD, a source-tree digest for dirty checkouts, lockfile digest, machine/runtime
information, pinned model/revision/dtype, service versions, and a GitHub Actions run
URL when applicable. A local run against an uncommitted tree is explicitly dirty;
it is not proof of a published candidate commit or a green GitHub workflow.

## Correctness and recovery scope

Both backends check returned IDs against canonical PostgreSQL. Semantic citations
are checked independently for workspace, active state, page/block revisions,
titles/timestamps, block type/position, character-range bounds, and canonical bytes.
The live lifecycle sequence creates a page, edits one block, renames, archives,
restores, and internally deletes it. Hard deletion is a fault fixture inside the
isolated benchmark, not a new public lifecycle operation.

Semantic probes index the foreign workspace into the same collection, corrupt a
known retrieved chunk payload, remove that exact chunk, forge a foreign-workspace
payload, and drop the entire derived collection. Repair requires canonical target
bytes to reappear, not merely any returned hit. A refused loopback endpoint tests
real Qdrant dependency-error classification; a subsequent healthy query measures
recovery without stopping a caller-owned service. No real Qdrant outage duration,
process restart, or backup restoration is inferred from that refused endpoint.

The separate packed recovery journey already covers the A → B → A → safety-B,
reset, corrupted archive, interrupted restore, SQL, MCP, dashboard, derived index,
and resource-cleanup flows. Run its timed evidence wrapper with Docker available:

```bash
HORIZONLAYER_RECOVERY_REPORT="$PWD/benchmarks/results/recovery.json" \
EMBEDDING_CACHE_DIR="$PWD/.benchmark-model-cache" \
  npm run benchmark:recovery
```

Its report survives disposal of the smoke workspace, includes durations for
successful observed recovery commands, and excludes backup bytes/runtime
credentials. A missing Docker Engine is reported as blocked before packing or
running any recovery stage. A nonzero preview/refusal command is expected only
when the existing smoke explicitly asserts it. The wrapper's total duration
includes packing/build; `smoke_started_at` marks the later journey start.

## Local verification and historical evidence

Verification and benchmarks run locally. GitHub Actions is reserved for delivery;
the previous CI workflow has been removed. Follow the commands above and retain
their JSON reports with the exact checked-out HEAD, source-tree digest, and model
revision. A report from an older commit must not be applied to a newer tree.

The GitHub Actions run below is historical benchmark evidence from the former CI
workflow, rather than the current verification policy.

The benchmark and recovery milestone merged in [PR #42](https://github.com/kyle-mirich/horizonlayer/pull/42)
as [main commit `4367381312f2f30f099424c66cb6baaaa36af2bb`](https://github.com/kyle-mirich/horizonlayer/commit/4367381312f2f30f099424c66cb6baaaa36af2bb).
Its [October 7 main CI run](https://github.com/kyle-mirich/horizonlayer/actions/runs/37578853237)
passed all five jobs: verification/coverage/build, PostgreSQL integration, real
retrieval/scaling, packed CLI recovery, and the non-blocking mutation report.
The retrieval and recovery artifacts identify that exact clean main checkout.
Earlier reports about the pre-milestone `[skip ci]` commit are historical; they do
not describe this completed run. Later changes still require their own SHA-specific
verification rather than inheriting this result.

In that recorded run, the 40-query held-out split contained 32 positive queries
and eight no-answer queries. Authored-synthetic **positive-query Recall@5** was
0.1015625 for lexical search and 0.8046875 for semantic search; nDCG@5 was
0.1836140 and 0.7029846 respectively. The labels were authored by an AI coding
assistant, not independently reviewed human judgments. These results do not
validate general retrieval accuracy. **All eight semantic no-answer queries
returned results**, so the benchmark makes no calibrated-abstention claim.
The defined lifecycle/index-fault/scaling probes observed zero canonical violations,
and the packed journey passed all 16 recovery proofs. These are scoped observations,
not universal correctness or multi-tenant security guarantees. Raw per-query
results, machine/model configuration, measurement budgets, and recovery timings
are retained in the linked run's artifacts and the delivered evidence bundle.
