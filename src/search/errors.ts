export type RagDependency = 'rag' | 'embedding_model' | 'qdrant';

export class DependencyUnavailableError extends Error {
  readonly code = 'DEPENDENCY_UNAVAILABLE' as const;
  readonly retryable: boolean;
  readonly dependency: RagDependency;

  constructor(
    dependency: RagDependency,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DependencyUnavailableError';
    this.dependency = dependency;
    this.retryable = options.retryable ?? true;
  }
}
