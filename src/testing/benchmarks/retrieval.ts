import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { ResolvedSearchScope } from '../../db/queries/search.js';
import { validateCanonicalHit, type CanonicalHitRow, type Hit } from './citations.js';
import { latencySummary, mean, scoreRanking } from './metrics.js';
import { sha256, sourceEvidence, writeEvidence } from './evidence.js';
import { parseBenchmarkOptions } from './options.js';
import { semanticPrerequisite } from './prerequisites.js';

interface Document {
  id: string;
  workspace: 'primary' | 'foreign';
  title: string;
  content: string;
  tags: string[];
  archived?: boolean;
}
interface Query {
  id: string;
  split: 'dev' | 'heldout';
  family: string;
  kind: string;
  query: string;
  relevance: Record<string, number>;
}
interface Observation {
  id: string;
  split: string;
  family: string;
  kind: string;
  ranking: string[];
  recall: number | null;
  ndcg: number | null;
  negativeReturned: boolean;
  ranking_stable: boolean;
  latency_ms: number[];
  violations: string[];
}

export async function runRetrievalBenchmark(args = process.argv.slice(2)): Promise<number> {
  const opts = parseBenchmarkOptions(args);
  const root = process.cwd();
  const fixtureRoot = resolve(root, 'benchmarks/fixtures/v1');
  const documentBytes = await readFile(resolve(fixtureRoot, 'documents.json'), 'utf8');
  const queryBytes = await readFile(resolve(fixtureRoot, 'queries.json'), 'utf8');
  const documents = JSON.parse(documentBytes) as Document[];
  const queries = JSON.parse(queryBytes) as Query[];
  const report: Record<string, unknown> = {
    format_version: 1,
    status: 'running',
    started_at: new Date().toISOString(),
    source: sourceEvidence(root),
    fixture: { version: 'v1', documents: documents.length, queries: queries.length,
      documents_sha256: sha256(documentBytes), queries_sha256: sha256(queryBytes),
      labels: 'authored-synthetic; not independently human-reviewed' },
    methodology: { k: 5, unit: 'unique page', semantic_chunk_limit: 20, warm_repeats: opts.repeats,
      cold: 'first query in a fresh collection; includes model loading and indexing, not an OS-cache flush',
      negatives: 'reported separately; retrieval has no calibrated abstention threshold',
      scaling: 'unlabeled synthetic padding; quality is not scored on padding' },
    backends: {},
  };
  const backends = report.backends as Record<string, unknown>;
  const databaseUrl = process.env.HORIZONLAYER_BENCHMARK_DATABASE_URL;
  if (!databaseUrl) {
    report.status = 'blocked';
    report.blocker = 'HORIZONLAYER_BENCHMARK_DATABASE_URL must point to a disposable PostgreSQL database';
    await writeEvidence(opts.output, report);
    return 2;
  }
  const schema = `hl_bench_${randomUUID().replaceAll('-', '')}`;
  const collection = `hl_bench_${randomUUID().replaceAll('-', '')}`;
  const primary = randomUUID();
  const foreign = randomUUID();
  const stableId = (value: string): string => {
    const bytes = createHash('sha256').update(`horizonlayer-fixture-v1:${value}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const ids = new Map<string, string>(documents.map((document) => [document.id, stableId(document.id)]));
  const fixtureIds = new Map<string, string>([...ids].map(([fixture, uuid]) => [uuid, fixture]));
  // These settings are confined to this benchmark process. Caller overrides win.
  process.env.DB_STATEMENT_TIMEOUT_MS ??= '300000';
  process.env.QDRANT_TIMEOUT_MS ??= '30000';
  const admin = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10000,
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS) });
  admin.on('error', () => { backendFailed = true; });
  let pool: pg.Pool | undefined;
  let closePool: (() => Promise<void>) | undefined;
  let dispose: (() => Promise<void>) | undefined;
  let qdrant: QdrantClient | undefined;
  let createdSchema = false;
  let anyFailed = false;
  let backendFailed = false;
  let backendBlocked = false;
  const cleanupErrors: string[] = [];
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    createdSchema = true;
    const setup = await admin.connect();
    try {
      await setup.query(`SET search_path TO ${schema}, public, pg_catalog`);
      await setup.query(await readFile(resolve(root, 'schema.sql'), 'utf8'));
    } finally { setup.release(); }
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},public,pg_catalog`);
    process.env.DATABASE_URL = isolatedUrl.toString();
    process.env.PGOPTIONS = `-c search_path=${schema},public,pg_catalog`;
    process.env.RAG_ENABLED = 'true';
    process.env.QDRANT_COLLECTION = collection;
    if (process.env.HORIZONLAYER_BENCHMARK_QDRANT_URL) process.env.QDRANT_URL = process.env.HORIZONLAYER_BENCHMARK_QDRANT_URL;
    const db = await import('../../db/client.js');
    const lexical = await import('../../db/queries/search.js');
    const rag = await import('../../search/rag.js');
    const embedding = await import('../../search/embedder.js');
    const { config } = await import('../../config.js');
    pool = db.getPool();
    closePool = db.closePool;
    dispose = embedding.disposeEmbeddingProvider;
    if ((await pool.query('SELECT current_schema() AS schema')).rows[0].schema !== schema) {
      throw new Error('Refusing fixture writes because PostgreSQL did not select the isolated benchmark schema');
    }
    report.postgresql = (await pool.query('SELECT version() AS version')).rows[0].version;
    report.embedding = { model: config.rag.embedding_model, revision: config.rag.embedding_revision, dtype: config.rag.embedding_dtype };
    report.measurement_configuration = { postgres_statement_timeout_ms: config.database.statement_timeout_ms,
      postgres_admin_statement_timeout_ms: Number(process.env.DB_STATEMENT_TIMEOUT_MS),
      qdrant_timeout_ms: config.rag.timeout_ms, embedding_download_allowed: config.rag.allow_download };
    await pool.query('INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)', [primary, 'Synthetic benchmark primary', foreign, 'Synthetic benchmark foreign']);
    for (const document of documents) {
      await pool.query(`INSERT INTO pages (id, workspace_id, title, tags, importance, archived_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 0.5, $5, '2026-01-01', '2026-01-01')`,
      [ids.get(document.id), document.workspace === 'primary' ? primary : foreign, document.title, document.tags, document.archived ? '2026-01-02' : null]);
      await pool.query('INSERT INTO blocks (page_id, block_type, content, position) VALUES ($1, $2, $3, 0)', [ids.get(document.id), 'text', document.content]);
    }
    await pool.query('ANALYZE');
    const scope: ResolvedSearchScope = { kind: 'workspace', workspace_id: primary, types: ['page'], session_id: null, database_id: null };
    const validateHits = async (hits: Hit[]): Promise<string[]> => {
      const violations: string[] = [];
      for (const hit of hits) {
        const canonical = (await pool!.query<CanonicalHitRow>(`SELECT p.*, b.id AS block_id, b.revision AS block_revision, b.block_type, b.position,
          b.content, b.archived_at AS block_archived FROM pages p LEFT JOIN blocks b ON b.page_id = p.id WHERE p.id = $1`, [hit.id])).rows;
        violations.push(...validateCanonicalHit(hit, canonical, primary));
      }
      return violations;
    };
    for (const backend of opts.backend === 'both' ? ['lexical', 'semantic'] : [opts.backend]) {
      const observations: Observation[] = [];
      const stages: Record<string, unknown> = {};
      const backendReport: Record<string, unknown> = { status: 'running', implementation: backend === 'lexical' ? 'real PostgreSQL lexical/trigram' : 'real PostgreSQL + Qdrant + local ONNX embeddings', stages };
      backends[backend] = backendReport;
      await writeEvidence(opts.output, report);
      const search = async (query: string): Promise<Hit[]> => {
        if (backend === 'lexical') return (await lexical.searchRecords({ query, scope, limit: 5 })).records;
        const result = await rag.searchRag({ query, scope, limit: 20 });
        if (result.stale) throw new Error('RAG returned a stale fallback instead of a stable snapshot');
        return result.chunks.map((chunk) => ({ id: chunk.citation.id, workspace_id: chunk.citation.workspace_id,
          revision: chunk.citation.revision, title: chunk.citation.title, snippet: chunk.text, citation: chunk.citation, semantic: true }));
      };
      const probe = async (name: string, query: string, check: (hits: Hit[]) => boolean): Promise<Hit[]> => {
        const start = performance.now();
        const hits = await search(query);
        const elapsed = performance.now() - start;
        const violations = await validateHits(hits);
        const passed = check(hits) && violations.length === 0;
        stages[name] = { status: passed ? 'passed' : 'failed', elapsed_ms: elapsed, violations };
        if (!passed) anyFailed = true;
        return hits;
      };
      try {
        if (backend === 'semantic') {
          backendReport.qdrant = await semanticPrerequisite(process.env.HORIZONLAYER_BENCHMARK_QDRANT_URL, async () => {
            const candidate = new QdrantClient({ url: config.rag.qdrant_url, apiKey: config.rag.api_key, timeout: config.rag.timeout_ms });
            const version = await candidate.versionInfo();
            // A refused preflight cannot have created a collection to clean up.
            qdrant = candidate;
            return version;
          });
        }
        const coldStart = performance.now();
        const coldHits = await search(queries[0].query);
        const coldElapsed = performance.now() - coldStart;
        const coldViolations = await validateHits(coldHits);
        stages.cold_first_query = { elapsed_ms: coldElapsed, violations: coldViolations };
        if (coldViolations.length) anyFailed = true;
        if (backend === 'semantic') {
          const foreignStart = performance.now();
          await rag.searchRag({ query: documents.find((document) => document.workspace === 'foreign')!.title,
            scope: { ...scope, workspace_id: foreign }, limit: 20 });
          stages.foreign_workspace_indexed = { elapsed_ms: performance.now() - foreignStart,
            note: 'Foreign distractors share the real collection before scored primary queries' };
        }
        for (const query of queries) {
          const timings: number[] = [];
          const allViolations: string[] = [];
          let ranking: string[] = [];
          let rankingStable = true;
          const scores: ReturnType<typeof scoreRanking>[] = [];
          for (let repeat = 0; repeat < opts.repeats; repeat += 1) {
            const start = performance.now();
            const hits = await search(query.query);
            timings.push(performance.now() - start);
            allViolations.push(...await validateHits(hits));
            const current = [...new Set(hits.map((hit) => fixtureIds.get(hit.id) ?? `unknown:${hit.id}`))].slice(0, 5);
            if (repeat > 0 && JSON.stringify(ranking) !== JSON.stringify(current)) rankingStable = false;
            if (repeat === 0) ranking = current;
            scores.push(scoreRanking({ relevance: query.relevance, ranking: current }));
          }
          observations.push({ id: query.id, split: query.split, family: query.family, kind: query.kind,
            ranking, recall: mean(scores.map((score) => score.recall)), ndcg: mean(scores.map((score) => score.ndcg)),
            negativeReturned: scores.some((score) => score.negativeReturned), ranking_stable: rankingStable,
            latency_ms: timings, violations: [...new Set(allViolations)] });
        }
        backendReport.queries = observations;
        const summarize = (rows: Observation[]): Record<string, unknown> => ({
          queries: rows.length, positive_queries: rows.filter((row) => row.recall !== null).length,
          recall_at_5: mean(rows.map((row) => row.recall)), ndcg_at_5: mean(rows.map((row) => row.ndcg)),
          no_answer_queries: rows.filter((row) => row.recall === null).length,
          no_answer_queries_returning_results: rows.filter((row) => row.negativeReturned).length,
          violations: rows.reduce((sum, row) => sum + row.violations.length, 0),
          unstable_rankings: rows.filter((row) => !row.ranking_stable).length,
          warm_latency: latencySummary(rows.flatMap((row) => row.latency_ms)),
        });
        backendReport.summary = Object.fromEntries(['dev', 'heldout'].map((split) => [split, summarize(observations.filter((row) => row.split === split))]));
        backendReport.by_kind = Object.fromEntries([...new Set(queries.map((query) => query.kind))].map((kind) => [kind, summarize(observations.filter((row) => row.kind === kind))]));
        backendReport.failure_examples = observations.filter((row) => row.recall !== null && (row.recall < 1 || (row.ndcg ?? 0) < 1)).slice(0, 10);
        await writeEvidence(opts.output, report);
        if (observations.some((row) => row.violations.length)) anyFailed = true;
        const probeId = randomUUID();
        await pool.query('INSERT INTO pages (id, workspace_id, title) VALUES ($1,$2,$3)', [probeId, primary, 'Freshness probe amberglass']);
        await pool.query('INSERT INTO blocks (page_id, block_type, content, position) VALUES ($1, $2, $3, 0)', [probeId, 'text', 'amberglass initial evidence']);
        await probe('initial_probe', 'amberglass', (hits) => hits.some((hit) => hit.id === probeId));
        await pool.query("UPDATE blocks SET content='silverbrook updated evidence' WHERE page_id=$1", [probeId]);
        await probe('single_edit_refresh', 'silverbrook', (hits) => hits.some((hit) => hit.id === probeId && hit.snippet.includes('silverbrook')));
        await pool.query("UPDATE pages SET title='Renamed freshness probe silverbrook' WHERE id=$1", [probeId]);
        await probe('rename_refresh', 'silverbrook', (hits) => hits.some((hit) => hit.id === probeId) && hits.filter((hit) => hit.id === probeId).every((hit) => hit.title === 'Renamed freshness probe silverbrook'));
        await pool.query('UPDATE pages SET archived_at=NOW() WHERE id=$1', [probeId]);
        await probe('archive_refresh', 'silverbrook', (hits) => hits.every((hit) => hit.id !== probeId));
        await pool.query('UPDATE pages SET archived_at=NULL WHERE id=$1', [probeId]);
        await probe('restore_refresh', 'silverbrook', (hits) => hits.some((hit) => hit.id === probeId));
        // Canonical hard deletion is an internal fault fixture, never a public lifecycle operation.
        await pool.query('DELETE FROM pages WHERE id=$1', [probeId]);
        await probe('internal_delete_refresh', 'silverbrook', (hits) => hits.every((hit) => hit.id !== probeId));
        if (backend === 'semantic' && qdrant) {
          const targetId = ids.get(documents[0].id)!;
          const corpus = await rag.loadRagCorpus(primary);
          const target = corpus.points.find((point) => point.citation.id === targetId
            && point.citation.type === 'page' && point.citation.part === 'block');
          if (!target) throw new Error('Cannot inject corruption without the known target chunk');
          if (!(await search(target.text)).some((hit) => hit.id === targetId && hit.snippet === target.text)) {
            throw new Error('Fault injection target was not retrieved by its exact canonical evidence');
          }
          const assertTargetRepaired = async (): Promise<void> => {
            const stored = await qdrant!.retrieve(collection, { ids: [target.id], with_payload: true });
            const { index_generation: _generation, ...payload } = stored[0]?.payload ?? {};
            if (rag.ragInternals.stableJson(payload) !== rag.ragInternals.stableJson(target.payload)) {
              throw new Error('The exact injected target chunk was not repaired from canonical data');
            }
          };
          await qdrant.setPayload(collection, { wait: true, points: [target.id], payload: { text: 'CORRUPTED synthetic evidence' } });
          await probe('corrupted_payload_recovery', target.text,
            (hits) => hits.some((hit) => hit.id === targetId) && hits.every((hit) => !hit.snippet.includes('CORRUPTED')));
          await assertTargetRepaired();
          await qdrant.delete(collection, { wait: true, points: [target.id] });
          await probe('missing_chunk_recovery', target.text, (hits) => hits.some((hit) => hit.id === targetId && hit.snippet === target.text));
          await assertTargetRepaired();
          const foreignDocument = documents.find((document) => document.workspace === 'foreign')!;
          const foreignCorpus = await rag.loadRagCorpus(foreign);
          const foreignPoint = foreignCorpus.points.find((point) => point.citation.id === ids.get(foreignDocument.id))!;
          await qdrant.setPayload(collection, { wait: true, points: [foreignPoint.id],
            payload: { workspace_id: primary, index_generation: await rag.loadRagGeneration(primary) } });
          await probe('forged_foreign_workspace_payload', foreignDocument.title,
            (hits) => hits.every((hit) => hit.workspace_id === primary && hit.id !== ids.get(foreignDocument.id)));
          await qdrant.deleteCollection(collection);
          await probe('dropped_collection_recovery', queries[0].query, (hits) => hits.length > 0);
          const portProbe = createServer();
          await new Promise<void>((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(0, '127.0.0.1', resolve); });
          const address = portProbe.address();
          if (!address || typeof address === 'string') throw new Error('Cannot allocate a controlled unavailable endpoint');
          const unavailablePort = address.port;
          await new Promise<void>((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
          const { QdrantVectorStore } = await import('../../search/qdrant.js');
          const { DependencyUnavailableError } = await import('../../search/errors.js');
          const outageStart = performance.now();
          let classified = false;
          try {
            await rag.searchRagWithDependencies({ query: queries[0].query, scope, limit: 20 }, {
              getEmbeddingProvider: embedding.getEmbeddingProvider, loadGeneration: rag.loadRagGeneration,
              loadCorpus: rag.loadRagCorpus, loadPoints: rag.loadRagPoints, withWorkspaceLock: rag.withRagWorkspaceLock,
              vectorStore: new QdrantVectorStore(new QdrantClient({ url: `http://127.0.0.1:${unavailablePort}`, timeout: 200, checkCompatibility: false }), collection),
            });
          } catch (error) { classified = error instanceof DependencyUnavailableError && error.dependency === 'qdrant'; }
          stages.dependency_outage = { status: classified ? 'passed' : 'failed', elapsed_ms: performance.now() - outageStart,
            injection: 'real refused-loopback Qdrant endpoint; caller-owned service was not stopped' };
          if (!classified) anyFailed = true;
          await probe('healthy_endpoint_recovery', queries[0].query, (hits) => hits.length > 0);
        }
        const scaling: unknown[] = [];
        let padded = documents.length;
        for (const size of [...opts.sizes].sort((a, b) => a - b)) {
          const seedStart = performance.now();
          while (padded < size) {
            const batch = Math.min(500, size - padded);
            await pool.query(`WITH inserted AS (INSERT INTO pages (workspace_id,title,tags)
              SELECT $1, 'Padding operational note ' || n, ARRAY['padding'] FROM generate_series($2::int,$3::int) n RETURNING id)
              INSERT INTO blocks(page_id,block_type,content,position) SELECT id,'text','Unlabeled ballast for synthetic scaling, not a relevance judgment.',0 FROM inserted`, [primary, padded, padded + batch - 1]);
            padded += batch;
          }
          await pool.query('ANALYZE');
          const seedMs = performance.now() - seedStart;
          const indexStart = performance.now();
          await search(queries[0].query);
          const reconcileMs = performance.now() - indexStart;
          const timings: number[] = [];
          const scaleViolations: string[] = [];
          for (const query of queries.slice(0, 10)) {
            const start = performance.now();
            const hits = await search(query.query);
            timings.push(performance.now() - start);
            const violations = await validateHits(hits);
            scaleViolations.push(...violations);
            if (violations.length) anyFailed = true;
          }
          const activePages = Number((await pool.query('SELECT COUNT(*) FROM pages WHERE workspace_id=$1 AND archived_at IS NULL', [primary])).rows[0].count);
          const chunks = backend === 'semantic' && qdrant ? (await qdrant.count(collection, { exact: true,
            filter: { must: [{ key: 'workspace_id', match: { value: primary } }, { key: 'record_type', match: { value: 'chunk' } }] } })).count : null;
          scaling.push({ total_fixture_and_padding_pages: size, active_primary_pages: activePages, derived_chunks: chunks,
            seed_ms: seedMs, first_query_after_growth_ms: reconcileMs, warm_latency_ms: timings,
            warm: latencySummary(timings), violations: [...new Set(scaleViolations)] });
        }
        backendReport.scaling = scaling;
        await pool.query("DELETE FROM pages WHERE workspace_id=$1 AND tags @> ARRAY['padding']", [primary]);
        backendReport.status = coldViolations.length || observations.some((row) => row.violations.length)
          || scaling.some((row) => (row as { violations: string[] }).violations.length)
          || Object.values(stages).some((value) => (value as { status?: string }).status === 'failed') ? 'failed' : 'passed';
      } catch (error) {
        const blocked = error instanceof Error && 'code' in error && error.code === 'DEPENDENCY_UNAVAILABLE';
        backendReport.status = blocked ? 'blocked' : 'failed';
        backendReport.error = error instanceof Error ? error.message : String(error);
        if (blocked) backendBlocked = true;
        else backendFailed = true;
      } finally {
        await pool.query("DELETE FROM pages WHERE workspace_id=$1 AND tags @> ARRAY['padding']", [primary]);
      }
      await writeEvidence(opts.output, report);
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    backendFailed = true;
  } finally {
    if (qdrant) {
      try { if ((await qdrant.collectionExists(collection)).exists) await qdrant.deleteCollection(collection); }
      catch { cleanupErrors.push('Could not remove this run’s isolated Qdrant collection'); }
    }
    try { await dispose?.(); } catch { cleanupErrors.push('Embedding runtime disposal failed'); }
    try { await closePool?.(); } catch { cleanupErrors.push('PostgreSQL pool cleanup failed'); }
    if (createdSchema) {
      try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } catch { cleanupErrors.push('Could not remove this run’s isolated PostgreSQL schema'); }
    }
    await admin.end();
  }
  report.cleanup = { status: cleanupErrors.length ? 'failed' : 'passed', errors: cleanupErrors };
  report.status = anyFailed || backendFailed || cleanupErrors.length ? 'failed' : backendBlocked ? 'blocked' : 'passed';
  report.finished_at = new Date().toISOString();
  await writeEvidence(opts.output, report);
  console.log(`Retrieval benchmark ${report.status}: ${resolve(opts.output)}`);
  return report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1;
}

runRetrievalBenchmark().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
