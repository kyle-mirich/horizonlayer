import { afterEach, describe, expect, it, vi } from 'vitest';

const transformers = vi.hoisted(() => ({
  pipeline: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => transformers);

import { config } from '../config.js';
import { LocalEmbeddingProvider } from './embedder.js';
import { DependencyUnavailableError } from './errors.js';

afterEach(() => {
  transformers.pipeline.mockReset();
});

describe('LocalEmbeddingProvider coverage cases', () => {
  it('uses the configured lazy transformers pipeline when no loader is injected', async () => {
    const dispose = vi.fn();
    const extractor = Object.assign(
      vi.fn().mockResolvedValue({ tolist: () => [[0.1, 0.2]] }),
      { dispose }
    );
    transformers.pipeline.mockResolvedValue(extractor);
    const provider = new LocalEmbeddingProvider();

    await expect(provider.embed(['configured pipeline'])).resolves.toEqual([[0.1, 0.2]]);
    expect(transformers.pipeline).toHaveBeenCalledWith(
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
    await provider.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects blank inputs without beginning a lazy model load', async () => {
    const load = vi.fn();
    const provider = new LocalEmbeddingProvider(load);

    await expect(provider.embed(['good', '  '])).rejects.toThrow(
      'Embedding inputs must be non-empty strings'
    );
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong batch size', () => [[1, 2]]],
    ['non-array output', () => 'bad output'],
    ['empty vector', () => [[]]],
    ['non-finite vector', () => [[1, Number.POSITIVE_INFINITY]]],
  ])('turns %s into a non-retryable embedding dependency error', async (_label, tolist) => {
    const extractor = vi.fn().mockResolvedValue({ tolist });
    const provider = new LocalEmbeddingProvider(vi.fn().mockResolvedValue(extractor));

    await expect(provider.embed(['first', 'second'])).rejects.toMatchObject({
      dependency: 'embedding_model',
      retryable: false,
    });
  });

  it('preserves unknown thrown values as retryable dependency failures', async () => {
    const extractor = vi.fn().mockRejectedValue('worker stopped');
    const provider = new LocalEmbeddingProvider(vi.fn().mockResolvedValue(extractor));

    await expect(provider.embed(['first'])).rejects.toMatchObject({
      dependency: 'embedding_model',
      retryable: true,
    });
  });

  it('swallows a failed dispose after a successful pipeline load', async () => {
    const extractor = Object.assign(
      vi.fn().mockResolvedValue({ tolist: () => [[1, 2]] }),
      { dispose: vi.fn().mockRejectedValue(new Error('dispose failed')) }
    );
    const provider = new LocalEmbeddingProvider(vi.fn().mockResolvedValue(extractor));

    await provider.embed(['first']);
    await expect(provider.dispose()).resolves.toBeUndefined();
  });

  it('classifies a missing optional transformers package as a non-retryable setup error', async () => {
    const missing = Object.assign(
      new Error("Cannot find package '@huggingface/transformers'"),
      { code: 'ERR_MODULE_NOT_FOUND' }
    );
    const provider = new LocalEmbeddingProvider(async () => { throw missing; });

    await expect(provider.embed(['first'])).rejects.toMatchObject({
      dependency: 'embedding_model',
      retryable: false,
      message: expect.stringContaining('Install dependencies without omitting optional packages'),
    });
  });

  it('marks local-only model failures non-retryable and restores the process configuration', async () => {
    const previous = config.rag.allow_download;
    config.rag.allow_download = false;
    try {
      const provider = new LocalEmbeddingProvider(async () => { throw new Error('cache unavailable'); });
      await expect(provider.embed(['first'])).rejects.toMatchObject({
        dependency: 'embedding_model',
        retryable: false,
        message: expect.stringContaining('EMBEDDING_ALLOW_DOWNLOAD'),
      });
    } finally {
      config.rag.allow_download = previous;
    }
  });

  it.each([
    [() => [[]]],
    [() => [[Number.POSITIVE_INFINITY]]],
  ])('rejects invalid individual vector values after count validation', async (tolist) => {
    const extractor = vi.fn().mockResolvedValue({ tolist });
    const provider = new LocalEmbeddingProvider(vi.fn().mockResolvedValue(extractor));

    await expect(provider.embed(['only'])).rejects.toMatchObject({ retryable: false });
  });

  it('does not wrap the explicit dependency error returned by an extractor', async () => {
    const dependencyError = new DependencyUnavailableError('embedding_model', 'already normalized', { retryable: false });
    const extractor = vi.fn().mockRejectedValue(dependencyError);
    const provider = new LocalEmbeddingProvider(vi.fn().mockResolvedValue(extractor));

    await expect(provider.embed(['only'])).rejects.toBe(dependencyError);
  });
});
