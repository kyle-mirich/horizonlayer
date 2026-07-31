import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { DependencyUnavailableError } from './errors.js';

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface StoredVectorPoint {
  id: string | number;
  payload: Record<string, unknown>;
}

export interface ScoredVectorPoint extends StoredVectorPoint {
  score: number;
}

export interface VectorStore {
  ensureReady(): Promise<void>;
  countWorkspace(workspaceId: string, generation: string): Promise<number>;
  getWorkspaceManifest(workspaceId: string): Promise<StoredVectorPoint | null>;
  scrollWorkspace(workspaceId: string): Promise<StoredVectorPoint[]>;
  setWorkspaceGeneration(
    workspaceId: string,
    generation: string,
    expectedCount: number
  ): Promise<void>;
  upsert(points: VectorPoint[]): Promise<void>;
  deleteIds(ids: Array<string | number>): Promise<void>;
  query(
    vector: number[],
    filter: Record<string, unknown>,
    limit: number
  ): Promise<ScoredVectorPoint[]>;
}

type QdrantLike = Pick<QdrantClient,
  | 'versionInfo'
  | 'collectionExists'
  | 'count'
  | 'getCollection'
  | 'createCollection'
  | 'createPayloadIndex'
  | 'scroll'
  | 'setPayload'
  | 'upsert'
  | 'delete'
  | 'query'>;

const PAYLOAD_INDEXES = [
  ['workspace_id', 'keyword'],
  ['record_type', 'keyword'],
  ['source_type', 'keyword'],
  ['session_id', 'keyword'],
  ['database_id', 'keyword'],
  ['tags', 'keyword'],
  ['importance', 'float'],
  ['fingerprint', 'keyword'],
  ['index_generation', 'keyword'],
] as const;

function payload(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validateVector(vector: number[]): void {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Vectors must contain at least one finite number');
  }
}

function qdrantOrigin(): string {
  try {
    return new URL(config.rag.qdrant_url).origin;
  } catch {
    return 'the configured Qdrant endpoint';
  }
}

function denseVectorContract(collection: Awaited<ReturnType<QdrantClient['getCollection']>>): {
  distance: string;
  size: number;
} | null {
  const vectors = collection.config.params.vectors;
  if (vectors == null || typeof vectors !== 'object' || Array.isArray(vectors)) return null;
  if (!('size' in vectors) || !('distance' in vectors)) return null;
  return typeof vectors.size === 'number' && typeof vectors.distance === 'string'
    ? { distance: vectors.distance, size: vectors.size }
    : null;
}

export class QdrantVectorStore implements VectorStore {
  private readyPromise: Promise<void> | null = null;
  private collectionPromise: Promise<void> | null = null;
  private vectorSize: number | null = null;

  constructor(
    private readonly client: QdrantLike = new QdrantClient({
      apiKey: config.rag.api_key,
      checkCompatibility: true,
      timeout: config.rag.timeout_ms,
      url: config.rag.qdrant_url,
    }),
    private readonly collection = config.rag.collection
  ) {}

  async ensureReady(): Promise<void> {
    const pending = this.readyPromise ?? this.run('connect to Qdrant', async () => {
      await this.client.versionInfo();
    });
    this.readyPromise = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.readyPromise === pending) this.readyPromise = null;
      throw error;
    }
  }

  async scrollWorkspace(workspaceId: string): Promise<StoredVectorPoint[]> {
    await this.ensureReady();
    if (!(await this.collectionExists())) {
      this.collectionPromise = null;
      return [];
    }

    return this.run('read the RAG index', async () => {
      const points: StoredVectorPoint[] = [];
      let offset: string | number | Record<string, unknown> | undefined;
      do {
        const page = await this.client.scroll(this.collection, {
          filter: {
            must: [
              { key: 'workspace_id', match: { value: workspaceId } },
              { key: 'record_type', match: { value: 'chunk' } },
            ],
          },
          limit: 256,
          offset,
          with_payload: true,
          with_vector: false,
        });
        points.push(...page.points.map((point) => ({
          id: point.id,
          payload: payload(point.payload),
        })));
        offset = page.next_page_offset ?? undefined;
      } while (offset !== undefined && offset !== null);
      return points;
    });
  }

  async countWorkspace(workspaceId: string, generation: string): Promise<number> {
    await this.ensureReady();
    if (!(await this.collectionExists())) {
      this.collectionPromise = null;
      return 0;
    }
    return this.run('count the RAG index', async () => {
      const result = await this.client.count(this.collection, {
        exact: true,
        filter: {
          must: [
            { key: 'workspace_id', match: { value: workspaceId } },
            { key: 'record_type', match: { value: 'chunk' } },
            { key: 'index_generation', match: { value: generation } },
          ],
        },
      });
      return result.count;
    });
  }

  async getWorkspaceManifest(workspaceId: string): Promise<StoredVectorPoint | null> {
    await this.ensureReady();
    if (!(await this.collectionExists())) {
      this.collectionPromise = null;
      return null;
    }

    return this.run('read the RAG index manifest', async () => {
      const page = await this.client.scroll(this.collection, {
        filter: {
          must: [
            { key: 'workspace_id', match: { value: workspaceId } },
            { key: 'record_type', match: { value: 'manifest' } },
          ],
        },
        limit: 1,
        with_payload: true,
        with_vector: false,
      });
      const point = page.points[0];
      return point ? { id: point.id, payload: payload(point.payload) } : null;
    });
  }

  async setWorkspaceGeneration(
    workspaceId: string,
    generation: string,
    expectedCount: number
  ): Promise<void> {
    await this.ensureReady();
    if (!(await this.collectionExists())) {
      this.collectionPromise = null;
      if (expectedCount === 0) return;
      throw new DependencyUnavailableError(
        'qdrant',
        'The RAG collection disappeared while publishing a non-empty index; retry to rebuild it',
        { retryable: true }
      );
    }
    await this.run('finalize the RAG index generation', async () => {
      await this.client.setPayload(this.collection, {
        filter: {
          must: [
            { key: 'workspace_id', match: { value: workspaceId } },
            { key: 'record_type', match: { value: 'chunk' } },
          ],
        },
        payload: { index_generation: generation },
        wait: true,
      });
    });
    const actualCount = await this.countWorkspace(workspaceId, generation);
    if (actualCount !== expectedCount) {
      throw new DependencyUnavailableError(
        'qdrant',
        `RAG index publication expected ${expectedCount} chunks but Qdrant reported ${actualCount}`,
        { retryable: true }
      );
    }
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    const size = points[0]?.vector.length ?? 0;
    for (const point of points) {
      validateVector(point.vector);
      if (point.vector.length !== size) {
        throw new Error('All upserted vectors must have the same dimensions');
      }
    }
    await this.ensureCollection(size);
    await this.run('update the RAG index', async () => {
      await this.client.upsert(this.collection, { points, wait: true });
    });
  }

  async deleteIds(ids: Array<string | number>): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureReady();
    if (!(await this.collectionExists())) {
      this.collectionPromise = null;
      return;
    }
    await this.run('remove stale RAG index entries', async () => {
      await this.client.delete(this.collection, { points: ids, wait: true });
    });
  }

  async query(
    vector: number[],
    filter: Record<string, unknown>,
    limit: number
  ): Promise<ScoredVectorPoint[]> {
    validateVector(vector);
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Vector query limit must be positive');
    await this.ensureCollection(vector.length);
    return this.run('query the RAG index', async () => {
      const response = await this.client.query(this.collection, {
        filter,
        limit,
        query: vector,
        with_payload: true,
        with_vector: false,
      });
      return response.points.map((point) => ({
        id: point.id,
        payload: payload(point.payload),
        score: point.score ?? 0,
      }));
    });
  }

  private async collectionExists(): Promise<boolean> {
    return this.run('inspect the RAG index', async () => (
      await this.client.collectionExists(this.collection)
    ).exists);
  }

  private async ensureCollection(vectorSize: number): Promise<void> {
    await this.ensureReady();
    if (this.vectorSize !== null && this.vectorSize !== vectorSize) {
      throw new DependencyUnavailableError(
        'qdrant',
        `Qdrant collection '${this.collection}' expects ${this.vectorSize}-dimension vectors, received ${vectorSize}`,
        { retryable: false }
      );
    }
    this.vectorSize = vectorSize;
    if (this.collectionPromise) {
      const prepared = this.collectionPromise;
      await prepared;
      if (this.collectionPromise === prepared && await this.collectionExists()) return;
      if (this.collectionPromise === prepared) this.collectionPromise = null;
    }

    const pending = this.run('prepare the RAG index', async () => {
      let existed = await this.collectionExists();
      if (!existed) {
        try {
          await this.client.createCollection(this.collection, {
            on_disk_payload: true,
            vectors: { distance: 'Cosine', size: vectorSize },
          });
        } catch (error) {
          existed = await this.collectionExists();
          if (!existed) throw error;
        }
      }

      if (existed) {
        const collection = await this.client.getCollection(this.collection);
        const contract = denseVectorContract(collection);
        if (contract?.size !== vectorSize || contract.distance !== 'Cosine') {
          const actual = contract == null
            ? 'a named or non-dense vector configuration'
            : `${contract.size} dimensions with ${contract.distance} distance`;
          throw new DependencyUnavailableError(
            'qdrant',
            `Qdrant collection '${this.collection}' uses ${actual}; HorizonLayer requires ${vectorSize} dimensions with Cosine distance. `
            + 'Set QDRANT_COLLECTION to a new collection name or remove the incompatible collection.',
            { retryable: false }
          );
        }
      }

      for (const [field_name, field_schema] of PAYLOAD_INDEXES) {
        await this.client.createPayloadIndex(this.collection, {
          field_name,
          field_schema,
          wait: true,
        });
      }
    });
    this.collectionPromise = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.collectionPromise === pending) this.collectionPromise = null;
      throw error;
    }
  }

  private async run<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      // Any failed collection operation may mean the derived store was reset
      // or replaced. Force the next call to inspect and prepare it again.
      this.collectionPromise = null;
      if (cause instanceof DependencyUnavailableError) throw cause;
      throw new DependencyUnavailableError(
        'qdrant',
        `Could not ${operation} at ${qdrantOrigin()}. Start the managed local runtime with \`horizonlayer setup\`, `
        + 'configure a reachable QDRANT_URL, or set RAG_ENABLED=false.',
        { cause }
      );
    }
  }
}

let singleton: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  singleton ??= new QdrantVectorStore();
  return singleton;
}

export function resetVectorStore(): void {
  singleton = null;
}
