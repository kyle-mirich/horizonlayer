import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const qdrantClientConstructor = vi.hoisted(() => vi.fn());

vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: qdrantClientConstructor,
}));

import { getVectorStore, QdrantVectorStore, resetVectorStore } from './qdrant.js';

function client() {
  return {
    collectionExists: vi.fn().mockResolvedValue({ exists: true }),
    count: vi.fn().mockResolvedValue({ count: 0 }),
    createCollection: vi.fn().mockResolvedValue({ status: 'completed' }),
    createPayloadIndex: vi.fn().mockResolvedValue({ status: 'completed' }),
    delete: vi.fn().mockResolvedValue({ status: 'completed' }),
    getCollection: vi.fn().mockResolvedValue({
      config: { params: { vectors: { distance: 'Cosine', size: 2 } } },
    }),
    query: vi.fn().mockResolvedValue({ points: [] }),
    scroll: vi.fn().mockResolvedValue({ next_page_offset: null, points: [] }),
    setPayload: vi.fn().mockResolvedValue({ status: 'completed' }),
    upsert: vi.fn().mockResolvedValue({ status: 'completed' }),
    versionInfo: vi.fn().mockResolvedValue({ version: '1.18.2' }),
  };
}

beforeEach(() => {
  resetVectorStore();
  qdrantClientConstructor.mockImplementation(function QdrantClientMock() {
    return client();
  });
});

afterEach(() => resetVectorStore());

describe('QdrantVectorStore coverage cases', () => {
  it('treats a missing derived collection as an empty index for reads and cleanup', async () => {
    const fake = client();
    fake.collectionExists.mockResolvedValue({ exists: false });
    const store = new QdrantVectorStore(fake as never, 'coverage_rag');

    await expect(store.scrollWorkspace('workspace')).resolves.toEqual([]);
    await expect(store.countWorkspace('workspace', '1')).resolves.toBe(0);
    await expect(store.getWorkspaceManifest('workspace')).resolves.toBeNull();
    await expect(store.setWorkspaceGeneration('workspace', '1', 0)).resolves.toBeUndefined();
    await expect(store.deleteIds(['stale'])).resolves.toBeUndefined();
    expect(fake.scroll).not.toHaveBeenCalled();
    expect(fake.setPayload).not.toHaveBeenCalled();
    expect(fake.delete).not.toHaveBeenCalled();
  });

  it('rejects malformed vectors and limits before writing or querying Qdrant', async () => {
    const fake = client();
    const store = new QdrantVectorStore(fake as never, 'coverage_rag');

    await expect(store.upsert([{ id: 'empty', vector: [], payload: {} }])).rejects.toThrow(
      'Vectors must contain at least one finite number'
    );
    await expect(store.upsert([{ id: 'nan', vector: [Number.NaN], payload: {} }])).rejects.toThrow(
      'Vectors must contain at least one finite number'
    );
    await expect(store.upsert([
      { id: 'short', vector: [1], payload: {} },
      { id: 'long', vector: [1, 2], payload: {} },
    ])).rejects.toThrow('All upserted vectors must have the same dimensions');
    await expect(store.query([], {}, 1)).rejects.toThrow('Vectors must contain at least one finite number');
    await expect(store.query([1], {}, 0)).rejects.toThrow('Vector query limit must be positive');
    expect(fake.versionInfo).not.toHaveBeenCalled();
  });

  it('rejects an incomplete or named-vector collection contract before issuing a query', async () => {
    const fake = client();
    fake.getCollection.mockResolvedValue({ config: { params: { vectors: { size: 2 } } } });
    const store = new QdrantVectorStore(fake as never, 'coverage_rag');

    await expect(store.query([1, 0], {}, 1)).rejects.toMatchObject({ retryable: false });
    expect(fake.query).not.toHaveBeenCalled();

    const namedVectors = client();
    namedVectors.getCollection.mockResolvedValue({ config: { params: { vectors: null } } });
    const namedStore = new QdrantVectorStore(namedVectors as never, 'coverage_rag');
    await expect(namedStore.query([1, 0], {}, 1)).rejects.toMatchObject({ retryable: false });
    expect(namedVectors.query).not.toHaveBeenCalled();
  });

  it('recovers when another process creates the collection between inspection and creation', async () => {
    const fake = client();
    fake.collectionExists
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true });
    fake.createCollection.mockRejectedValueOnce(new Error('already exists'));
    fake.query.mockResolvedValue({
      points: [{ id: 'point', payload: ['not-an-object'], score: undefined }],
    });
    const store = new QdrantVectorStore(fake as never, 'coverage_rag');

    await expect(store.query([1, 0], {}, 1)).resolves.toEqual([
      { id: 'point', payload: {}, score: 0 },
    ]);
    expect(fake.createCollection).toHaveBeenCalledOnce();
    expect(fake.createPayloadIndex).toHaveBeenCalledTimes(9);
  });

  it('reuses a prepared collection after verifying it still exists', async () => {
    const fake = client();
    const store = new QdrantVectorStore(fake as never, 'coverage_rag');

    await store.query([1, 0], {}, 1);
    await store.query([1, 0], {}, 1);
    expect(fake.getCollection).toHaveBeenCalledOnce();
    expect(fake.createPayloadIndex).toHaveBeenCalledTimes(9);
  });

  it('surfaces a publication count mismatch after setting the generation', async () => {
    const fake = client();
    fake.count.mockResolvedValue({ count: 1 });
    const store = new QdrantVectorStore(fake as never, 'coverage_rag');

    await expect(store.setWorkspaceGeneration('workspace', '2', 2)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      dependency: 'qdrant',
      retryable: true,
    });
    expect(fake.setPayload).toHaveBeenCalledOnce();
  });

  it('provides a resettable process singleton without connecting on access', () => {
    const first = getVectorStore();
    expect(getVectorStore()).toBe(first);
    expect(qdrantClientConstructor).toHaveBeenCalledTimes(1);
    resetVectorStore();
    expect(getVectorStore()).not.toBe(first);
    expect(qdrantClientConstructor).toHaveBeenCalledTimes(2);
  });
});
