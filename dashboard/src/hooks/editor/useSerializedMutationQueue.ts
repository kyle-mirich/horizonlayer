import { useCallback, useEffect, useRef } from 'react';

import type { MutationIssue, MutationStateController } from './useMutationState';

interface SerializedMutationOptions {
  abortOnUnmount?: boolean;
  cancelOnError?: boolean;
  classifyError(error: unknown): MutationIssue;
  clearIssuesWhenIdle?: boolean;
  mutationState: MutationStateController;
  onError(error: unknown, issue: MutationIssue): void;
}

interface RunMutationOptions<Result> {
  issueKey?: string;
  onSuccess?(result: Result): Promise<void> | void;
  onSuccessAfterUnmount?(result: Result): Promise<void> | void;
}

export interface SerializedMutationQueue {
  cancelPending(): Promise<void>;
  run<Result>(
    request: (signal: AbortSignal) => Promise<Result>,
    options?: RunMutationOptions<Result>,
  ): Promise<Result | undefined>;
}

const GENERAL_MUTATION_KEY = 'general';

export function useSerializedMutationQueue({
  abortOnUnmount = true,
  cancelOnError = false,
  classifyError,
  clearIssuesWhenIdle = false,
  mutationState,
  onError,
}: SerializedMutationOptions): SerializedMutationQueue {
  const {
    finish,
    isMounted,
    markFailed,
    markSucceeded,
    start,
  } = mutationState;
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const controllerRef = useRef(new AbortController());
  const classifyErrorRef = useRef(classifyError);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    classifyErrorRef.current = classifyError;
  }, [classifyError]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const cancel = useCallback(() => {
    controllerRef.current.abort();
    controllerRef.current = new AbortController();
  }, []);

  useEffect(() => {
    if (!abortOnUnmount) return;
    return cancel;
  }, [abortOnUnmount, cancel]);

  const run = useCallback(<Result,>(
    request: (signal: AbortSignal) => Promise<Result>,
    options: RunMutationOptions<Result> = {},
  ): Promise<Result | undefined> => {
    const issueKey = options.issueKey ?? GENERAL_MUTATION_KEY;
    const signal = controllerRef.current.signal;
    start(issueKey, clearIssuesWhenIdle);

    const execution = queueRef.current.then(async () => {
      signal.throwIfAborted();
      const result = await request(signal);
      signal.throwIfAborted();
      if (isMounted()) await options.onSuccess?.(result);
      else await options.onSuccessAfterUnmount?.(result);
      signal.throwIfAborted();
      return result;
    });

    const handled = execution.then((result) => {
      markSucceeded(issueKey);
      return result;
    }, (error: unknown) => {
      if (!signal.aborted) {
        const issue = classifyErrorRef.current(error);
        markFailed(issueKey, issue);
        if (cancelOnError) cancel();
        if (isMounted()) onErrorRef.current(error, issue);
      }
      return undefined;
    }).finally(() => {
      finish();
    });

    queueRef.current = handled.then(() => undefined);
    return handled;
  }, [cancel, cancelOnError, clearIssuesWhenIdle, finish, isMounted, markFailed, markSucceeded, start]);

  const cancelPending = useCallback(() => {
    const pending = queueRef.current;
    cancel();
    return pending;
  }, [cancel]);

  return { cancelPending, run };
}
