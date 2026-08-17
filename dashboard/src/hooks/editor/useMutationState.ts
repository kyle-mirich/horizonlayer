import { useCallback, useEffect, useRef, useState } from 'react';

import type { RevisionState } from '../../components/RevisionRing';

export type MutationIssue = Extract<RevisionState, 'conflict' | 'error'>;

export interface MutationStateController {
  finish(): void;
  hasUnsavedWork(): boolean;
  isMounted(): boolean;
  markFailed(key: string, issue: MutationIssue): void;
  markSucceeded(key: string): void;
  reset(): void;
  saveState: RevisionState;
  setDirty(key: string, dirty: boolean): void;
  setScheduled(key: string, scheduled: boolean): void;
  start(key: string, clearIssuesWhenIdle?: boolean): void;
}

export function useMutationState(): MutationStateController {
  const [saveState, setSaveState] = useState<RevisionState>('saved');
  const mountedRef = useRef(true);
  const pendingRef = useRef(0);
  const dirtyKeysRef = useRef(new Set<string>());
  const scheduledKeysRef = useRef(new Set<string>());
  const issuesRef = useRef(new Map<string, MutationIssue>());

  const refresh = useCallback(() => {
    if (!mountedRef.current) return;
    const issues = [...issuesRef.current.values()];
    if (issues.includes('conflict')) {
      setSaveState('conflict');
    } else if (issues.includes('error')) {
      setSaveState('error');
    } else if (pendingRef.current > 0
      || scheduledKeysRef.current.size > 0
      || dirtyKeysRef.current.size > 0) {
      setSaveState('saving');
    } else {
      setSaveState('saved');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const start = useCallback((key: string, clearIssuesWhenIdle = false) => {
    if (clearIssuesWhenIdle && pendingRef.current === 0) issuesRef.current.clear();
    pendingRef.current += 1;
    issuesRef.current.delete(key);
    refresh();
  }, [refresh]);

  const finish = useCallback(() => {
    pendingRef.current = Math.max(0, pendingRef.current - 1);
    refresh();
  }, [refresh]);

  const markSucceeded = useCallback((key: string) => {
    issuesRef.current.delete(key);
    refresh();
  }, [refresh]);

  const markFailed = useCallback((key: string, issue: MutationIssue) => {
    issuesRef.current.set(key, issue);
    refresh();
  }, [refresh]);

  const setDirty = useCallback((key: string, dirty: boolean) => {
    if (dirty) {
      dirtyKeysRef.current.add(key);
    } else {
      dirtyKeysRef.current.delete(key);
      issuesRef.current.delete(key);
    }
    refresh();
  }, [refresh]);

  const setScheduled = useCallback((key: string, scheduled: boolean) => {
    if (scheduled) scheduledKeysRef.current.add(key);
    else scheduledKeysRef.current.delete(key);
    refresh();
  }, [refresh]);

  const reset = useCallback(() => {
    pendingRef.current = 0;
    dirtyKeysRef.current.clear();
    scheduledKeysRef.current.clear();
    issuesRef.current.clear();
    refresh();
  }, [refresh]);

  const hasUnsavedWork = useCallback(() => pendingRef.current > 0
    || scheduledKeysRef.current.size > 0
    || dirtyKeysRef.current.size > 0, []);
  const isMounted = useCallback(() => mountedRef.current, []);

  return {
    finish,
    hasUnsavedWork,
    isMounted,
    markFailed,
    markSucceeded,
    reset,
    saveState,
    setDirty,
    setScheduled,
    start,
  };
}
