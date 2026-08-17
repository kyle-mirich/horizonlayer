import { useCallback, useEffect, useRef } from 'react';

import type { MutationIssue, MutationStateController } from './useMutationState';

interface KeyedMutationQueueOptions<Entity> {
  apply(result: Entity): void;
  classifyError(error: unknown): MutationIssue;
  clearIssuesWhenIdle?: boolean;
  getCurrent(key: string): Entity | null;
  mutationState: MutationStateController;
  onError(error: unknown, issue: MutationIssue, key: string): void;
  onFailure(key: string, issue: MutationIssue): void;
  statusKey?(key: string): string;
}

export interface KeyedMutationQueue<Entity> {
  cancelPending(): Promise<void>;
  enqueue(key: string, request: (current: Entity, signal: AbortSignal) => Promise<Entity>): void;
  hasPending(key: string): boolean;
}

export function useKeyedMutationQueue<Entity>({
  apply,
  classifyError,
  clearIssuesWhenIdle = false,
  getCurrent,
  mutationState,
  onError,
  onFailure,
  statusKey = (key) => key,
}: KeyedMutationQueueOptions<Entity>): KeyedMutationQueue<Entity> {
  const {
    finish,
    isMounted,
    markFailed,
    markSucceeded,
    start,
  } = mutationState;
  const queuesRef = useRef(new Map<string, Promise<void>>());
  const generationsRef = useRef(new Map<string, number>());
  const controllerRef = useRef(new AbortController());
  const applyRef = useRef(apply);
  const classifyErrorRef = useRef(classifyError);
  const getCurrentRef = useRef(getCurrent);
  const onErrorRef = useRef(onError);
  const onFailureRef = useRef(onFailure);
  const statusKeyRef = useRef(statusKey);

  useEffect(() => { applyRef.current = apply; }, [apply]);
  useEffect(() => { classifyErrorRef.current = classifyError; }, [classifyError]);
  useEffect(() => { getCurrentRef.current = getCurrent; }, [getCurrent]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onFailureRef.current = onFailure; }, [onFailure]);
  useEffect(() => { statusKeyRef.current = statusKey; }, [statusKey]);

  const cancel = useCallback(() => {
    controllerRef.current.abort();
    controllerRef.current = new AbortController();
  }, []);

  useEffect(() => cancel, [cancel]);

  const enqueue = useCallback((
    key: string,
    request: (current: Entity, signal: AbortSignal) => Promise<Entity>,
  ) => {
    const generation = generationsRef.current.get(key) ?? 0;
    const signal = controllerRef.current.signal;
    const issueKey = statusKeyRef.current(key);
    const prior = queuesRef.current.get(key) ?? Promise.resolve();
    start(issueKey, clearIssuesWhenIdle);

    const task = prior.then(async () => {
      if (signal.aborted || (generationsRef.current.get(key) ?? 0) !== generation) return;
      const current = getCurrentRef.current(key);
      if (!current) return;
      try {
        const result = await request(current, signal);
        signal.throwIfAborted();
        if ((generationsRef.current.get(key) ?? 0) !== generation) return;
        if (isMounted()) applyRef.current(result);
        markSucceeded(issueKey);
      } catch (error) {
        if (signal.aborted) return;
        const issue = classifyErrorRef.current(error);
        generationsRef.current.set(key, generation + 1);
        markFailed(issueKey, issue);
        if (isMounted()) {
          onErrorRef.current(error, issue, key);
          onFailureRef.current(key, issue);
        }
      }
    }).finally(() => {
      finish();
    });
    const settled = task.then(() => undefined, () => undefined);
    queuesRef.current.set(key, settled);
    void settled.finally(() => {
      if (queuesRef.current.get(key) === settled) {
        queuesRef.current.delete(key);
        generationsRef.current.delete(key);
      }
    });
  }, [clearIssuesWhenIdle, finish, isMounted, markFailed, markSucceeded, start]);

  const cancelPending = useCallback(() => {
    const pending = Promise.all([...queuesRef.current.values()]).then(() => undefined);
    cancel();
    return pending;
  }, [cancel]);

  const hasPending = useCallback((key: string) => queuesRef.current.has(key), []);

  return { cancelPending, enqueue, hasPending };
}
