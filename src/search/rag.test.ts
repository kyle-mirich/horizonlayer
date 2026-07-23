import { describe, expect, it, vi } from 'vitest';

import type { ResolvedSearchScope } from '../db/queries/search.js';
import type { EmbeddingProvider } from './embedder.js';
import {
  ragInternals,
  searchRag,
  searchRagWithDependencies,
  type CanonicalRagPoint,
  type RagCorpus,
  type RagSearchDependencies,
} from './rag.js';
import type { VectorStore } from './qdrant.js';

const scope: ResolvedSearchScope = {
  kind: 'workspace',
  workspace_id: '10000000-0000-4000-8000-000000000001',
  types: ['page', 'row'],
  session_id: null,
  database_id: null,
};

function canonicalPoint(): CanonicalRagPoint {
  const id = '20000000-0000-4000-8000-000000000001';
  const citation = {
    type: 'page' as const,
    part: 'title' as const,
    id: '30000000-0000-4000-8000-000000000001',
    workspace_id: scope.workspace_id,
    title: 'Durable agent knowledge',
    revision: 2,
    updated_at: '2026-07-16T00:00:00.000Z',
  };
  return {
    id,
    chunk_hash: 'chunk-hash',
    embed_text: 'Durable agent knowledge',
    fingerprint: 'source-fingerprint',
    text: 'Durable agent knowledge',
    tags: ['agents'],
    importance: 0.8,
    workspace_id: scope.workspace_id,
    source_type: 'page',
    session_id: null,
    database_id: null,
    citation,
    payload: {
      record_type: 'chunk',
      workspace_id: scope.workspace_id,
      source_type: 'page',
      source_id: '30000000-0000-4000-8000-000000000001',
      chunk_hash: 'chunk-hash',
      fingerprint: 'source-fingerprint',
      tags: ['agents'],
      importance: 0.8,
      citation,
      payload_version: 1,
      text: 'Durable agent knowledge',
    },
  };
}

function dependencies(params: {
  corpus: RagCorpus;
  stored?: Array<{ id: string; payload: Record<string, unknown> }>;
  manifest?: { id: string; payload: Record<string, unknown> } | null;
  hits?: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
  generation?: string;
  count?: number;
}): {
  dependencies: RagSearchDependencies;
  embed: ReturnType<typeof vi.fn>;
  store: VectorStore;
} {
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [0.5, 0.5]));
  const store: VectorStore = {
    ensureReady: vi.fn(async () => undefined),
    countWorkspace: vi.fn(async () => params.count ?? params.corpus.points.length),
    getWorkspaceManifest: vi.fn(async () => params.manifest ?? null),
    scrollWorkspace: vi.fn(async () => params.stored ?? []),
    setWorkspaceGeneration: vi.fn(async () => undefined),
    upsert: vi.fn(async () => undefined),
    deleteIds: vi.fn(async () => undefined),
    query: vi.fn(async () => params.hits ?? []),
  };
  const provider: EmbeddingProvider = { embed };
  return {
    dependencies: {
      getEmbeddingProvider: vi.fn(async () => provider),
      loadGeneration: vi.fn(async () => params.generation ?? params.corpus.generation),
      loadCorpus: vi.fn(async () => params.corpus),
      loadPoints: vi.fn(async () => ({
        generation: params.generation ?? params.corpus.generation,
        points: params.corpus.points,
      })),
      vectorStore: store,
      withWorkspaceLock: vi.fn(async (_workspaceId, work) => work()),
    },
    embed,
    store,
  };
}

describe('RAG search orchestration', () => {
  it('reconciles deterministic chunks, removes stale points, and returns canonical citations', async () => {
    const point = canonicalPoint();
    const corpus = { generation: '7', fingerprint: 'corpus', points: [point] };
    const setup = dependencies({
      corpus,
      stored: [{ id: 'stale', payload: {} }],
      hits: [{
        id: point.id,
        score: 0.91,
        payload: { ...point.payload, index_generation: '7' },
      }],
    });

    await expect(searchRagWithDependencies({
      query: 'persistent memory',
      scope,
      tags: ['agents'],
      min_importance: 0.5,
      limit: 1,
    }, setup.dependencies)).resolves.toEqual({
      chunks: [{
        rank: 1,
        score: 0.91,
        text: point.text,
        citation: point.citation,
      }],
      truncated: false,
    });

    expect(setup.store.upsert).toHaveBeenNthCalledWith(1, [{
      id: point.id,
      vector: [0.5, 0.5],
      payload: point.payload,
    }]);
    expect(setup.store.upsert).toHaveBeenNthCalledWith(2, [expect.objectContaining({
      payload: expect.objectContaining({
        record_type: 'manifest',
        index_generation: '7',
        point_count: 1,
      }),
      vector: [0.5, 0.5],
    })]);
    expect(setup.store.setWorkspaceGeneration).toHaveBeenCalledWith(scope.workspace_id, '7', 1);
    expect(setup.store.deleteIds).toHaveBeenCalledWith(['stale']);
    expect(setup.embed).toHaveBeenCalledTimes(3);
    expect(setup.store.query).toHaveBeenCalledWith(
      [0.5, 0.5],
      expect.objectContaining({ must: expect.arrayContaining([
        { key: 'workspace_id', match: { value: scope.workspace_id } },
        { key: 'record_type', match: { value: 'chunk' } },
        { key: 'index_generation', match: { value: '7' } },
        { key: 'tags', match: { any: ['agents'] } },
        { key: 'importance', range: { gte: 0.5 } },
      ]) }),
      10
    );
  });

  it('cleans a stale workspace index when the canonical corpus becomes empty', async () => {
    const corpus = { generation: '8', fingerprint: 'empty', points: [] };
    const setup = dependencies({
      corpus,
      stored: [{ id: 'stale', payload: { workspace_id: scope.workspace_id } }],
    });

    await expect(searchRagWithDependencies({ query: 'anything', scope }, setup.dependencies))
      .resolves.toEqual({ chunks: [], truncated: false });
    expect(setup.store.deleteIds).toHaveBeenCalledWith(['stale']);
    expect(setup.embed).toHaveBeenCalledOnce();
    expect(setup.store.query).not.toHaveBeenCalled();
    expect(setup.store.upsert).toHaveBeenCalledWith([expect.objectContaining({
      payload: expect.objectContaining({ point_count: 0 }),
    })]);
  });

  it('uses the persisted generation manifest without rescanning an unchanged workspace', async () => {
    const point = canonicalPoint();
    const setup = dependencies({
      corpus: { generation: '9', fingerprint: 'unused', points: [point] },
      manifest: {
        id: 'manifest',
        payload: {
          record_type: 'manifest',
          payload_version: 1,
          embedding_fingerprint: ragInternals.embeddingFingerprint(),
          index_generation: '9',
          point_count: 1,
        },
      },
      hits: [{
        id: point.id,
        score: 0.75,
        payload: { ...point.payload, index_generation: '9' },
      }],
    });

    await expect(searchRagWithDependencies({ query: 'durable memory', scope }, setup.dependencies))
      .resolves.toMatchObject({ chunks: [{ text: point.text }], truncated: false });
    expect(setup.dependencies.loadCorpus).not.toHaveBeenCalled();
    expect(setup.store.scrollWorkspace).not.toHaveBeenCalled();
    expect(setup.store.upsert).not.toHaveBeenCalled();
    expect(setup.store.setWorkspaceGeneration).not.toHaveBeenCalled();
    expect(setup.embed).toHaveBeenCalledOnce();
    expect(setup.dependencies.withWorkspaceLock).not.toHaveBeenCalled();
  });

  it('returns an unchanged empty manifest without loading the model or corpus', async () => {
    const setup = dependencies({
      corpus: { generation: '10', fingerprint: 'unused', points: [] },
      manifest: {
        id: 'manifest',
        payload: {
          record_type: 'manifest',
          payload_version: 1,
          embedding_fingerprint: ragInternals.embeddingFingerprint(),
          index_generation: '10',
          point_count: 0,
        },
      },
    });

    await expect(searchRagWithDependencies({ query: 'anything', scope }, setup.dependencies))
      .resolves.toEqual({ chunks: [], truncated: false });
    expect(setup.dependencies.loadCorpus).not.toHaveBeenCalled();
    expect(setup.embed).not.toHaveBeenCalled();
    expect(setup.dependencies.withWorkspaceLock).not.toHaveBeenCalled();
  });

  it('never returns tampered Qdrant evidence and repairs it from PostgreSQL', async () => {
    const point = canonicalPoint();
    const validHit = {
      id: point.id,
      score: 0.88,
      payload: { ...point.payload, index_generation: '11' },
    };
    const setup = dependencies({
      corpus: { generation: '11', fingerprint: 'canonical', points: [point] },
      manifest: {
        id: 'manifest',
        payload: {
          record_type: 'manifest',
          payload_version: 1,
          embedding_fingerprint: ragInternals.embeddingFingerprint(),
          index_generation: '11',
          point_count: 1,
        },
      },
      stored: [{
        id: point.id,
        payload: { ...validHit.payload, text: 'FORGED EVIDENCE' },
      }],
    });
    vi.mocked(setup.store.query)
      .mockResolvedValueOnce([{
        ...validHit,
        payload: { ...validHit.payload, text: 'FORGED EVIDENCE' },
      }])
      .mockResolvedValue([validHit]);

    await expect(searchRagWithDependencies({ query: 'durable memory', scope }, setup.dependencies))
      .resolves.toMatchObject({
        chunks: [{ text: 'Durable agent knowledge', citation: point.citation }],
      });
    expect(setup.dependencies.loadCorpus).toHaveBeenCalledOnce();
    expect(setup.store.upsert).toHaveBeenCalledWith([{
      id: point.id,
      vector: [0.5, 0.5],
      payload: point.payload,
    }]);
  });

  it('rebuilds after a non-empty manifest loses its indexed chunks', async () => {
    const point = canonicalPoint();
    const validHit = {
      id: point.id,
      score: 0.82,
      payload: { ...point.payload, index_generation: '12' },
    };
    const setup = dependencies({
      corpus: { generation: '12', fingerprint: 'canonical', points: [point] },
      manifest: {
        id: 'manifest',
        payload: {
          record_type: 'manifest',
          payload_version: 1,
          embedding_fingerprint: ragInternals.embeddingFingerprint(),
          index_generation: '12',
          point_count: 1,
        },
      },
    });
    vi.mocked(setup.store.query)
      .mockResolvedValueOnce([])
      .mockResolvedValue([validHit]);
    vi.mocked(setup.store.countWorkspace)
      .mockResolvedValueOnce(0)
      .mockResolvedValue(1);

    await expect(searchRagWithDependencies({ query: 'durable memory', scope }, setup.dependencies))
      .resolves.toMatchObject({ chunks: [{ text: point.text }] });
    expect(setup.dependencies.loadCorpus).toHaveBeenCalledOnce();
    expect(setup.store.query).toHaveBeenCalledTimes(2);
    expect(setup.store.setWorkspaceGeneration).toHaveBeenCalledWith(scope.workspace_id, '12', 1);
  });

  it('rejects RAG explicitly while the optional subsystem is disabled', async () => {
    await expect(searchRag({ query: 'anything', scope })).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      dependency: 'rag',
      retryable: false,
    });
  });
});

describe('RAG canonical chunk construction', () => {
  it('indexes a title-only page with an honest title citation', () => {
    const [point] = ragInternals.buildPagePoints([{
      page_id: '30000000-0000-4000-8000-000000000001',
      workspace_id: scope.workspace_id,
      session_id: null,
      page_title: 'Only a title',
      page_tags: [],
      page_importance: 0.5,
      page_revision: 1,
      page_updated_at: new Date('2026-07-16T00:00:00.000Z'),
      block_id: null,
      block_type: null,
      block_content: null,
      block_position: null,
      block_revision: null,
    }]);

    expect(point?.text).toBe('Only a title');
    expect(point?.citation).toMatchObject({ type: 'page', part: 'title' });
  });

  it('keeps block citation offsets against the unmodified canonical text', () => {
    const canonical = 'Cafe\u0301\r\nkeeps exact offsets';
    const points = ragInternals.buildPagePoints([{
      page_id: '30000000-0000-4000-8000-000000000001',
      workspace_id: scope.workspace_id,
      session_id: null,
      page_title: 'Offsets',
      page_tags: [],
      page_importance: 0.5,
      page_revision: 1,
      page_updated_at: '2026-07-16T00:00:00.000Z',
      block_id: '40000000-0000-4000-8000-000000000001',
      block_type: 'text',
      block_content: canonical,
      block_position: 0,
      block_revision: 1,
    }]);
    const block = points.find((point) => point.citation.type === 'page'
      && point.citation.part === 'block')!;
    const citation = block.citation.type === 'page' && block.citation.part === 'block'
      ? block.citation
      : null;

    expect(citation).not.toBeNull();
    expect(canonical.slice(citation!.char_start, citation!.char_end))
      .toBe(block.text.split('\nPage: ')[0]);
    expect(block.text).toBe(block.embed_text);
    expect(block.text).toContain('\nPage: Offsets');
  });

  it('returns every row context field that can influence vector ranking', () => {
    const [point] = ragInternals.buildRowPoints([{
      row_id: '50000000-0000-4000-8000-000000000001',
      workspace_id: scope.workspace_id,
      database_id: '60000000-0000-4000-8000-000000000001',
      database_name: 'Decisions',
      database_description: 'Durable architecture choices',
      database_revision: 2,
      row_tags: ['architecture'],
      row_importance: 0.9,
      row_revision: 3,
      row_updated_at: '2026-07-16T00:00:00.000Z',
      property_id: '70000000-0000-4000-8000-000000000001',
      property_name: 'Name',
      property_type: 'title',
      property_position: 0,
      property_revision: 1,
      value_text: 'Use local embeddings',
      value_number: null,
      value_date: null,
      value_bool: null,
      value_json: null,
    }]);

    expect(point?.text).toBe(point?.embed_text);
    expect(point?.text).toBe(
      'Name: Use local embeddings\nRow: Use local embeddings\nDatabase: Decisions\nDescription: Durable architecture choices'
    );
    expect(point?.citation).toMatchObject({
      type: 'row',
      database_name: 'Decisions',
      database_description: 'Durable architecture choices',
      properties: [{ name: 'Name' }],
    });
  });

  it('uses stable Qdrant-compatible UUID point IDs', () => {
    const first = ragInternals.deterministicPointId('same-source');
    expect(ragInternals.deterministicPointId('same-source')).toBe(first);
    expect(ragInternals.deterministicPointId('other-source')).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});
