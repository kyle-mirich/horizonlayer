import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

import { config } from '../config.js';
import { getPool } from '../db/client.js';
import type { ResolvedSearchScope } from '../db/queries/search.js';
import { DependencyUnavailableError } from './errors.js';
import { getEmbeddingProvider, type EmbeddingProvider } from './embedder.js';
import {
  getVectorStore,
  type ScoredVectorPoint,
  type VectorPoint,
  type VectorStore,
} from './qdrant.js';

const MAX_CHUNK_CHARACTERS = 800;
const CHUNK_OVERLAP_CHARACTERS = 120;
const EMBEDDING_BATCH_SIZE = 32;
const INDEX_LOCK_SEED = '7243612901';
const MANIFEST_EMBED_TEXT = 'HorizonLayer local semantic index manifest';
const PAYLOAD_VERSION = 1;
const ragClientContext = new AsyncLocalStorage<PoolClient>();
const ragWorkspaceRebuilds = new Map<string, Promise<unknown>>();

type BlockType = 'text' | 'heading' | 'todo' | 'callout' | 'code';

interface RagPageCitationBase {
  type: 'page';
  id: string;
  workspace_id: string;
  title: string;
  revision: number;
  updated_at: string;
}

export type RagPageCitation = RagPageCitationBase & (
  | { part: 'title' }
  | {
      part: 'block';
      block_id: string;
      block_revision: number;
      block_type: BlockType;
      block_position: number;
      char_start: number;
      char_end: number;
    }
);

export interface RagRowCitation {
  type: 'row';
  id: string;
  workspace_id: string;
  database_id: string;
  database_name: string;
  database_description: string | null;
  title: string;
  revision: number;
  updated_at: string;
  properties: Array<{ id: string; name: string }>;
}

export interface RagChunk {
  rank: number;
  score: number;
  text: string;
  citation: RagPageCitation | RagRowCitation;
}

export interface RagSearchResult {
  chunks: RagChunk[];
  truncated: boolean;
}

interface PageSourceRow {
  page_id: string;
  workspace_id: string;
  session_id: string | null;
  page_title: string;
  page_tags: string[] | null;
  page_importance: number;
  page_revision: number;
  page_updated_at: Date | string;
  block_id: string | null;
  block_type: BlockType | null;
  block_content: string | null;
  block_position: number | null;
  block_revision: number | null;
}

interface RowSourceRow {
  row_id: string;
  workspace_id: string;
  database_id: string;
  database_name: string;
  database_description: string | null;
  database_revision: number;
  row_tags: string[] | null;
  row_importance: number;
  row_revision: number;
  row_updated_at: Date | string;
  property_id: string;
  property_name: string;
  property_type: string;
  property_position: number;
  property_revision: number;
  value_text: string | null;
  value_number: number | null;
  value_date: Date | string | null;
  value_bool: boolean | null;
  value_json: unknown;
}

interface TextChunk {
  text: string;
  start: number;
  end: number;
}

export interface CanonicalRagPoint {
  id: string;
  chunk_hash: string;
  embed_text: string;
  fingerprint: string;
  text: string;
  tags: string[];
  importance: number;
  workspace_id: string;
  source_type: 'page' | 'row';
  session_id: string | null;
  database_id: string | null;
  citation: RagPageCitation | RagRowCitation;
  payload: Record<string, unknown>;
}

export interface RagCorpus {
  generation: string;
  fingerprint: string;
  points: CanonicalRagPoint[];
}

export interface RagPointSnapshot {
  generation: string;
  points: CanonicalRagPoint[];
}

export interface RagSourceSelection {
  page_ids: string[];
  row_ids: string[];
}

export interface RagSearchDependencies {
  getEmbeddingProvider(): Promise<EmbeddingProvider>;
  loadGeneration(workspaceId: string): Promise<string>;
  loadCorpus(workspaceId: string): Promise<RagCorpus>;
  loadPoints(workspaceId: string, sources: RagSourceSelection): Promise<RagPointSnapshot>;
  vectorStore: VectorStore;
  withWorkspaceLock<T>(workspaceId: string, work: () => Promise<T>): Promise<T>;
}

function normalizeText(value: string): string {
  return value.normalize('NFC').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Search source contained an invalid timestamp');
  return date.toISOString();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicPointId(value: string): string {
  const bytes = Buffer.from(digest(`horizonlayer-rag:${value}`).slice(0, 32), 'hex');
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function splitText(value: string): TextChunk[] {
  const text = value;
  if (text.trim().length === 0) return [];

  const chunks: TextChunk[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + MAX_CHUNK_CHARACTERS);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end);
      if (boundary >= cursor + Math.floor(MAX_CHUNK_CHARACTERS / 2)) end = boundary;
    }

    let start = cursor;
    while (start < end && /\s/u.test(text[start]!)) start += 1;
    while (end > start && /\s/u.test(text[end - 1]!)) end -= 1;
    if (end > start) chunks.push({ text: text.slice(start, end), start, end });
    if (end >= text.length) break;

    const next = Math.max(cursor + 1, end - CHUNK_OVERLAP_CHARACTERS);
    cursor = next;
  }
  return chunks;
}

function rowValue(row: RowSourceRow): string | null {
  if (row.value_text !== null) return normalizeText(row.value_text);
  if (row.value_number !== null) return String(row.value_number);
  if (row.value_date !== null) return timestamp(row.value_date);
  if (row.value_bool !== null) return row.value_bool ? 'true' : 'false';
  if (row.value_json !== null && row.value_json !== undefined) return stableJson(row.value_json);
  return null;
}

function sourceFingerprint(value: unknown): string {
  return digest(stableJson(value));
}

function embeddingFingerprint(): string {
  return [
    config.rag.embedding_model,
    config.rag.embedding_revision,
    config.rag.embedding_dtype,
    'mean',
    'normalized',
    `chars:${MAX_CHUNK_CHARACTERS}:${CHUNK_OVERLAP_CHARACTERS}`,
    `payload:${PAYLOAD_VERSION}`,
  ].join(':');
}

function buildPagePoints(rows: PageSourceRow[]): CanonicalRagPoint[] {
  const byPage = new Map<string, PageSourceRow[]>();
  for (const row of rows) {
    const page = byPage.get(row.page_id) ?? [];
    page.push(row);
    byPage.set(row.page_id, page);
  }

  const points: CanonicalRagPoint[] = [];
  for (const pageRows of byPage.values()) {
    const first = pageRows[0]!;
    const ordered = pageRows.filter((row): row is PageSourceRow & {
      block_id: string;
      block_type: BlockType;
      block_content: string;
      block_position: number;
      block_revision: number;
    } => row.block_id !== null
      && row.block_type !== null
      && row.block_content !== null
      && row.block_position !== null
      && row.block_revision !== null).sort((left, right) => (
      left.block_position - right.block_position || left.block_id.localeCompare(right.block_id)
    ));
    const fingerprint = sourceFingerprint({
      id: first.page_id,
      revision: first.page_revision,
      title: first.page_title,
      tags: first.page_tags ?? [],
      importance: first.page_importance,
      blocks: ordered.map((row) => ({
        id: row.block_id,
        type: row.block_type,
        content: row.block_content,
        position: row.block_position,
        revision: row.block_revision,
      })),
    });
    const updatedAt = timestamp(first.page_updated_at);
    const titleText = first.page_title;
    const titleId = deterministicPointId(
      `${first.workspace_id}:page:${first.page_id}:title:0`
    );
    const titleEmbedText = titleText;
    const titleChunkHash = digest(
      `${embeddingFingerprint()}\n${fingerprint}\n${titleEmbedText}`
    );
    const basePayload: Record<string, unknown> = {
      record_type: 'chunk',
      workspace_id: first.workspace_id,
      source_type: 'page',
      source_id: first.page_id,
      fingerprint,
      tags: first.page_tags ?? [],
      importance: first.page_importance,
      updated_at: updatedAt,
    };
    if (first.session_id) basePayload.session_id = first.session_id;
    const titleCitation: RagPageCitation = {
      type: 'page',
      part: 'title',
      id: first.page_id,
      workspace_id: first.workspace_id,
      title: first.page_title,
      revision: first.page_revision,
      updated_at: updatedAt,
    };
    points.push({
      id: titleId,
      chunk_hash: titleChunkHash,
      embed_text: titleEmbedText,
      fingerprint,
      text: titleText,
      tags: first.page_tags ?? [],
      importance: first.page_importance,
      workspace_id: first.workspace_id,
      source_type: 'page',
      session_id: first.session_id,
      database_id: null,
      citation: titleCitation,
      payload: {
        ...basePayload,
        chunk_hash: titleChunkHash,
        citation: titleCitation,
        payload_version: PAYLOAD_VERSION,
        text: titleText,
      },
    });

    for (const block of ordered) {
      const blockChunks = splitText(block.block_content);
      for (const [chunkIndex, chunk] of blockChunks.entries()) {
        const id = deterministicPointId(
          `${first.workspace_id}:page:${first.page_id}:${block.block_id}:${chunkIndex}`
        );
        const embedText = `${chunk.text}\nPage: ${first.page_title}`;
        const chunkHash = digest(`${embeddingFingerprint()}\n${fingerprint}\n${embedText}`);
        const citation: RagPageCitation = {
          type: 'page',
          part: 'block',
          id: first.page_id,
          workspace_id: first.workspace_id,
          title: first.page_title,
          revision: first.page_revision,
          updated_at: updatedAt,
          block_id: block.block_id,
          block_revision: block.block_revision,
          block_type: block.block_type,
          block_position: block.block_position,
          char_start: chunk.start,
          char_end: chunk.end,
        };
        const payload: Record<string, unknown> = {
          ...basePayload,
          chunk_hash: chunkHash,
          citation,
          payload_version: PAYLOAD_VERSION,
          text: embedText,
        };
        points.push({
          id,
          chunk_hash: chunkHash,
          embed_text: embedText,
          fingerprint,
          text: embedText,
          tags: first.page_tags ?? [],
          importance: first.page_importance,
          workspace_id: first.workspace_id,
          source_type: 'page',
          session_id: first.session_id,
          database_id: null,
          citation,
          payload,
        });
      }
    }
  }
  return points;
}

function buildRowPoints(rows: RowSourceRow[]): CanonicalRagPoint[] {
  const byRow = new Map<string, RowSourceRow[]>();
  for (const row of rows) {
    const values = byRow.get(row.row_id) ?? [];
    values.push(row);
    byRow.set(row.row_id, values);
  }

  const points: CanonicalRagPoint[] = [];
  for (const rowEntries of byRow.values()) {
    const ordered = [...rowEntries].sort((left, right) => (
      left.property_position - right.property_position || left.property_id.localeCompare(right.property_id)
    ));
    const first = ordered[0]!;
    const titleEntry = ordered.find((entry) => entry.property_type === 'title');
    const title = titleEntry ? rowValue(titleEntry) : null;
    const displayTitle = title?.trim() || `Row ${first.row_id.slice(0, 8)}`;
    const fingerprint = sourceFingerprint({
      id: first.row_id,
      revision: first.row_revision,
      database: {
        id: first.database_id,
        name: normalizeText(first.database_name),
        description: first.database_description == null
          ? null
          : normalizeText(first.database_description),
        revision: first.database_revision,
      },
      properties: ordered.map((entry) => ({
        id: entry.property_id,
        name: normalizeText(entry.property_name),
        type: entry.property_type,
        position: entry.property_position,
        revision: entry.property_revision,
        value: rowValue(entry),
      })),
      tags: first.row_tags ?? [],
      importance: first.row_importance,
    });

    for (const entry of ordered) {
      const value = rowValue(entry);
      if (value === null || value.trim().length === 0) continue;
      const rendered = `${normalizeText(entry.property_name)}: ${value}`;
      for (const [chunkIndex, chunk] of splitText(rendered).entries()) {
        const id = deterministicPointId(
          `${first.workspace_id}:row:${first.row_id}:${entry.property_id}:${chunkIndex}`
        );
        const context = [
          chunk.text,
          `Row: ${displayTitle}`,
          `Database: ${normalizeText(first.database_name)}`,
          first.database_description?.trim()
            ? `Description: ${normalizeText(first.database_description).slice(0, 240)}`
            : null,
        ].filter((line): line is string => line !== null).join('\n');
        const chunkHash = digest(`${embeddingFingerprint()}\n${fingerprint}\n${context}`);
        const updatedAt = timestamp(first.row_updated_at);
        const citation: RagRowCitation = {
          type: 'row',
          id: first.row_id,
          workspace_id: first.workspace_id,
          database_id: first.database_id,
          database_name: first.database_name,
          database_description: first.database_description,
          title: displayTitle,
          revision: first.row_revision,
          updated_at: updatedAt,
          properties: [{ id: entry.property_id, name: entry.property_name }],
        };
        const payload: Record<string, unknown> = {
          record_type: 'chunk',
          workspace_id: first.workspace_id,
          source_type: 'row',
          source_id: first.row_id,
          database_id: first.database_id,
          fingerprint,
          chunk_hash: chunkHash,
          citation,
          payload_version: PAYLOAD_VERSION,
          text: context,
          tags: first.row_tags ?? [],
          importance: first.row_importance,
          updated_at: updatedAt,
        };
        points.push({
          id,
          chunk_hash: chunkHash,
          embed_text: context,
          fingerprint,
          text: context,
          tags: first.row_tags ?? [],
          importance: first.row_importance,
          workspace_id: first.workspace_id,
          source_type: 'row',
          session_id: null,
          database_id: first.database_id,
          citation,
          payload,
        });
      }
    }
  }
  return points;
}

async function queryCorpusRows(
  client: PoolClient,
  workspaceId: string,
  sources?: RagSourceSelection
): Promise<{ pages: PageSourceRow[]; rows: RowSourceRow[] }> {
  const pages = sources && sources.page_ids.length === 0
    ? []
    : (await client.query<PageSourceRow>(
      `SELECT p.id AS page_id,
              p.workspace_id,
              p.session_id,
              p.title AS page_title,
              p.tags AS page_tags,
              p.importance AS page_importance,
              p.revision AS page_revision,
              p.updated_at AS page_updated_at,
              b.id AS block_id,
              b.block_type,
              b.content AS block_content,
              b.position AS block_position,
              b.revision AS block_revision
       FROM pages p
       JOIN workspaces w ON w.id = p.workspace_id
       LEFT JOIN blocks b ON b.page_id = p.id AND b.archived_at IS NULL
       WHERE p.workspace_id = $1
         AND w.archived_at IS NULL
         AND p.archived_at IS NULL
         ${sources ? 'AND p.id = ANY($2::uuid[])' : ''}
       ORDER BY p.id, b.position, b.id`,
      sources ? [workspaceId, sources.page_ids] : [workspaceId]
    )).rows;
  const rows = sources && sources.row_ids.length === 0
    ? []
    : (await client.query<RowSourceRow>(
      `SELECT r.id AS row_id,
              d.workspace_id,
              d.id AS database_id,
              d.name AS database_name,
              d.description AS database_description,
              d.revision AS database_revision,
              r.tags AS row_tags,
              r.importance AS row_importance,
              r.revision AS row_revision,
              r.updated_at AS row_updated_at,
              p.id AS property_id,
              p.name AS property_name,
              p.property_type,
              p.position AS property_position,
              p.revision AS property_revision,
              v.value_text,
              v.value_number,
              v.value_date,
              v.value_bool,
              v.value_json
       FROM database_rows r
       JOIN databases d ON d.id = r.database_id
       JOIN workspaces w ON w.id = d.workspace_id
       JOIN database_properties p
         ON p.database_id = d.id
        AND p.archived_at IS NULL
       LEFT JOIN database_row_values v
         ON v.row_id = r.id
        AND v.property_id = p.id
       WHERE d.workspace_id = $1
         AND w.archived_at IS NULL
         AND d.archived_at IS NULL
         AND r.archived_at IS NULL
         ${sources ? 'AND r.id = ANY($2::uuid[])' : ''}
       ORDER BY r.id, p.position, p.id`,
      sources ? [workspaceId, sources.row_ids] : [workspaceId]
    )).rows;
  return { pages, rows };
}

async function generationFromClient(client: PoolClient, workspaceId: string): Promise<string> {
  const { rows } = await client.query<{ search_generation: string }>(
    `SELECT COUNT(c.change_id)::text AS search_generation
     FROM workspaces w
     LEFT JOIN workspace_search_changes c ON c.workspace_id = w.id
     WHERE w.id = $1
       AND w.archived_at IS NULL
     GROUP BY w.id`,
    [workspaceId]
  );
  if (!rows[0]) throw new Error(`Workspace ${workspaceId} does not exist or is archived`);
  return rows[0].search_generation;
}

export async function loadRagGeneration(workspaceId: string): Promise<string> {
  const contextualClient = ragClientContext.getStore();
  if (contextualClient) return generationFromClient(contextualClient, workspaceId);
  const client = await getPool().connect();
  try {
    return await generationFromClient(client, workspaceId);
  } finally {
    client.release();
  }
}

async function loadRagPointSnapshot(
  workspaceId: string,
  sources?: RagSourceSelection
): Promise<RagPointSnapshot> {
  const contextualClient = ragClientContext.getStore();
  const client = contextualClient ?? await getPool().connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    const generation = await generationFromClient(client, workspaceId);
    const sourceRows = await queryCorpusRows(client, workspaceId, sources);
    await client.query('COMMIT');
    transactionOpen = false;
    const points = [...buildPagePoints(sourceRows.pages), ...buildRowPoints(sourceRows.rows)]
      .sort((left, right) => left.id.localeCompare(right.id));
    return {
      generation,
      points,
    };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (!contextualClient) client.release();
  }
}

export async function loadRagCorpus(workspaceId: string): Promise<RagCorpus> {
  const snapshot = await loadRagPointSnapshot(workspaceId);
  return {
    ...snapshot,
    fingerprint: digest(
      snapshot.points.map((point) => `${point.id}:${point.chunk_hash}`).join('\n')
    ),
  };
}

export function loadRagPoints(
  workspaceId: string,
  sources: RagSourceSelection
): Promise<RagPointSnapshot> {
  return loadRagPointSnapshot(workspaceId, sources);
}

async function runWithRagWorkspaceLock<T>(
  workspaceId: string,
  work: () => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  const lockName = `horizonlayer-rag:${workspaceId}`;
  let acquired = false;
  let workError: unknown;
  let result: T | undefined;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, $2::bigint))', [
      lockName,
      INDEX_LOCK_SEED,
    ]);
    acquired = true;
    result = await ragClientContext.run(client, work);
  } catch (error) {
    workError = error;
  }

  let unlockError: Error | undefined;
  if (acquired) {
    try {
      const { rows } = await client.query<{ unlocked: boolean }>(
        `SELECT pg_advisory_unlock(
           hashtextextended($1, $2::bigint)
         ) AS unlocked`,
        [lockName, INDEX_LOCK_SEED]
      );
      if (!rows[0]?.unlocked) {
        throw new Error(`RAG workspace lock ${workspaceId} was not held at release`);
      }
    } catch (error) {
      unlockError = error instanceof Error ? error : new Error(String(error));
    }
  }

  const acquisitionError = !acquired && workError
    ? (workError instanceof Error ? workError : new Error(String(workError)))
    : undefined;
  client.release(unlockError ?? acquisitionError);
  if (workError && unlockError) {
    throw new AggregateError(
      [workError, unlockError],
      `RAG workspace work and lock release both failed for ${workspaceId}`
    );
  }
  if (workError) throw workError;
  if (unlockError) throw unlockError;
  return result as T;
}

export function withRagWorkspaceLock<T>(
  workspaceId: string,
  work: () => Promise<T>
): Promise<T> {
  const current = ragWorkspaceRebuilds.get(workspaceId);
  if (current) return current as Promise<T>;
  const pending = runWithRagWorkspaceLock(workspaceId, work).finally(() => {
    if (ragWorkspaceRebuilds.get(workspaceId) === pending) {
      ragWorkspaceRebuilds.delete(workspaceId);
    }
  });
  ragWorkspaceRebuilds.set(workspaceId, pending);
  return pending;
}

function currentPointMatches(
  stored: { payload: Record<string, unknown> } | undefined,
  desired: CanonicalRagPoint
): boolean {
  if (!stored) return false;
  const { index_generation: _generation, ...canonicalPayload } = stored.payload;
  return stableJson(canonicalPayload) === stableJson(desired.payload);
}

async function reconcileCorpus(
  workspaceId: string,
  corpus: RagCorpus,
  vectorStore: VectorStore,
  getEmbedder: () => Promise<EmbeddingProvider>
): Promise<void> {
  await vectorStore.ensureReady();
  const stored = await vectorStore.scrollWorkspace(workspaceId);
  const storedById = new Map(stored.map((point) => [String(point.id), point]));
  const desiredIds = new Set(corpus.points.map((point) => point.id));
  const changed = corpus.points.filter((point) => !currentPointMatches(storedById.get(point.id), point));

  if (changed.length > 0) {
    const embedder = await getEmbedder();
    for (let offset = 0; offset < changed.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = changed.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const vectors = await embedder.embed(batch.map((point) => point.embed_text));
      const updates: VectorPoint[] = batch.map((point, index) => ({
        id: point.id,
        vector: vectors[index]!,
        payload: point.payload,
      }));
      await vectorStore.upsert(updates);
    }
  }

  const stale = stored.filter((point) => !desiredIds.has(String(point.id))).map((point) => point.id);
  await vectorStore.deleteIds(stale);
}

interface RagIndexManifest {
  generation: string;
  point_count: number;
}

function readCurrentManifest(
  stored: { payload: Record<string, unknown> } | null,
  generation: string
): RagIndexManifest | null {
  const payload = stored?.payload;
  if (!payload
      || payload.record_type !== 'manifest'
      || payload.payload_version !== PAYLOAD_VERSION
      || payload.embedding_fingerprint !== embeddingFingerprint()
      || payload.index_generation !== generation
      || !Number.isInteger(payload.point_count)
      || (payload.point_count as number) < 0) {
    return null;
  }
  return { generation, point_count: payload.point_count as number };
}

function manifestVectorPoint(
  workspaceId: string,
  corpus: RagCorpus,
  vector: number[]
): VectorPoint {
  return {
    id: deterministicPointId(`${workspaceId}:manifest`),
    vector,
    payload: {
      record_type: 'manifest',
      workspace_id: workspaceId,
      index_generation: corpus.generation,
      corpus_fingerprint: corpus.fingerprint,
      embedding_fingerprint: embeddingFingerprint(),
      payload_version: PAYLOAD_VERSION,
      point_count: corpus.points.length,
    },
  };
}

function qdrantFilter(
  scope: ResolvedSearchScope,
  generation: string,
  tags: string[] | undefined,
  minImportance: number | undefined
): Record<string, unknown> {
  const must: Array<Record<string, unknown>> = [
    { key: 'workspace_id', match: { value: scope.workspace_id } },
    { key: 'record_type', match: { value: 'chunk' } },
    { key: 'index_generation', match: { value: generation } },
  ];
  if (scope.session_id) must.push({ key: 'session_id', match: { value: scope.session_id } });
  if (scope.database_id) must.push({ key: 'database_id', match: { value: scope.database_id } });
  if (scope.types.length === 1) {
    must.push({ key: 'source_type', match: { value: scope.types[0] } });
  }
  if (tags && tags.length > 0) must.push({ key: 'tags', match: { any: tags } });
  if (minImportance !== undefined) must.push({ key: 'importance', range: { gte: minImportance } });
  return { must };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function hitSources(hits: ScoredVectorPoint[]): RagSourceSelection {
  const pageIds = new Set<string>();
  const rowIds = new Set<string>();
  for (const { payload } of hits) {
    if (typeof payload.source_id !== 'string' || !UUID_PATTERN.test(payload.source_id)) continue;
    if (payload.source_type === 'page') pageIds.add(payload.source_id);
    if (payload.source_type === 'row') rowIds.add(payload.source_id);
  }
  return { page_ids: [...pageIds], row_ids: [...rowIds] };
}

function canonicalMatches(
  point: CanonicalRagPoint,
  scope: ResolvedSearchScope,
  tags: string[] | undefined,
  minImportance: number | undefined
): boolean {
  if (point.workspace_id !== scope.workspace_id || !scope.types.includes(point.source_type)) return false;
  if (scope.session_id !== null && point.session_id !== scope.session_id) return false;
  if (scope.database_id !== null && point.database_id !== scope.database_id) return false;
  if (tags && tags.length > 0 && !tags.some((tag) => point.tags.includes(tag))) return false;
  return minImportance === undefined || point.importance >= minImportance;
}

function indexedHitMatches(
  hit: ScoredVectorPoint,
  point: CanonicalRagPoint,
  generation: string
): boolean {
  const payload = hit.payload;
  const { index_generation: storedGeneration, ...canonicalPayload } = payload;
  return storedGeneration === generation
    && stableJson(canonicalPayload) === stableJson(point.payload);
}

function hydrateHits(
  hits: ScoredVectorPoint[],
  canonicalPoints: CanonicalRagPoint[],
  scope: ResolvedSearchScope,
  generation: string,
  tags: string[] | undefined,
  minImportance: number | undefined,
  limit: number
): { invalid: boolean; result: RagSearchResult } {
  const canonicalById = new Map(canonicalPoints.map((point) => [point.id, point]));
  const valid: Array<{
    citation: RagPageCitation | RagRowCitation;
    score: number;
    text: string;
  }> = [];
  const seen = new Set<string>();
  let invalid = false;
  for (const hit of hits) {
    const id = String(hit.id);
    if (seen.has(id)) continue;
    const point = canonicalById.get(id);
    if (!point || !indexedHitMatches(hit, point, generation)) {
      invalid = true;
      continue;
    }
    if (!canonicalMatches(point, scope, tags, minImportance)) {
      invalid = true;
      continue;
    }
    seen.add(id);
    valid.push({ citation: point.citation, score: hit.score, text: point.text });
  }

  return {
    invalid,
    result: {
      chunks: valid.slice(0, limit).map(({ citation, score, text }, index) => ({
        rank: index + 1,
        score,
        text,
        citation,
      })),
      truncated: valid.length > limit,
    },
  };
}

async function refreshRagIndex(
  workspaceId: string,
  dependencies: RagSearchDependencies,
  force = false
): Promise<RagIndexManifest | null> {
  return dependencies.withWorkspaceLock(workspaceId, async () => {
    const observedGeneration = await dependencies.loadGeneration(workspaceId);
    const storedManifest = await dependencies.vectorStore.getWorkspaceManifest(workspaceId);
    const current = readCurrentManifest(storedManifest, observedGeneration);
    if (!force && current && await dependencies.vectorStore.countWorkspace(
      workspaceId,
      current.generation
    ) === current.point_count) return current;

    const corpus = await dependencies.loadCorpus(workspaceId);
    await reconcileCorpus(
      workspaceId,
      corpus,
      dependencies.vectorStore,
      dependencies.getEmbeddingProvider
    );
    const embedder = await dependencies.getEmbeddingProvider();
    const [manifestVector] = await embedder.embed([MANIFEST_EMBED_TEXT]);
    if (!manifestVector) throw new Error('Embedding provider did not return a manifest vector');
    if (await dependencies.loadGeneration(workspaceId) !== corpus.generation) return null;

    await dependencies.vectorStore.setWorkspaceGeneration(
      workspaceId,
      corpus.generation,
      corpus.points.length
    );
    await dependencies.vectorStore.upsert([
      manifestVectorPoint(workspaceId, corpus, manifestVector),
    ]);
    const publishedCount = await dependencies.vectorStore.countWorkspace(
      workspaceId,
      corpus.generation
    );
    if (publishedCount !== corpus.points.length) {
      await dependencies.vectorStore.deleteIds([
        deterministicPointId(`${workspaceId}:manifest`),
      ]);
      throw new DependencyUnavailableError(
        'qdrant',
        `RAG manifest publication expected ${corpus.points.length} chunks but found ${publishedCount}`,
        { retryable: true }
      );
    }
    if (await dependencies.loadGeneration(workspaceId) !== corpus.generation) return null;
    return { generation: corpus.generation, point_count: corpus.points.length };
  });
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('RAG limit must be an integer between 1 and 20');
  }
  return limit;
}

function normalizeImportance(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('min_importance must be a number between 0 and 1');
  }
  return value;
}

export async function searchRagWithDependencies(
  params: {
    query: string;
    scope: ResolvedSearchScope;
    tags?: string[];
    min_importance?: number;
    limit?: number;
  },
  dependencies: RagSearchDependencies
): Promise<RagSearchResult> {
  const query = normalizeText(params.query).trim();
  if (!query) throw new Error('query cannot be empty');
  if (query.length > 1_000) throw new Error('query cannot exceed 1000 characters');
  const limit = normalizeLimit(params.limit);
  const minImportance = normalizeImportance(params.min_importance);

  let queryVector: number[] | null = null;
  const getQueryVector = async (): Promise<number[]> => {
    if (queryVector) return queryVector;
    const embedder = await dependencies.getEmbeddingProvider();
    const [embedded] = await embedder.embed([query]);
    if (!embedded) throw new Error('Embedding provider did not return a query vector');
    queryVector = embedded;
    return embedded;
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observedGeneration = await dependencies.loadGeneration(params.scope.workspace_id);
    const storedManifest = await dependencies.vectorStore.getWorkspaceManifest(
      params.scope.workspace_id
    );
    let manifest = readCurrentManifest(storedManifest, observedGeneration);
    let forceRefresh = false;
    if (manifest?.point_count === 0 && await dependencies.vectorStore.countWorkspace(
      params.scope.workspace_id,
      manifest.generation
    ) !== 0) {
      manifest = null;
      forceRefresh = true;
    }
    manifest ??= await refreshRagIndex(
      params.scope.workspace_id,
      dependencies,
      forceRefresh
    );
    if (!manifest) continue;

    if (manifest.point_count === 0) {
      if (await dependencies.loadGeneration(params.scope.workspace_id) === manifest.generation) {
        return { chunks: [], truncated: false };
      }
      continue;
    }

    const vector = await getQueryVector();
    const candidateLimit = Math.min(200, (limit + 1) * 5);
    const hits = await dependencies.vectorStore.query(
      vector,
      qdrantFilter(params.scope, manifest.generation, params.tags, minImportance),
      candidateLimit
    );
    if (await dependencies.vectorStore.countWorkspace(
      params.scope.workspace_id,
      manifest.generation
    ) !== manifest.point_count) {
      await refreshRagIndex(params.scope.workspace_id, dependencies, true);
      continue;
    }
    const canonical = await dependencies.loadPoints(
      params.scope.workspace_id,
      hitSources(hits)
    );
    if (canonical.generation !== manifest.generation
        || await dependencies.loadGeneration(params.scope.workspace_id) !== manifest.generation) {
      continue;
    }
    const hydrated = hydrateHits(
      hits,
      canonical.points,
      params.scope,
      manifest.generation,
      params.tags,
      minImportance,
      limit
    );
    if (hydrated.invalid) {
      await refreshRagIndex(params.scope.workspace_id, dependencies, true);
      continue;
    }
    return hydrated.result;
  }

  throw new DependencyUnavailableError(
    'rag',
    'RAG index could not reach a stable snapshot because workspace content kept changing',
    { retryable: true }
  );
}

export async function searchRag(params: {
  query: string;
  scope: ResolvedSearchScope;
  tags?: string[];
  min_importance?: number;
  limit?: number;
}): Promise<RagSearchResult> {
  if (!config.rag.enabled) {
    throw new DependencyUnavailableError(
      'rag',
      'RAG search is disabled; set RAG_ENABLED=true and configure QDRANT_URL, or run `horizonlayer setup` for the managed local runtime',
      { retryable: false }
    );
  }
  return searchRagWithDependencies(params, {
    getEmbeddingProvider,
    loadGeneration: loadRagGeneration,
    loadCorpus: loadRagCorpus,
    loadPoints: loadRagPoints,
    vectorStore: getVectorStore(),
    withWorkspaceLock: withRagWorkspaceLock,
  });
}

export const ragInternals = {
  buildPagePoints,
  buildRowPoints,
  deterministicPointId,
  embeddingFingerprint,
  normalizeText,
  runWithRagWorkspaceLock,
  splitText,
  stableJson,
};
