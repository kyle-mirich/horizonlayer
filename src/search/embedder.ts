import { config } from '../config.js';
import { DependencyUnavailableError } from './errors.js';

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

interface FeatureExtractor {
  (texts: string[], options: { pooling: 'mean'; normalize: true }): Promise<{
    tolist(): unknown;
  }>;
  dispose?(): Promise<void> | void;
}

type PipelineLoader = () => Promise<FeatureExtractor>;

function errorDetails(cause: unknown): { code?: string; message: string } {
  if (cause instanceof Error) {
    const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
    return { code, message: cause.message };
  }
  return { message: String(cause) };
}

function embeddingFailure(
  phase: 'loaded' | 'produce embeddings',
  cause: unknown
): DependencyUnavailableError {
  const details = errorDetails(cause);
  const normalized = details.message.toLowerCase();
  const missingPackage = details.code === 'ERR_MODULE_NOT_FOUND'
    && normalized.includes('@huggingface/transformers');
  const invalidConfiguration = /(?:401|403|404|forbidden|unauthorized|not found|does not exist|model missing|invalid (?:model|revision)|unsupported|unknown dtype|local_files_only)/u
    .test(normalized);
  const incompatibleOutput = normalized.includes('embedding model returned');
  const retryable = !(missingPackage
    || !config.rag.allow_download
    || invalidConfiguration
    || incompatibleOutput);
  let remediation = 'Retry after checking local network, disk, and model runtime availability.';
  if (missingPackage) {
    remediation = 'Install dependencies without omitting optional packages.';
  } else if (!config.rag.allow_download) {
    remediation = 'Preload the pinned model in EMBEDDING_CACHE_DIR or enable EMBEDDING_ALLOW_DOWNLOAD.';
  } else if (invalidConfiguration) {
    remediation = 'Verify EMBEDDING_MODEL, EMBEDDING_REVISION, and EMBEDDING_DTYPE.';
  } else if (incompatibleOutput) {
    remediation = 'Choose a compatible feature-extraction embedding model.';
  }
  return new DependencyUnavailableError(
    'embedding_model',
    `Local embedding model '${config.rag.embedding_model}' could not be ${phase}. ${remediation}`,
    { cause, retryable }
  );
}

function validateEmbeddings(value: unknown, expectedCount: number): number[][] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new Error(`Embedding model returned ${Array.isArray(value) ? value.length : 'invalid'} vectors for ${expectedCount} texts`);
  }

  let dimensions: number | null = null;
  return value.map((candidate, index) => {
    if (!Array.isArray(candidate) || candidate.length === 0) {
      throw new Error(`Embedding model returned an invalid vector at index ${index}`);
    }
    const vector = candidate.map(Number);
    if (vector.some((number) => !Number.isFinite(number))) {
      throw new Error(`Embedding model returned a non-finite value at index ${index}`);
    }
    dimensions ??= vector.length;
    if (vector.length !== dimensions) {
      throw new Error('Embedding model returned vectors with inconsistent dimensions');
    }
    return vector;
  });
}

async function loadConfiguredPipeline(): Promise<FeatureExtractor> {
  try {
    const transformers = await import('@huggingface/transformers');
    const extractor = await transformers.pipeline(
      'feature-extraction',
      config.rag.embedding_model,
      {
        cache_dir: config.rag.cache_dir,
        device: 'cpu',
        dtype: config.rag.embedding_dtype,
        local_files_only: !config.rag.allow_download,
        revision: config.rag.embedding_revision,
      }
    );
    return extractor as unknown as FeatureExtractor;
  } catch (cause) {
    throw embeddingFailure('loaded', cause);
  }
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  private extractorPromise: Promise<FeatureExtractor> | null = null;

  constructor(private readonly loadPipeline: PipelineLoader = loadConfiguredPipeline) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => typeof text !== 'string' || text.trim().length === 0)) {
      throw new Error('Embedding inputs must be non-empty strings');
    }

    try {
      const extractor = await this.getExtractor();
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      return validateEmbeddings(output.tolist(), texts.length);
    } catch (cause) {
      if (cause instanceof DependencyUnavailableError) throw cause;
      throw embeddingFailure('produce embeddings', cause);
    }
  }

  private async getExtractor(): Promise<FeatureExtractor> {
    const pending = this.extractorPromise ?? this.loadPipeline();
    this.extractorPromise = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.extractorPromise === pending) this.extractorPromise = null;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const pending = this.extractorPromise;
    this.extractorPromise = null;
    if (!pending) return;
    try {
      const extractor = await pending;
      await extractor.dispose?.();
    } catch {
      // A failed lazy load has no successfully allocated pipeline to release.
    }
  }
}

let singleton: LocalEmbeddingProvider | null = null;

export async function getEmbeddingProvider(): Promise<EmbeddingProvider> {
  singleton ??= new LocalEmbeddingProvider();
  return singleton;
}

export async function disposeEmbeddingProvider(): Promise<void> {
  const current = singleton;
  singleton = null;
  await current?.dispose();
}
