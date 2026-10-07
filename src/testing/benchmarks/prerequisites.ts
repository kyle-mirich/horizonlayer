import { DependencyUnavailableError } from '../../search/errors.js';

/** An unavailable optional backend is blocked, rather than a correctness failure. */
export async function semanticPrerequisite<T>(
  url: string | undefined,
  readVersion: () => Promise<T>
): Promise<T> {
  if (!url) {
    throw new DependencyUnavailableError('qdrant',
      'HORIZONLAYER_BENCHMARK_QDRANT_URL is required for semantic measurements',
      { retryable: false });
  }
  try {
    return await readVersion();
  } catch (cause) {
    throw new DependencyUnavailableError('qdrant',
      'The benchmark Qdrant prerequisite is unavailable; no semantic measurements ran',
      { cause, retryable: true });
  }
}
