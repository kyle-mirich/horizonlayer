import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  disposeEmbeddingProvider,
  getEmbeddingProvider,
  LocalEmbeddingProvider,
} from './embedder.js';
import { DependencyUnavailableError } from './errors.js';

function embedding(value: number): number[] {
  return Array.from({ length: 384 }, () => value);
}

afterEach(async () => {
  await disposeEmbeddingProvider();
});

describe('LocalEmbeddingProvider', () => {
  it('loads lazily once and requests normalized mean-pooled vectors', async () => {
    const extractor = vi.fn().mockResolvedValue({
      tolist: () => [embedding(0.1), embedding(0.2)],
    });
    const load = vi.fn().mockResolvedValue(extractor);
    const provider = new LocalEmbeddingProvider(load);

    expect(load).not.toHaveBeenCalled();
    await expect(provider.embed(['alpha', 'beta'])).resolves.toEqual([
      embedding(0.1),
      embedding(0.2),
    ]);
    await provider.embed(['gamma', 'delta']);

    expect(load).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenNthCalledWith(
      1,
      ['alpha', 'beta'],
      { normalize: true, pooling: 'mean' }
    );
  });

  it('does not load the model for an empty batch', async () => {
    const load = vi.fn();
    const provider = new LocalEmbeddingProvider(load);
    await expect(provider.embed([])).resolves.toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it('marks missing or invalid model configuration as non-retryable', async () => {
    const provider = new LocalEmbeddingProvider(async () => {
      throw new Error('model missing');
    });

    await expect(provider.embed(['alpha'])).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      dependency: 'embedding_model',
      retryable: false,
    });
  });

  it('keeps transient model runtime failures retryable', async () => {
    const extractor = vi.fn().mockRejectedValue(new Error('temporary worker failure'));
    const provider = new LocalEmbeddingProvider(vi.fn().mockResolvedValue(extractor));

    await expect(provider.embed(['alpha'])).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      dependency: 'embedding_model',
      retryable: true,
    });
  });

  it('retries a rejected lazy model load', async () => {
    const extractor = vi.fn().mockResolvedValue({ tolist: () => [embedding(1)] });
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('temporary cache failure'))
      .mockResolvedValueOnce(extractor);
    const provider = new LocalEmbeddingProvider(load);

    await expect(provider.embed(['first'])).rejects.toBeInstanceOf(DependencyUnavailableError);
    await expect(provider.embed(['second'])).resolves.toEqual([embedding(1)]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rejects inconsistent dimensions within one embedding batch', async () => {
    const extractor = vi.fn().mockResolvedValue({ tolist: () => [[1, 2], [1]] });
    const provider = new LocalEmbeddingProvider(vi.fn().mockResolvedValue(extractor));

    await expect(provider.embed(['first', 'second'])).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      dependency: 'embedding_model',
      retryable: false,
    });
  });

  it('disposes a loaded pipeline and can load a fresh one', async () => {
    const dispose = vi.fn();
    const extractor = Object.assign(
      vi.fn().mockResolvedValue({ tolist: () => [embedding(1)] }),
      { dispose }
    );
    const load = vi.fn().mockResolvedValue(extractor);
    const provider = new LocalEmbeddingProvider(load);

    await provider.embed(['first']);
    await provider.dispose();
    await provider.embed(['second']);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('resets the process singleton without loading the model', async () => {
    const first = await getEmbeddingProvider();
    expect(await getEmbeddingProvider()).toBe(first);
    await disposeEmbeddingProvider();
    expect(await getEmbeddingProvider()).not.toBe(first);
  });

  it('exposes a stable dependency error contract', () => {
    const error = new DependencyUnavailableError('rag', 'disabled', { retryable: false });
    expect(error).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      dependency: 'rag',
      name: 'DependencyUnavailableError',
      retryable: false,
    });
  });
});
