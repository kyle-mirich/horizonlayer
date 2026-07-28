// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDebouncedAutosave, useUnsavedChangesWarning } from './useDebouncedAutosave';
import { useKeyedMutationQueue } from './useKeyedMutationQueue';
import { useMutationState, type MutationIssue } from './useMutationState';
import { useSerializedMutationQueue } from './useSerializedMutationQueue';

function deferred<Result>() {
  let resolve!: (value: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function classifyError(error: unknown): MutationIssue {
  return error instanceof Error && error.message === 'conflict' ? 'conflict' : 'error';
}

afterEach(() => {
  vi.useRealTimers();
});

describe('editor mutation state', () => {
  it('serializes rapid mutations and lets each request read the applied revision', async () => {
    let revision = 1;
    const first = deferred<number>();
    const requestRevisions: number[] = [];
    const onError = vi.fn();
    const { result } = renderHook(() => {
      const mutationState = useMutationState();
      const mutations = useSerializedMutationQueue({
        classifyError,
        mutationState,
        onError,
      });
      return { mutationState, mutations };
    });

    let firstResult!: Promise<number | undefined>;
    let secondResult!: Promise<number | undefined>;
    act(() => {
      firstResult = result.current.mutations.run(async () => {
        requestRevisions.push(revision);
        return first.promise;
      }, { onSuccess: (next) => { revision = next; } });
      secondResult = result.current.mutations.run(async () => {
        requestRevisions.push(revision);
        return revision + 1;
      }, { onSuccess: (next) => { revision = next; } });
    });

    await waitFor(() => expect(requestRevisions).toEqual([1]));
    await act(async () => {
      first.resolve(2);
      await firstResult;
      await secondResult;
    });

    expect(requestRevisions).toEqual([1, 2]);
    expect(revision).toBe(3);
    expect(result.current.mutationState.saveState).toBe('saved');
    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores a stale response after cancellation even when the request ignores its signal', async () => {
    const response = deferred<string>();
    const applied = vi.fn();
    const { result } = renderHook(() => {
      const mutationState = useMutationState();
      return useSerializedMutationQueue({
        classifyError,
        mutationState,
        onError: vi.fn(),
      });
    });

    let execution!: Promise<string | undefined>;
    act(() => {
      execution = result.current.run(() => response.promise, { onSuccess: applied });
    });
    await act(async () => {
      const pending = result.current.cancelPending();
      response.resolve('stale');
      await pending;
      await execution;
    });

    expect(applied).not.toHaveBeenCalled();
  });

  it('reports failed mutations without leaking rejected promises', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => {
      const mutationState = useMutationState();
      const mutations = useSerializedMutationQueue({
        classifyError,
        mutationState,
        onError,
      });
      return { mutationState, mutations };
    });

    let execution!: Promise<undefined | void>;
    await act(async () => {
      execution = result.current.mutations.run(async () => {
        throw new Error('offline');
      });
      await execution;
    });

    await expect(execution).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }), 'error');
    expect(result.current.mutationState.saveState).toBe('error');
  });

  it('finishes queued work after unmount when aborting is disabled', async () => {
    const response = deferred<string>();
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const onSuccessAfterUnmount = vi.fn();
    const { result, unmount } = renderHook(() => {
      const mutationState = useMutationState();
      return useSerializedMutationQueue({
        abortOnUnmount: false,
        classifyError,
        mutationState,
        onError,
      });
    });

    let successExecution!: Promise<string | undefined>;
    let failureExecution!: Promise<string | undefined>;
    act(() => {
      successExecution = result.current.run(() => response.promise, {
        onSuccess,
        onSuccessAfterUnmount,
      });
      failureExecution = result.current.run(async () => {
        throw new Error('late failure');
      });
    });
    unmount();

    await act(async () => {
      response.resolve('persisted');
      await expect(successExecution).resolves.toBe('persisted');
      await expect(failureExecution).resolves.toBeUndefined();
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onSuccessAfterUnmount).toHaveBeenCalledWith('persisted');
    expect(onError).not.toHaveBeenCalled();
  });

  it('cancels mutations queued behind a failure when configured', async () => {
    const onError = vi.fn();
    const queuedRequest = vi.fn(async () => 'should not run');
    const { result } = renderHook(() => {
      const mutationState = useMutationState();
      const mutations = useSerializedMutationQueue({
        cancelOnError: true,
        classifyError,
        mutationState,
        onError,
      });
      return { mutationState, mutations };
    });

    let failedExecution!: Promise<string | undefined>;
    let cancelledExecution!: Promise<string | undefined>;
    await act(async () => {
      failedExecution = result.current.mutations.run(async () => {
        throw new Error('conflict');
      }, { issueKey: 'first' });
      cancelledExecution = result.current.mutations.run(queuedRequest, { issueKey: 'second' });
      await expect(failedExecution).resolves.toBeUndefined();
      await expect(cancelledExecution).resolves.toBeUndefined();
    });

    expect(queuedRequest).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'conflict' }), 'conflict');
    expect(result.current.mutationState.saveState).toBe('conflict');
  });

  it('clears idle issues, recognizes dirty-only work, and resets all state', () => {
    const { result } = renderHook(() => useMutationState());

    act(() => result.current.markFailed('old-write', 'conflict'));
    expect(result.current.saveState).toBe('conflict');
    act(() => result.current.start('retry', true));
    expect(result.current.saveState).toBe('saving');
    act(() => result.current.finish());
    expect(result.current.saveState).toBe('saved');

    act(() => result.current.setDirty('draft', true));
    expect(result.current.hasUnsavedWork()).toBe(true);
    expect(result.current.saveState).toBe('saving');
    act(() => result.current.reset());
    expect(result.current.hasUnsavedWork()).toBe(false);
    expect(result.current.saveState).toBe('saved');
  });
});

describe('debounced autosave', () => {
  it('replaces rapid drafts deterministically and tracks dirty work until persistence', () => {
    vi.useFakeTimers();
    const saves: string[] = [];
    const { result } = renderHook(() => {
      const mutationState = useMutationState();
      const autosave = useDebouncedAutosave({ mutationState });
      useUnsavedChangesWarning(mutationState.hasUnsavedWork);
      return { autosave, mutationState };
    });

    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);

    act(() => {
      result.current.autosave.schedule('title', true, () => saves.push('first'), 650);
      result.current.autosave.schedule('title', true, () => saves.push('latest'), 650);
    });
    expect(result.current.mutationState.saveState).toBe('saving');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    act(() => vi.advanceTimersByTime(650));
    expect(saves).toEqual(['latest']);
    act(() => result.current.mutationState.setDirty('title', false));
    expect(result.current.mutationState.saveState).toBe('saved');
  });

  it('flushes pending drafts and discards or ignores work that should not save', () => {
    vi.useFakeTimers();
    const cleanSave = vi.fn();
    const flushedSave = vi.fn();
    const discardedSave = vi.fn();
    const { result } = renderHook(() => {
      const mutationState = useMutationState();
      const autosave = useDebouncedAutosave({ mutationState });
      return { autosave, mutationState };
    });

    expect(result.current.autosave.flush('missing')).toBe(false);
    act(() => result.current.autosave.schedule('clean', false, cleanSave, 100));
    expect(cleanSave).not.toHaveBeenCalled();
    expect(result.current.mutationState.saveState).toBe('saved');

    act(() => result.current.autosave.schedule('flush', true, flushedSave, 100));
    act(() => expect(result.current.autosave.flush('flush')).toBe(true));
    act(() => vi.advanceTimersByTime(100));
    expect(flushedSave).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.autosave.schedule('discard-a', true, discardedSave, 100);
      result.current.autosave.schedule('discard-b', true, discardedSave, 100);
      result.current.autosave.cancel('discard-a');
      result.current.autosave.discardAll();
      vi.runAllTimers();
    });
    expect(discardedSave).not.toHaveBeenCalled();
    act(() => {
      result.current.mutationState.setDirty('flush', false);
      result.current.mutationState.setDirty('discard-a', false);
      result.current.mutationState.setDirty('discard-b', false);
    });
    expect(result.current.mutationState.saveState).toBe('saved');
  });

  it('flushes a scheduled draft exactly once during unmount', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const { result, unmount } = renderHook(() => {
      const mutationState = useMutationState();
      return useDebouncedAutosave({ flushOnUnmount: true, mutationState });
    });

    act(() => result.current.schedule('block:1', true, save, 550));
    unmount();
    vi.runAllTimers();

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('cancels a scheduled draft during unmount by default', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const { result, unmount } = renderHook(() => {
      const mutationState = useMutationState();
      return useDebouncedAutosave({ mutationState });
    });

    act(() => result.current.schedule('block:1', true, save, 550));
    unmount();
    vi.runAllTimers();

    expect(save).not.toHaveBeenCalled();
  });
});

describe('keyed mutation queues', () => {
  it('uses authoritative per-key state and drops writes queued behind a failure', async () => {
    type Row = { id: string; revision: number; value: string };
    const rows = new Map<string, Row>([['row-1', { id: 'row-1', revision: 1, value: 'a' }]]);
    const first = deferred<Row>();
    const requestedRevisions: number[] = [];
    const onError = vi.fn();
    const onFailure = vi.fn();
    const { result } = renderHook(() => {
      const mutationState = useMutationState();
      const queue = useKeyedMutationQueue<Row>({
        apply: (row) => rows.set(row.id, row),
        classifyError,
        getCurrent: (id) => rows.get(id) ?? null,
        mutationState,
        onError,
        onFailure,
      });
      return { mutationState, queue };
    });

    act(() => {
      result.current.queue.enqueue('row-1', async (row) => {
        requestedRevisions.push(row.revision);
        return first.promise;
      });
      result.current.queue.enqueue('row-1', async (row) => {
        requestedRevisions.push(row.revision);
        return { ...row, revision: row.revision + 1, value: 'c' };
      });
    });
    await waitFor(() => expect(requestedRevisions).toEqual([1]));
    act(() => first.resolve({ id: 'row-1', revision: 2, value: 'b' }));
    await waitFor(() => expect(requestedRevisions).toEqual([1, 2]));
    await waitFor(() => expect(rows.get('row-1')).toMatchObject({ revision: 3, value: 'c' }));
    expect(requestedRevisions).toEqual([1, 2]);
    expect(rows.get('row-1')).toMatchObject({ revision: 3, value: 'c' });

    const failure = deferred<Row>();
    act(() => {
      result.current.queue.enqueue('row-1', () => failure.promise);
      result.current.queue.enqueue('row-1', async (row) => ({ ...row, revision: 99 }));
    });
    act(() => failure.reject(new Error('conflict')));
    await waitFor(() => expect(onFailure).toHaveBeenCalledWith('row-1', 'conflict'));
    expect(rows.get('row-1')?.revision).toBe(3);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'conflict' }), 'conflict', 'row-1');
    expect(onFailure).toHaveBeenCalledWith('row-1', 'conflict');
    expect(result.current.mutationState.saveState).toBe('conflict');
  });

  it('skips missing entities and aborts in-flight work during cancellation', async () => {
    type Row = { id: string; revision: number };
    const rows = new Map<string, Row>();
    const response = deferred<Row>();
    const apply = vi.fn((row: Row) => rows.set(row.id, row));
    const request = vi.fn(async (_row: Row, _signal: AbortSignal) => response.promise);
    const missingRequest = vi.fn(async (row: Row) => row);
    const onError = vi.fn();
    const onFailure = vi.fn();
    const { result } = renderHook(() => {
      const mutationState = useMutationState();
      const queue = useKeyedMutationQueue<Row>({
        apply,
        classifyError,
        getCurrent: (id) => rows.get(id) ?? null,
        mutationState,
        onError,
        onFailure,
      });
      return { mutationState, queue };
    });

    act(() => result.current.queue.enqueue('missing', missingRequest));
    expect(result.current.queue.hasPending('missing')).toBe(true);
    await waitFor(() => expect(result.current.queue.hasPending('missing')).toBe(false));
    expect(missingRequest).not.toHaveBeenCalled();

    rows.set('row-1', { id: 'row-1', revision: 1 });
    act(() => result.current.queue.enqueue('row-1', request));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const signal = request.mock.calls[0]?.[1];
    await act(async () => {
      const cancelled = result.current.queue.cancelPending();
      response.resolve({ id: 'row-1', revision: 2 });
      await cancelled;
    });

    expect(signal?.aborted).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.queue.hasPending('row-1')).toBe(false));
    expect(result.current.mutationState.saveState).toBe('saved');
  });
});
