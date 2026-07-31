import { describe, expect, it, vi } from 'vitest';
import { QdrantVectorStore } from './qdrant.js';

function fakeClient() {
  return {
    collectionExists: vi.fn().mockResolvedValue({ exists: false }),
    count: vi.fn().mockResolvedValue({ count: 0 }),
    createCollection: vi.fn().mockResolvedValue(true),
    createPayloadIndex: vi.fn().mockResolvedValue({ status: 'completed' }),
    delete: vi.fn().mockResolvedValue({ status: 'completed' }),
    getCollection: vi.fn().mockResolvedValue({
      config: { params: { vectors: { distance: 'Cosine', size: 2 } } },
    }),
    query: vi.fn().mockResolvedValue({
      points: [{ id: 'point-1', payload: { fingerprint: 'fp-1' }, score: 0.9 }],
    }),
    scroll: vi.fn().mockResolvedValue({ next_page_offset: null, points: [] }),
    setPayload: vi.fn().mockResolvedValue({ status: 'completed' }),
    upsert: vi.fn().mockResolvedValue({ status: 'completed' }),
    versionInfo: vi.fn().mockResolvedValue({ version: '1.18.2' }),
  };
}

describe('QdrantVectorStore', () => {
  it('connects lazily and prepares a cosine collection with payload indexes', async () => {
    const client = fakeClient();
    const store = new QdrantVectorStore(client as never, 'rag_test');

    expect(client.versionInfo).not.toHaveBeenCalled();
    await store.query([0.1, 0.2], { must: [] }, 4);

    expect(client.versionInfo).toHaveBeenCalledTimes(1);
    expect(client.createCollection).toHaveBeenCalledWith('rag_test', {
      on_disk_payload: true,
      vectors: { distance: 'Cosine', size: 2 },
    });
    expect(client.createPayloadIndex).toHaveBeenCalledTimes(9);
    expect(client.query).toHaveBeenCalledWith('rag_test', {
      filter: { must: [] },
      limit: 4,
      query: [0.1, 0.2],
      with_payload: true,
      with_vector: false,
    });
  });

  it('scrolls every point for exactly one workspace', async () => {
    const client = fakeClient();
    client.collectionExists.mockResolvedValue({ exists: true });
    client.scroll
      .mockResolvedValueOnce({
        next_page_offset: 'point-2',
        points: [{ id: 'point-1', payload: { fingerprint: 'one' } }],
      })
      .mockResolvedValueOnce({
        next_page_offset: null,
        points: [{ id: 'point-2', payload: null }],
      });
    const store = new QdrantVectorStore(client as never, 'rag_test');

    await expect(store.scrollWorkspace('workspace-1')).resolves.toEqual([
      { id: 'point-1', payload: { fingerprint: 'one' } },
      { id: 'point-2', payload: {} },
    ]);
    expect(client.scroll).toHaveBeenNthCalledWith(1, 'rag_test', expect.objectContaining({
      filter: {
        must: [
          { key: 'workspace_id', match: { value: 'workspace-1' } },
          { key: 'record_type', match: { value: 'chunk' } },
        ],
      },
      offset: undefined,
    }));
    expect(client.scroll).toHaveBeenNthCalledWith(2, 'rag_test', expect.objectContaining({
      offset: 'point-2',
    }));
  });

  it('upserts and deletes synchronously while keeping empty operations local', async () => {
    const client = fakeClient();
    client.collectionExists.mockResolvedValue({ exists: true });
    const store = new QdrantVectorStore(client as never, 'rag_test');

    await store.upsert([]);
    await store.deleteIds([]);
    expect(client.versionInfo).not.toHaveBeenCalled();

    const point = { id: 'point-1', payload: { workspace_id: 'workspace-1' }, vector: [1, 0] };
    await store.upsert([point]);
    await store.deleteIds(['point-1']);
    expect(client.upsert).toHaveBeenCalledWith('rag_test', { points: [point], wait: true });
    expect(client.delete).toHaveBeenCalledWith('rag_test', {
      points: ['point-1'],
      wait: true,
    });
  });

  it('reads manifests separately and finalizes chunk generations by filter', async () => {
    const client = fakeClient();
    client.collectionExists.mockResolvedValue({ exists: true });
    client.scroll.mockResolvedValue({
      next_page_offset: null,
      points: [{ id: 'manifest-id', payload: { record_type: 'manifest', point_count: 2 } }],
    });
    const store = new QdrantVectorStore(client as never, 'rag_test');

    await expect(store.getWorkspaceManifest('workspace-1')).resolves.toEqual({
      id: 'manifest-id',
      payload: { record_type: 'manifest', point_count: 2 },
    });
    await store.setWorkspaceGeneration('workspace-1', '42', 0);

    expect(client.scroll).toHaveBeenCalledWith('rag_test', expect.objectContaining({
      filter: { must: [
        { key: 'workspace_id', match: { value: 'workspace-1' } },
        { key: 'record_type', match: { value: 'manifest' } },
      ] },
      limit: 1,
    }));
    expect(client.setPayload).toHaveBeenCalledWith('rag_test', {
      filter: { must: [
        { key: 'workspace_id', match: { value: 'workspace-1' } },
        { key: 'record_type', match: { value: 'chunk' } },
      ] },
      payload: { index_generation: '42' },
      wait: true,
    });
    expect(client.count).toHaveBeenCalledWith('rag_test', {
      exact: true,
      filter: { must: [
        { key: 'workspace_id', match: { value: 'workspace-1' } },
        { key: 'record_type', match: { value: 'chunk' } },
        { key: 'index_generation', match: { value: '42' } },
      ] },
    });
  });

  it('wraps transport failures with the dependency contract and recovery guidance', async () => {
    const client = fakeClient();
    client.versionInfo.mockRejectedValue(new Error('connection refused'));
    const store = new QdrantVectorStore(client as never, 'rag_test');

    await expect(store.ensureReady()).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      dependency: 'qdrant',
      message: expect.stringContaining('horizonlayer setup'),
      retryable: true,
    });
  });

  it('wraps collection inspection failures after readiness succeeds', async () => {
    const client = fakeClient();
    client.collectionExists.mockRejectedValue(new Error('transport reset'));
    const store = new QdrantVectorStore(client as never, 'rag_test');

    await expect(store.getWorkspaceManifest('workspace-1')).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      dependency: 'qdrant',
      retryable: true,
    });
  });

  it('retries a rejected readiness probe', async () => {
    const client = fakeClient();
    client.versionInfo
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ version: '1.18.2' });
    const store = new QdrantVectorStore(client as never, 'rag_test');

    await expect(store.ensureReady()).rejects.toBeTruthy();
    await expect(store.ensureReady()).resolves.toBeUndefined();
    expect(client.versionInfo).toHaveBeenCalledTimes(2);
  });

  it('retries collection preparation after a transient index failure', async () => {
    const client = fakeClient();
    client.collectionExists
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValue({ exists: true });
    client.createPayloadIndex
      .mockRejectedValueOnce(new Error('temporary timeout'))
      .mockResolvedValue({ status: 'completed' });
    const store = new QdrantVectorStore(client as never, 'rag_test');

    await expect(store.query([1, 0], { must: [] }, 1)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      retryable: true,
    });
    await expect(store.query([1, 0], { must: [] }, 1)).resolves.toHaveLength(1);
    expect(client.createCollection).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('recreates a collection deleted after successful preparation', async () => {
    const client = fakeClient();
    const store = new QdrantVectorStore(client as never, 'rag_test');
    const point = { id: 'point-1', payload: {}, vector: [1, 0] };
    await store.upsert([point]);

    client.collectionExists.mockReset();
    client.collectionExists
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValue({ exists: true });
    await store.upsert([{ ...point, id: 'point-2' }]);

    expect(client.createCollection).toHaveBeenCalledTimes(2);
    expect(client.upsert).toHaveBeenCalledTimes(2);
  });

  it('fails publication when a non-empty collection disappears', async () => {
    const client = fakeClient();
    const store = new QdrantVectorStore(client as never, 'rag_test');

    await expect(store.setWorkspaceGeneration('workspace-1', '3', 1)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      dependency: 'qdrant',
      retryable: true,
    });
    expect(client.setPayload).not.toHaveBeenCalled();
  });

  it('rejects an incompatible existing collection without querying it', async () => {
    const client = fakeClient();
    client.collectionExists.mockResolvedValue({ exists: true });
    client.getCollection.mockResolvedValue({
      config: { params: { vectors: { distance: 'Dot', size: 3 } } },
    });
    const store = new QdrantVectorStore(client as never, 'rag_test');

    await expect(store.query([1, 0], { must: [] }, 1)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      dependency: 'qdrant',
      retryable: false,
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('rejects vector dimension changes before sending them to Qdrant', async () => {
    const client = fakeClient();
    const store = new QdrantVectorStore(client as never, 'rag_test');
    await store.query([1, 0], { must: [] }, 1);

    await expect(store.query([1, 0, 0], { must: [] }, 1)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      dependency: 'qdrant',
      retryable: false,
    });
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
