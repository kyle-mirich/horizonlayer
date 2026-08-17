import { useCallback, useEffect, useRef, useState } from 'react';

import { DashboardApiError } from '../../api';
import { useDebouncedAutosave, useUnsavedChangesWarning } from '../../hooks/editor/useDebouncedAutosave';
import { useMutationState, type MutationIssue } from '../../hooks/editor/useMutationState';
import { useSerializedMutationQueue } from '../../hooks/editor/useSerializedMutationQueue';
import { useDashboard } from '../../shell/DashboardContext';
import type { Block, BlockType, JsonObject, PageDetails } from '../../types';

const TITLE_DRAFT_KEY = 'title';

function blockDraftKey(blockId: string): string {
  return `block:${blockId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The page could not be updated';
}

function classifyError(error: unknown): MutationIssue {
  return error instanceof DashboardApiError && error.code === 'CONFLICT'
    ? 'conflict'
    : 'error';
}

export function usePageEditor(pageId: string) {
  const { api, navigate, refreshWorkspaceData, showToast } = useDashboard();
  const [page, setPage] = useState<PageDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');
  const [importanceDraft, setImportanceDraft] = useState(0.5);
  const [busyBlockIds, setBusyBlockIds] = useState<ReadonlySet<string>>(() => new Set());
  const [retryKey, setRetryKey] = useState(0);

  const pageRef = useRef<PageDetails | null>(null);
  const pageRevisionRef = useRef(1);
  const titleRef = useRef('');
  const persistedTitleRef = useRef('');
  const blocksRef = useRef<Block[]>([]);
  const persistedBlockContentRef = useRef(new Map<string, string>());

  const mutationState = useMutationState();
  const {
    hasUnsavedWork,
    isMounted,
    reset: resetMutationState,
    saveState,
    setDirty,
  } = mutationState;
  const handleMutationError = useCallback((error: unknown) => {
    showToast(errorMessage(error), { tone: 'error' });
  }, [showToast]);
  const mutations = useSerializedMutationQueue({
    abortOnUnmount: false,
    classifyError,
    mutationState,
    onError: handleMutationError,
  });
  const autosave = useDebouncedAutosave({
    flushOnUnmount: true,
    mutationState,
  });
  useUnsavedChangesWarning(hasUnsavedWork);

  const updatePageState = useCallback((updater: (current: PageDetails) => PageDetails) => {
    const current = pageRef.current;
    if (!current) return;
    const next = updater(current);
    pageRef.current = next;
    pageRevisionRef.current = next.revision;
    blocksRef.current = next.blocks;
    if (isMounted()) setPage(next);
  }, [isMounted]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setPage(null);
    pageRef.current = null;
    pageRevisionRef.current = 1;
    blocksRef.current = [];
    persistedBlockContentRef.current = new Map();
    titleRef.current = '';
    persistedTitleRef.current = '';

    void (async () => {
      try {
        const first = await api.page({
          action: 'get',
          block_limit: 50,
          include_archived: true,
          page_id: pageId,
        }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const loaded = first.result;
        pageRef.current = loaded;
        pageRevisionRef.current = loaded.revision;
        blocksRef.current = loaded.blocks;
        persistedBlockContentRef.current = new Map(
          loaded.blocks.map((block) => [block.id, block.content]),
        );
        titleRef.current = loaded.title;
        persistedTitleRef.current = loaded.title;
        setPage(loaded);
        setTitle(loaded.title);
        setTagsDraft(loaded.tags.join(', '));
        setImportanceDraft(loaded.importance);
        setLoading(false);

        let blockPage = first.result.blocks_page;
        while (blockPage.has_more && blockPage.next_offset !== null) {
          const next = await api.page({
            action: 'get',
            block_limit: 50,
            block_offset: blockPage.next_offset,
            include_archived: true,
            page_id: pageId,
          }, { signal: controller.signal });
          if (controller.signal.aborted) return;
          for (const block of next.result.blocks) {
            persistedBlockContentRef.current.set(block.id, block.content);
          }
          blockPage = next.result.blocks_page;
          updatePageState((current) => {
            const loadedBlockIds = new Set(current.blocks.map((block) => block.id));
            const appended = next.result.blocks.filter((block) => !loadedBlockIds.has(block.id));
            return {
              ...current,
              blocks: [...current.blocks, ...appended],
              blocks_page: blockPage,
            };
          });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (pageRef.current) {
          showToast('Some page blocks could not be loaded. Reload to try again.', { tone: 'error' });
        } else {
          setLoadError(errorMessage(error));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [api, pageId, retryKey, showToast, updatePageState]);

  const applyPageRevision = useCallback((revision: number) => {
    if (revision <= pageRevisionRef.current) return;
    pageRevisionRef.current = revision;
    updatePageState((current) => ({ ...current, revision }));
  }, [updatePageState]);

  const persistTitle = useCallback(() => {
    const submitted = titleRef.current.trim();
    if (!submitted) {
      const restored = persistedTitleRef.current;
      titleRef.current = restored;
      setDirty(TITLE_DRAFT_KEY, false);
      if (isMounted()) {
        setTitle(restored);
        showToast('A page title cannot be empty', { tone: 'error' });
      }
      return;
    }
    if (submitted === persistedTitleRef.current || pageRef.current?.archived_at) {
      titleRef.current = persistedTitleRef.current;
      if (isMounted()) setTitle(persistedTitleRef.current);
      setDirty(TITLE_DRAFT_KEY, false);
      return;
    }

    void mutations.run((signal) => api.page({
      action: 'update',
      page_id: pageId,
      revision: pageRevisionRef.current,
      title: submitted,
    }, { signal }), {
      issueKey: TITLE_DRAFT_KEY,
      onSuccess: async (response) => {
        persistedTitleRef.current = response.result.title;
        pageRevisionRef.current = response.result.revision;
        updatePageState((current) => ({
          ...current,
          ...response.result,
          blocks: current.blocks,
          blocks_page: current.blocks_page,
        }));
        if (titleRef.current.trim() === submitted) {
          titleRef.current = response.result.title;
          setTitle(response.result.title);
        }
        setDirty(
          TITLE_DRAFT_KEY,
          titleRef.current !== persistedTitleRef.current,
        );
        await refreshWorkspaceData();
      },
      onSuccessAfterUnmount: refreshWorkspaceData,
    });
  }, [
    api,
    isMounted,
    mutations,
    pageId,
    refreshWorkspaceData,
    showToast,
    setDirty,
    updatePageState,
  ]);

  const saveTitle = useCallback(() => {
    if (!autosave.flush(TITLE_DRAFT_KEY)) persistTitle();
  }, [autosave, persistTitle]);

  const scheduleTitleSave = useCallback((value: string) => {
    titleRef.current = value;
    setTitle(value);
    autosave.schedule(
      TITLE_DRAFT_KEY,
      value !== persistedTitleRef.current,
      persistTitle,
      650,
    );
  }, [autosave, persistTitle]);

  const updateLocalBlock = useCallback((blockId: string, update: (block: Block) => Block) => {
    updatePageState((current) => ({
      ...current,
      blocks: current.blocks.map((block) => block.id === blockId ? update(block) : block),
    }));
  }, [updatePageState]);

  const persistBlock = useCallback((blockId: string) => {
    const current = blocksRef.current.find((block) => block.id === blockId);
    if (!current || current.archived_at
      || persistedBlockContentRef.current.get(blockId) === current.content) {
      setDirty(blockDraftKey(blockId), false);
      return;
    }

    void mutations.run(async (signal) => {
      const live = blocksRef.current.find((block) => block.id === blockId);
      if (!live || live.archived_at) return null;
      const submitted = live.content;
      if (persistedBlockContentRef.current.get(blockId) === submitted) return null;
      const response = await api.page({
        action: 'block_update',
        block_id: blockId,
        content: submitted,
        revision: live.revision,
      }, { signal });
      return { response, submitted };
    }, {
      issueKey: blockDraftKey(blockId),
      onSuccess: (result) => {
        if (result) {
          const { response, submitted } = result;
          persistedBlockContentRef.current.set(blockId, response.result.block.content);
          applyPageRevision(response.result.page_revision);
          updateLocalBlock(blockId, (latest) => ({
            ...response.result.block,
            content: latest.content === submitted ? response.result.block.content : latest.content,
            metadata: latest.metadata,
          }));
        }
        const latest = blocksRef.current.find((block) => block.id === blockId);
        setDirty(
          blockDraftKey(blockId),
          latest?.content !== persistedBlockContentRef.current.get(blockId),
        );
      },
    });
  }, [api, applyPageRevision, mutations, setDirty, updateLocalBlock]);

  const saveBlock = useCallback((blockId: string) => {
    if (!autosave.flush(blockDraftKey(blockId))) persistBlock(blockId);
  }, [autosave, persistBlock]);

  const scheduleBlockSave = useCallback((blockId: string, content: string) => {
    updateLocalBlock(blockId, (block) => ({ ...block, content }));
    autosave.schedule(
      blockDraftKey(blockId),
      content !== persistedBlockContentRef.current.get(blockId),
      () => persistBlock(blockId),
      550,
    );
  }, [autosave, persistBlock, updateLocalBlock]);

  const saveBlockMetadata = useCallback((blockId: string, metadata: JsonObject) => {
    updateLocalBlock(blockId, (block) => ({ ...block, metadata }));
    void mutations.run(async (signal) => {
      const live = blocksRef.current.find((block) => block.id === blockId);
      if (!live || live.archived_at) return null;
      const response = await api.page({
        action: 'block_update',
        block_id: blockId,
        metadata,
        revision: live.revision,
      }, { signal });
      return response;
    }, {
      onSuccess: (response) => {
        if (!response) return;
        applyPageRevision(response.result.page_revision);
        updateLocalBlock(blockId, (latest) => ({
          ...response.result.block,
          content: latest.content,
          metadata: latest.metadata === metadata ? response.result.block.metadata : latest.metadata,
        }));
      },
    });
  }, [api, applyPageRevision, mutations, updateLocalBlock]);

  const mutateBlockArchive = useCallback((blockId: string, restore: boolean) => {
    autosave.cancel(blockDraftKey(blockId));
    setBusyBlockIds((current) => new Set(current).add(blockId));
    const execution = mutations.run(async (signal) => {
      let live = blocksRef.current.find((block) => block.id === blockId);
      if (!live) return null;
      if (restore ? live.archived_at === null : live.archived_at !== null) return null;

      let contentUpdate: Awaited<ReturnType<typeof api.page>> | null = null;
      let submitted: string | null = null;
      if (!restore && persistedBlockContentRef.current.get(blockId) !== live.content) {
        submitted = live.content;
        contentUpdate = await api.page({
          action: 'block_update',
          block_id: blockId,
          content: submitted,
          revision: live.revision,
        }, { signal });
        signal.throwIfAborted();
        live = contentUpdate.result.block;
      }

      const archiveResponse = await api.page({
        action: restore ? 'block_restore' : 'block_archive',
        block_id: blockId,
        revision: live.revision,
      }, { signal });
      return { archiveResponse, contentUpdate, submitted };
    }, {
      onSuccess: (result) => {
        if (!result) return;
        const { archiveResponse, contentUpdate, submitted } = result;
        if (contentUpdate && submitted !== null) {
          persistedBlockContentRef.current.set(blockId, contentUpdate.result.block.content);
          applyPageRevision(contentUpdate.result.page_revision);
          updateLocalBlock(blockId, (latest) => ({
            ...contentUpdate.result.block,
            content: latest.content === submitted ? contentUpdate.result.block.content : latest.content,
            metadata: latest.metadata,
          }));
        }
        applyPageRevision(archiveResponse.result.page_revision);
        updateLocalBlock(blockId, () => archiveResponse.result.block);
        setDirty(blockDraftKey(blockId), false);
        showToast(restore ? 'Block restored' : 'Block archived');
      },
    });
    void execution.finally(() => {
      if (!isMounted()) return;
      setBusyBlockIds((current) => {
        const next = new Set(current);
        next.delete(blockId);
        return next;
      });
    });
  }, [
    api,
    applyPageRevision,
    autosave,
    isMounted,
    mutations,
    setDirty,
    showToast,
    updateLocalBlock,
  ]);

  const appendBlock = useCallback((blockType: BlockType) => {
    void mutations.run((signal) => api.page({
      action: 'append',
      blocks: [{ block_type: blockType, content: '' }],
      page_id: pageId,
      revision: pageRevisionRef.current,
    }, { signal }), {
      onSuccess: (response) => {
        applyPageRevision(response.result.page_revision);
        for (const block of response.result.blocks) {
          persistedBlockContentRef.current.set(block.id, block.content);
        }
        updatePageState((current) => ({
          ...current,
          blocks: [...current.blocks, ...response.result.blocks],
        }));
      },
    });
  }, [api, applyPageRevision, mutations, pageId, updatePageState]);

  const saveProperties = useCallback((onSaved?: () => void) => {
    const tags = [...new Set(tagsDraft.split(',').map((tag) => tag.trim()).filter(Boolean))];
    if (tags.length > 50 || tags.some((tag) => tag.length > 100)) {
      showToast('Use at most 50 tags, each no longer than 100 characters', { tone: 'error' });
      return;
    }
    void mutations.run((signal) => api.page({
      action: 'update',
      importance: importanceDraft,
      page_id: pageId,
      revision: pageRevisionRef.current,
      tags,
    }, { signal }), {
      onSuccess: async (response) => {
        pageRevisionRef.current = response.result.revision;
        updatePageState((current) => ({
          ...current,
          ...response.result,
          blocks: current.blocks,
          blocks_page: current.blocks_page,
        }));
        setTagsDraft(response.result.tags.join(', '));
        setImportanceDraft(response.result.importance);
        onSaved?.();
        await refreshWorkspaceData();
        showToast('Page details saved');
      },
    });
  }, [api, importanceDraft, mutations, pageId, refreshWorkspaceData, showToast, tagsDraft, updatePageState]);

  const setPageArchived = useCallback((restore: boolean, onSaved?: () => void) => {
    void mutations.run((signal) => api.page({
      action: restore ? 'restore' : 'archive',
      page_id: pageId,
      revision: pageRevisionRef.current,
    }, { signal }), {
      onSuccess: async (response) => {
        pageRevisionRef.current = response.result.revision;
        updatePageState((current) => ({
          ...current,
          ...response.result,
          blocks: current.blocks,
          blocks_page: current.blocks_page,
        }));
        await refreshWorkspaceData();
        showToast(restore ? 'Page restored' : 'Page moved to archive');
        onSaved?.();
        if (!restore) navigate({ name: 'home' });
      },
    });
  }, [api, mutations, navigate, pageId, refreshWorkspaceData, showToast, updatePageState]);

  const reloadLatest = useCallback(() => {
    autosave.discardAll();
    setLoading(true);
    void mutations.cancelPending().then(() => {
      if (!isMounted()) return;
      resetMutationState();
      setRetryKey((key) => key + 1);
    });
  }, [autosave, isMounted, mutations, resetMutationState]);

  const retryLoad = useCallback(() => setRetryKey((key) => key + 1), []);

  return {
    appendBlock,
    busyBlockIds,
    importanceDraft,
    loadError,
    loading,
    mutateBlockArchive,
    page,
    reloadLatest,
    retryLoad,
    saveBlock,
    saveBlockMetadata,
    saveProperties,
    saveState,
    saveTitle,
    scheduleBlockSave,
    scheduleTitleSave,
    setImportanceDraft,
    setPageArchived,
    setTagsDraft,
    tagsDraft,
    title,
  };
}
