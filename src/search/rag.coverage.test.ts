import { describe, expect, it, vi } from 'vitest';

import type { ResolvedSearchScope } from '../db/queries/search.js';
import type { EmbeddingProvider } from './embedder.js';
import { DependencyUnavailableError } from './errors.js';
import {
  ragInternals,
  searchRagWithDependencies,
  type CanonicalRagPoint,
  type RagCorpus,
  type RagSearchDependencies,
} from './rag.js';
import type { VectorStore } from './qdrant.js';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const scope: ResolvedSearchScope = {
  kind: 'workspace',
  workspace_id: workspaceId,
  types: ['page', 'row'],
  session_id: null,
  database_id: null,
};

function point(overrides: Partial<CanonicalRagPoint> = {}): CanonicalRagPoint {
  const citation = {
    type: 'page' as const,
    part: 'title' as const,
    id: '30000000-0000-4000-8000-000000000001',
    workspace_id: workspaceId,
    title: 'Point title',
    revision: 1,
    updated_at: '2026-07-16T00:00:00.000Z',
  };
  const base: CanonicalRagPoint = {
    id: '20000000-0000-4000-8000-000000000001',
    chunk_hash: 'chunk',
    embed_text: 'Point text',
    fingerprint: 'fingerprint',
    text: 'Point text',
    tags: ['agents'],
    importance: 0.8,
    workspace_id: workspaceId,
    source_type: 'page',
    session_id: null,
    database_id: null,
    citation,
    payload: {
      record_type: 'chunk',
      workspace_id: workspaceId,
      source_type: 'page',
      source_id: citation.id,
      chunk_hash: 'chunk',
      fingerprint: 'fingerprint',
      tags: ['agents'],
      importance: 0.8,
      citation,
      payload_version: 1,
      text: 'Point text',
    },
  };
  return { ...base, ...overrides };
}

function manifest(generation: string, pointCount: number): { id: string; payload: Record<string, unknown> } {
  return {
    id: 'manifest',
    payload: {
      record_type: 'manifest',
      payload_version: 1,
      embedding_fingerprint: ragInternals.embeddingFingerprint(),
      index_generation: generation,
      point_count: pointCount,
    },
  };
}

function setup(params: {
  corpus?: RagCorpus;
  generation?: string;
  hits?: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
  stored?: Array<{ id: string; payload: Record<string, unknown> }>;
  storedManifest?: { id: string; payload: Record<string, unknown> } | null;
  points?: CanonicalRagPoint[];
  count?: number;
  embed?: (texts: string[]) => Promise<number[][]>;
} = {}) {
  const canonical = params.points ?? [point()];
  const corpus = params.corpus ?? {
    generation: params.generation ?? '1',
    fingerprint: 'corpus',
    points: canonical,
  };
  const generation = params.generation ?? corpus.generation;
  const embed = vi.fn(params.embed ?? (async (texts: string[]) => texts.map(() => [0.4, 0.6])));
  const provider: EmbeddingProvider = { embed };
  const store = {
    ensureReady: vi.fn(async () => undefined),
    countWorkspace: vi.fn(async () => params.count ?? corpus.points.length),
    getWorkspaceManifest: vi.fn(async () => params.storedManifest ?? null),
    scrollWorkspace: vi.fn(async () => params.stored ?? []),
    setWorkspaceGeneration: vi.fn(async () => undefined),
    upsert: vi.fn(async () => undefined),
    deleteIds: vi.fn(async () => undefined),
    query: vi.fn(async () => params.hits ?? []),
  } satisfies VectorStore;
  const dependencies = {
    getEmbeddingProvider: vi.fn(async () => provider),
    loadGeneration: vi.fn(async () => generation),
    loadCorpus: vi.fn(async () => corpus),
    loadPoints: vi.fn(async () => ({ generation, points: canonical })),
    vectorStore: store,
    withWorkspaceLock: vi.fn(async (_workspaceId: string, work: () => Promise<unknown>) => work()),
  } as RagSearchDependencies;
  return { corpus, dependencies, embed, store };
}

function indexed(pointToIndex: CanonicalRagPoint, generation: string, score = 0.9) {
  return {
    id: pointToIndex.id,
    score,
    payload: { ...pointToIndex.payload, index_generation: generation },
  };
}

describe('RAG coverage cases: canonical corpus construction', () => {
  it('normalizes and chunks canonical page text without losing source offsets', () => {
    const longText = `${'prefix '.repeat(130)}needle ${'suffix '.repeat(25)}`;
    const points = ragInternals.buildPagePoints([
      {
        page_id: '30000000-0000-4000-8000-000000000001',
        workspace_id: workspaceId,
        session_id: '40000000-0000-4000-8000-000000000001',
        page_title: 'Session page',
        page_tags: null,
        page_importance: 0.7,
        page_revision: 3,
        page_updated_at: '2026-07-16T00:00:00.000Z',
        block_id: '50000000-0000-4000-8000-000000000002',
        block_type: 'text',
        block_content: '   ignored whitespace   ',
        block_position: 2,
        block_revision: 1,
      },
      {
        page_id: '30000000-0000-4000-8000-000000000001',
        workspace_id: workspaceId,
        session_id: '40000000-0000-4000-8000-000000000001',
        page_title: 'Session page',
        page_tags: null,
        page_importance: 0.7,
        page_revision: 3,
        page_updated_at: new Date('2026-07-16T00:00:00.000Z'),
        block_id: '50000000-0000-4000-8000-000000000001',
        block_type: 'code',
        block_content: longText,
        block_position: 1,
        block_revision: 2,
      },
      {
        page_id: '30000000-0000-4000-8000-000000000001',
        workspace_id: workspaceId,
        session_id: '40000000-0000-4000-8000-000000000001',
        page_title: 'Session page',
        page_tags: null,
        page_importance: 0.7,
        page_revision: 3,
        page_updated_at: '2026-07-16T00:00:00.000Z',
        block_id: null,
        block_type: null,
        block_content: null,
        block_position: null,
        block_revision: null,
      },
    ]);

    expect(points[0]).toMatchObject({
      source_type: 'page',
      session_id: '40000000-0000-4000-8000-000000000001',
      tags: [],
      citation: { part: 'title' },
    });
    const chunks = points.filter((candidate) => candidate.citation.type === 'page'
      && candidate.citation.part === 'block');
    expect(chunks.length).toBeGreaterThan(1);
    const firstChunk = chunks[0]!;
    expect(firstChunk.text).toContain('Page: Session page');
    expect(firstChunk.payload).toMatchObject({ session_id: '40000000-0000-4000-8000-000000000001' });
    expect(ragInternals.splitText('   \n\t')).toEqual([]);
    expect(ragInternals.normalizeText('Cafe\u0301\r\nnext\rline')).toBe('Café\nnext\nline');
    expect(ragInternals.stableJson({ z: [2, { b: 1, a: 2 }], a: true }))
      .toBe('{"a":true,"z":[2,{"a":2,"b":1}]}');
  });

  it('renders every typed row value and skips empty row values', () => {
    const rowBase = {
      row_id: '60000000-0000-4000-8000-000000000001',
      workspace_id: workspaceId,
      database_id: '70000000-0000-4000-8000-000000000001',
      database_name: '  Decisions\r\n',
      database_description: '   ',
      database_revision: 2,
      row_tags: null,
      row_importance: 0.4,
      row_revision: 4,
      row_updated_at: new Date('2026-07-17T00:00:00.000Z'),
    };
    const entries = [
      { property_id: '1', property_name: 'Title', property_type: 'title', property_position: 0, value_text: ' ', value_number: null, value_date: null, value_bool: null, value_json: null },
      { property_id: '2', property_name: 'Number', property_type: 'number', property_position: 1, value_text: null, value_number: 42, value_date: null, value_bool: null, value_json: null },
      { property_id: '3', property_name: 'Date', property_type: 'date', property_position: 2, value_text: null, value_number: null, value_date: '2026-07-18T00:00:00.000Z', value_bool: null, value_json: null },
      { property_id: '4', property_name: 'True', property_type: 'checkbox', property_position: 3, value_text: null, value_number: null, value_date: null, value_bool: true, value_json: null },
      { property_id: '5', property_name: 'False', property_type: 'checkbox', property_position: 4, value_text: null, value_number: null, value_date: null, value_bool: false, value_json: null },
      { property_id: '6', property_name: 'JSON', property_type: 'multi_select', property_position: 5, value_text: null, value_number: null, value_date: null, value_bool: null, value_json: { z: 1, a: ['x'] } },
      { property_id: '7', property_name: 'Empty', property_type: 'text', property_position: 6, value_text: null, value_number: null, value_date: null, value_bool: null, value_json: null },
    ].map((entry) => ({ ...rowBase, ...entry, property_revision: 1 }));

    const points = ragInternals.buildRowPoints(entries);
    expect(points).toHaveLength(5);
    expect(points.every((candidate) => candidate.citation.type === 'row'
      && candidate.citation.title === 'Row 60000000')).toBe(true);
    expect(points.map((candidate) => candidate.text)).toEqual(expect.arrayContaining([
      expect.stringContaining('Number: 42'),
      expect.stringContaining('Date: 2026-07-18T00:00:00.000Z'),
      expect.stringContaining('True: true'),
      expect.stringContaining('False: false'),
      expect.stringContaining('JSON: {"a":["x"],"z":1}'),
    ]));
    expect(points[0]?.payload).not.toHaveProperty('session_id');
  });

  it('handles unbroken text, deterministic tie ordering, and invalid source timestamps', () => {
    expect(ragInternals.splitText('x'.repeat(1_000))).toHaveLength(2);
    const tied = ragInternals.buildPagePoints([
      {
        page_id: '30000000-0000-4000-8000-000000000002', workspace_id: workspaceId,
        session_id: null, page_title: 'Ties', page_tags: [], page_importance: 0.5, page_revision: 1,
        page_updated_at: '2026-07-16T00:00:00.000Z', block_id: 'z-block', block_type: 'text',
        block_content: 'z', block_position: 1, block_revision: 1,
      },
      {
        page_id: '30000000-0000-4000-8000-000000000002', workspace_id: workspaceId,
        session_id: null, page_title: 'Ties', page_tags: [], page_importance: 0.5, page_revision: 1,
        page_updated_at: '2026-07-16T00:00:00.000Z', block_id: 'a-block', block_type: 'text',
        block_content: 'a', block_position: 1, block_revision: 1,
      },
    ]).filter((candidate) => candidate.citation.type === 'page' && candidate.citation.part === 'block');
    expect(tied.map((candidate) => candidate.citation.type === 'page' && candidate.citation.part === 'block'
      ? candidate.citation.block_id : null)).toEqual(['a-block', 'z-block']);

    expect(() => ragInternals.buildRowPoints([{
      row_id: '60000000-0000-4000-8000-000000000002', workspace_id: workspaceId,
      database_id: '70000000-0000-4000-8000-000000000002', database_name: 'Records', database_description: null,
      database_revision: 1, row_tags: [], row_importance: 0.5, row_revision: 1, row_updated_at: 'not-a-date',
      property_id: 'property-a', property_name: 'A', property_type: 'text', property_position: 1,
      property_revision: 1, value_text: 'value', value_number: null, value_date: null, value_bool: null, value_json: null,
    }])).toThrow('Search source contained an invalid timestamp');
  });
});

describe('RAG coverage cases: search stability and validation', () => {
  it('rejects invalid query parameters before touching dependencies', async () => {
    const configured = setup();
    await expect(searchRagWithDependencies({ query: ' \r\n ', scope }, configured.dependencies))
      .rejects.toThrow('query cannot be empty');
    await expect(searchRagWithDependencies({ query: 'x'.repeat(1_001), scope }, configured.dependencies))
      .rejects.toThrow('query cannot exceed 1000 characters');
    await expect(searchRagWithDependencies({ query: 'x', scope, limit: 0 }, configured.dependencies))
      .rejects.toThrow('RAG limit must be an integer between 1 and 20');
    await expect(searchRagWithDependencies({ query: 'x', scope, min_importance: 2 }, configured.dependencies))
      .rejects.toThrow('min_importance must be a number between 0 and 1');
    expect(configured.dependencies.loadGeneration).not.toHaveBeenCalled();
  });

  it('uses scoped vector filters and discards duplicate hits without rebuilding', async () => {
    const sessionId = '40000000-0000-4000-8000-000000000001';
    const scopedPoint = point({
      session_id: sessionId,
      payload: {
        ...point().payload,
        session_id: sessionId,
      },
    });
    const configured = setup({
      generation: '2',
      points: [scopedPoint],
      storedManifest: manifest('2', 1),
      hits: [indexed(scopedPoint, '2'), indexed(scopedPoint, '2', 0.7)],
    });
    const pageScope: ResolvedSearchScope = {
      ...scope,
      types: ['page'],
      session_id: sessionId,
    };

    await expect(searchRagWithDependencies({
      query: 'scoped search',
      scope: pageScope,
      tags: ['agents'],
      min_importance: 0.5,
      limit: 1,
    }, configured.dependencies)).resolves.toMatchObject({
      chunks: [{ rank: 1, score: 0.9, text: 'Point text' }],
      truncated: false,
    });
    expect(configured.store.query).toHaveBeenCalledWith([0.4, 0.6], {
      must: expect.arrayContaining([
        { key: 'session_id', match: { value: sessionId } },
        { key: 'source_type', match: { value: 'page' } },
        { key: 'tags', match: { any: ['agents'] } },
        { key: 'importance', range: { gte: 0.5 } },
      ]),
    }, 10);
    expect(configured.dependencies.loadCorpus).not.toHaveBeenCalled();
  });

  it('filters row hits by database scope and hydrates their canonical citation', async () => {
    const databaseId = '40000000-0000-4000-8000-000000000002';
    const rowId = '30000000-0000-4000-8000-000000000002';
    const rowCitation = {
      type: 'row' as const,
      id: rowId,
      workspace_id: workspaceId,
      database_id: databaseId,
      database_name: 'Decisions',
      database_description: null,
      title: 'Row title',
      revision: 1,
      updated_at: '2026-07-16T00:00:00.000Z',
      properties: [],
    };
    const rowPoint = point({
      id: '20000000-0000-4000-8000-000000000002',
      source_type: 'row',
      database_id: databaseId,
      citation: rowCitation,
      payload: {
        ...point().payload,
        source_type: 'row',
        source_id: rowId,
        database_id: databaseId,
        citation: rowCitation,
      },
    });
    const configured = setup({
      generation: '2-row', points: [rowPoint], storedManifest: manifest('2-row', 1),
      hits: [indexed(rowPoint, '2-row')],
    });
    const rowScope: ResolvedSearchScope = {
      ...scope, types: ['row'], database_id: databaseId,
    };

    await expect(searchRagWithDependencies({ query: 'row', scope: rowScope }, configured.dependencies))
      .resolves.toMatchObject({ chunks: [{ citation: rowCitation }] });
    expect(configured.store.query).toHaveBeenCalledWith(expect.anything(), {
      must: expect.arrayContaining([
        { key: 'database_id', match: { value: databaseId } },
        { key: 'source_type', match: { value: 'row' } },
      ]),
    }, expect.any(Number));
  });

  it('rebuilds a corrupt hit then returns only PostgreSQL-canonical evidence', async () => {
    const canonical = point();
    const configured = setup({
      generation: '3',
      points: [canonical],
      storedManifest: manifest('3', 1),
    });
    vi.mocked(configured.store.query)
      .mockResolvedValueOnce([{ id: 'forged', score: 0.99, payload: { source_id: 'not-a-uuid' } }])
      .mockResolvedValueOnce([indexed(canonical, '3')]);

    await expect(searchRagWithDependencies({ query: 'repair', scope }, configured.dependencies))
      .resolves.toMatchObject({ chunks: [{ text: canonical.text }] });
    expect(configured.dependencies.loadCorpus).toHaveBeenCalledOnce();
    expect(configured.store.upsert).toHaveBeenCalledWith([{
      id: canonical.id,
      vector: [0.4, 0.6],
      payload: canonical.payload,
    }]);
  });

  it('repairs a count mismatch before serving a stable search result', async () => {
    const canonical = point();
    const configured = setup({
      generation: '4',
      points: [canonical],
      storedManifest: manifest('4', 1),
      hits: [indexed(canonical, '4')],
    });
    vi.mocked(configured.store.countWorkspace)
      .mockResolvedValueOnce(0)
      .mockResolvedValue(1);

    await expect(searchRagWithDependencies({ query: 'count repair', scope }, configured.dependencies))
      .resolves.toMatchObject({ chunks: [{ text: canonical.text }] });
    expect(configured.dependencies.loadCorpus).toHaveBeenCalledOnce();
    expect(configured.store.query).toHaveBeenCalledTimes(2);
  });

  it('rebuilds an inconsistent empty manifest and returns the stable empty corpus', async () => {
    const configured = setup({
      generation: '5',
      corpus: { generation: '5', fingerprint: 'empty', points: [] },
      storedManifest: manifest('5', 0),
      count: 0,
    });
    vi.mocked(configured.store.countWorkspace)
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0)
      .mockResolvedValue(0);

    await expect(searchRagWithDependencies({ query: 'empty repair', scope }, configured.dependencies))
      .resolves.toEqual({ chunks: [], truncated: false });
    expect(configured.dependencies.loadCorpus).toHaveBeenCalledOnce();
    expect(configured.store.query).not.toHaveBeenCalled();
  });

  it('fails after three unstable canonical snapshots and embeds the query only once', async () => {
    const canonical = point();
    const configured = setup({
      generation: '6',
      points: [canonical],
      storedManifest: manifest('6', 1),
      hits: [indexed(canonical, '6')],
    });
    vi.mocked(configured.dependencies.loadPoints).mockResolvedValue({
      generation: 'newer-generation',
      points: [canonical],
    });

    await expect(searchRagWithDependencies({ query: 'racing writes', scope }, configured.dependencies))
      .rejects.toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE',
        dependency: 'rag',
        retryable: true,
      } satisfies Partial<DependencyUnavailableError>);
    expect(configured.embed).toHaveBeenCalledOnce();
    expect(configured.store.query).toHaveBeenCalledTimes(3);
  });

  it('reports missing embedding vectors instead of indexing malformed data', async () => {
    const configured = setup({
      generation: '7',
      storedManifest: null,
      embed: async () => [],
    });

    await expect(searchRagWithDependencies({ query: 'missing vector', scope }, configured.dependencies))
      .rejects.toThrow('Embedding provider did not return a manifest vector');
  });

  it('reports a missing query vector from an otherwise current index', async () => {
    const canonical = point();
    const configured = setup({
      generation: '8', points: [canonical], storedManifest: manifest('8', 1),
      embed: async () => [],
    });

    await expect(searchRagWithDependencies({ query: 'query vector', scope }, configured.dependencies))
      .rejects.toThrow('Embedding provider did not return a query vector');
  });

  it('abandons a rebuilt generation that changes before it can be published', async () => {
    const canonical = point();
    const configured = setup({ generation: '9', points: [canonical] });
    vi.mocked(configured.dependencies.loadGeneration)
      .mockResolvedValueOnce('9')
      .mockResolvedValueOnce('9')
      .mockResolvedValueOnce('10')
      .mockResolvedValueOnce('10')
      .mockResolvedValueOnce('10');
    vi.mocked(configured.store.getWorkspaceManifest)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(manifest('10', 0));
    vi.mocked(configured.store.countWorkspace).mockResolvedValue(0);

    await expect(searchRagWithDependencies({ query: 'generation race', scope }, configured.dependencies))
      .resolves.toEqual({ chunks: [], truncated: false });
    expect(configured.store.setWorkspaceGeneration).not.toHaveBeenCalled();
  });

  it('rejects a manifest publication whose count does not match the canonical corpus', async () => {
    const configured = setup({ generation: '10', storedManifest: null, count: 0 });

    await expect(searchRagWithDependencies({ query: 'bad publish', scope }, configured.dependencies))
      .rejects.toMatchObject({ dependency: 'qdrant', retryable: true });
    expect(configured.store.deleteIds).toHaveBeenCalledWith([expect.any(String)]);
  });
});
