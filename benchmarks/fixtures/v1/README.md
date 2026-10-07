# Authored synthetic retrieval fixture v1

This corpus contains fictional engineering and operational decisions. Its documents,
queries, and relevance labels were authored by an AI coding assistant for this
benchmark and assembled locally on 2026-10-07. They are **authored synthetic labels**,
not independent human judgments, a reviewed production dataset, or evidence of real
customer retrieval quality. No external documents, paid services, auxiliary model
or embedding service calls, retrieval results, or embedding results were used to
assemble or grade the fixture. The authoring assistant itself supplied the fictional
prose and labels; there was no independent model-based judging pass.

The local assembler only serialized authored scenario definitions; it did not select
labels to obtain a desired score. Query families and grades were fixed before running
any retrieval backend. The JSON files are the versioned source of truth. Changes to
scenario meaning, split membership, or grades require a new fixture version rather
than silently changing an existing benchmark baseline.

## Files and dimensions

- `documents.json`: an array of 136 records with `id`, `workspace`, `title`,
  `content`, `tags`, and optional `archived`
- 120 active, searchable primary-workspace documents: eight development families
  with eight documents each, and eight held-out families with seven documents each
- Eight foreign-workspace documents and eight archived primary-workspace documents,
  intentionally repeating highly relevant wording to test scope enforcement
- `queries.json`: an array of 80 query records with `id`, `split`, `family`, `kind`,
  `query`, and an integer-valued `relevance` mapping
- Each query explicitly grades all 136 documents, including scope distractors
- Expected relevant documents are always active and in the primary workspace

All names, service policies, timings, thresholds, and situations are invented. No
personal data or working credentials are present. There is no generated identifier
that every query must match to find its answer. Titles and prose intentionally mix
natural wording, related terms, and overlapping operational concepts.

## Frozen family split

The corpus is indexed as one collection of documents. `dev` and `heldout` split the
query judgments, not the documents available to retrieve. All queries from a scenario
family belong to one split, so paraphrases of a development scenario never occur in
the held-out query set. Keep held-out labels out of tuning; evaluate them only after
freezing retrieval configuration. This authored fixture is public within the
repository, so the split is a workflow discipline rather than a secrecy guarantee.

Development families (40 queries):

- payment-idempotency
- tenant-routing
- credential-rotation
- ledger-reconciliation
- cache-consistency
- canary-rollout
- backup-restoration
- message-ordering

Held-out families (40 queries):

- certificate-renewal
- query-planning
- object-lifecycle
- incident-handoff
- schema-contracts
- feature-entitlements
- edge-rate-limiting
- queue-fairness

Every family contributes five queries, in this order:

1. `lexical`: direct terminology shared with the approved decision
2. `paraphrase`: the same decision expressed as a user problem
3. `paraphrase`: the related operational procedure expressed without its title
4. `hard-negative`: contrasts the current policy with a tempting, wrong-scope active
   document such as a laboratory rule, another workflow, or a related subsystem
5. `negative`: asks for an unsupported or explicitly prohibited guarantee; no
   document is labeled a positive answer

Each split therefore has eight lexical queries, sixteen paraphrases, eight hard
negative queries, and eight no-answer queries. Related active documents describe
operationally distinct rules rather than meaningless keyword stuffing. Lexical
queries reward exact terminology; paraphrases need conceptual similarity; the hard
negatives test whether similarity preserves the requested procedure and scope.
These are intended trade-offs to measure, not claims that any backend will win.

## Relevance grades

- **3**: directly states the current decision or procedure requested by the query
- **2**: substantial supporting policy, procedure, or rationale that helps answer
  the request, but is not the most direct answer
- **1**: useful partial diagnostic or explanatory context that cannot answer the
  whole request on its own
- **0**: does not answer the requested policy/procedure, addresses a distinct
  workflow, is out of workspace/archive scope, or answers only an unsupported claim

For decision questions, the approved decision is grade 3, its runbook and rationale
are grade 2, and monitoring context is grade 1. For recovery/procedure questions,
the runbook is grade 3, the governing decision is grade 2, and monitoring/rationale
are partial context. The remaining documents cover different tasks, demonstration
settings, or distinct subsystems. Grading is intentionally task-specific: related
vocabulary alone is not relevance. A wrong alternative explicitly rejected by a
direct-answer policy can still appear in that policy's answer, while a separate
worksheet, tutorial, or subsystem document describing that alternative is grade 0.

For negative queries all grades are zero even when documents explain why the claimed
policy is prohibited. These cases measure retrieval of an affirmative supporting
answer, not the ability of a downstream model to cite a contradiction. Report
negative-query false-positive rates separately; recall and NDCG with an empty ideal
ranking must not be averaged as if these were ordinary answerable queries.

Foreign and archived documents are always grade 0 regardless of wording. A backend
must scope/filter them, not merely hope their titles rank below authorized material.
This fixture tests archive and workspace exclusion, not a complete authorization
model, document-level ACLs, or adversarial text execution.

## Validation and limitations

Run `npx vitest run src/testing/benchmarks/fixtures.test.ts` to validate counts,
unique identifiers, known label targets, integer grades, active-primary positives,
nonoverlapping scenario families, query-kind coverage, and negative/scope labels.
The fixture tests are ordinary unit tests and require no database, network, or model.

The labels are exhaustive for this authored corpus but not independently reviewed.
Families, wording patterns, and related-document structures are deliberately
controlled, which can make a backend overfit them. Real operational documents have
more ambiguous, incomplete, changing, and cross-domain relevance. This small fixture
supports reproducible regression comparisons, not population-wide quality claims.
Independent reviewer judgments and a separately collected deployment corpus would
be needed for stronger retrieval-quality conclusions. Embedding generation belongs
to the benchmark runtime, not the fixture provenance.
