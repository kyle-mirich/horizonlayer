import { useCallback, useEffect, useRef } from 'react';

import type { MutationStateController } from './useMutationState';

interface PendingSave {
  save(): void;
  timer: ReturnType<typeof setTimeout>;
}

interface DebouncedAutosaveOptions {
  flushOnUnmount?: boolean;
  mutationState: MutationStateController;
}

export interface DebouncedAutosave {
  cancel(key: string): void;
  discardAll(): void;
  flush(key: string): boolean;
  schedule(key: string, dirty: boolean, save: () => void, delay: number): void;
}

export function useDebouncedAutosave({
  flushOnUnmount = false,
  mutationState,
}: DebouncedAutosaveOptions): DebouncedAutosave {
  const { setDirty, setScheduled } = mutationState;
  const pendingRef = useRef(new Map<string, PendingSave>());

  const cancel = useCallback((key: string) => {
    const pending = pendingRef.current.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRef.current.delete(key);
    setScheduled(key, false);
  }, [setScheduled]);

  const flush = useCallback((key: string): boolean => {
    const pending = pendingRef.current.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingRef.current.delete(key);
    setScheduled(key, false);
    pending.save();
    return true;
  }, [setScheduled]);

  const schedule = useCallback((
    key: string,
    dirty: boolean,
    save: () => void,
    delay: number,
  ) => {
    cancel(key);
    setDirty(key, dirty);
    if (!dirty) return;
    const timer = setTimeout(() => {
      pendingRef.current.delete(key);
      setScheduled(key, false);
      save();
    }, delay);
    pendingRef.current.set(key, { save, timer });
    setScheduled(key, true);
  }, [cancel, setDirty, setScheduled]);

  const discardAll = useCallback(() => {
    for (const [key, pending] of pendingRef.current) {
      clearTimeout(pending.timer);
      setScheduled(key, false);
    }
    pendingRef.current.clear();
  }, [setScheduled]);

  useEffect(() => () => {
    const pending = [...pendingRef.current.entries()];
    pendingRef.current.clear();
    for (const [key, save] of pending) {
      clearTimeout(save.timer);
      setScheduled(key, false);
      if (flushOnUnmount) save.save();
    }
  }, [flushOnUnmount, setScheduled]);

  return { cancel, discardAll, flush, schedule };
}

export function useUnsavedChangesWarning(hasUnsavedWork: () => boolean): void {
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedWork]);
}
