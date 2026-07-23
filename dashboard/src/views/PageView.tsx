import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import { DashboardApiError } from '../api';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { RevisionRing, type RevisionState } from '../components/RevisionRing';
import { useDashboard } from '../shell/DashboardContext';
import type { Block, BlockType, JsonObject, PageDetails } from '../types';
import './PageView.css';

const BLOCK_LABELS: Record<BlockType, string> = {
  callout: 'Callout',
  code: 'Code',
  heading: 'Heading',
  text: 'Text',
  todo: 'To-do',
};

const GENERAL_MUTATION_KEY = 'general';
const TITLE_DRAFT_KEY = 'title';

function blockDraftKey(blockId: string): string {
  return `block:${blockId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The page could not be updated';
}

function AutoTextarea({
  className,
  disabled,
  label,
  onBlur,
  onChange,
  placeholder,
  spellCheck,
  value,
}: {
  className?: string;
  disabled?: boolean;
  label: string;
  onBlur?(): void;
  onChange(value: string): void;
  placeholder?: string;
  spellCheck?: boolean;
  value: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      aria-label={label}
      className={className}
      disabled={disabled}
      onBlur={onBlur}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      ref={textareaRef}
      rows={1}
      spellCheck={spellCheck}
      value={value}
    />
  );
}

function BlockEditor({
  block,
  disabled,
  onArchive,
  onChange,
  onSave,
  onToggleTodo,
  onRestore,
}: {
  block: Block;
  disabled: boolean;
  onArchive(): void;
  onChange(value: string): void;
  onRestore(): void;
  onSave(): void;
  onToggleTodo(done: boolean): void;
}) {
  const archived = block.archived_at !== null;
  const done = block.metadata.done === true;
  const editor = (
    <AutoTextarea
      className="page-block__input"
      disabled={disabled || archived}
      label={`${BLOCK_LABELS[block.block_type]} block`}
      onBlur={onSave}
      onChange={onChange}
      placeholder={block.block_type === 'heading' ? 'Heading' : 'Write something…'}
      spellCheck={block.block_type !== 'code'}
      value={block.content}
    />
  );

  return (
    <article className={`page-block page-block--${block.block_type}${archived ? ' is-archived' : ''}`}>
      <div className="page-block__gutter" aria-hidden="true">
        <span>{block.position + 1}</span>
      </div>
      <div className="page-block__body">
        {block.block_type === 'todo' ? (
          <div className="page-block__todo">
            <input
              aria-label={done ? 'Mark to-do incomplete' : 'Mark to-do complete'}
              checked={done}
              disabled={disabled || archived}
              onChange={(event) => onToggleTodo(event.target.checked)}
              type="checkbox"
            />
            {editor}
          </div>
        ) : editor}
      </div>
      <div className="page-block__actions">
        <span className="page-block__kind">{BLOCK_LABELS[block.block_type]}</span>
        {archived ? (
          <button className="text-button" disabled={disabled} onClick={onRestore} type="button">
            Restore
          </button>
        ) : (
          <button
            aria-label={`Archive ${BLOCK_LABELS[block.block_type].toLowerCase()} block`}
            className="icon-button page-block__archive"
            disabled={disabled}
            onClick={onArchive}
            type="button"
          >
            <Icon name="archive" size={16} />
          </button>
        )}
      </div>
    </article>
  );
}

function PageViewEditor({ pageId }: { pageId: string }) {
  const { api, navigate, refreshWorkspaceData, showToast } = useDashboard();
  const [page, setPage] = useState<PageDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');
  const [importanceDraft, setImportanceDraft] = useState(0.5);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [showArchivedBlocks, setShowArchivedBlocks] = useState(false);
  const [archivePrompt, setArchivePrompt] = useState(false);
  const [busyBlockIds, setBusyBlockIds] = useState<ReadonlySet<string>>(() => new Set());
  const [saveState, setSaveState] = useState<RevisionState>('saved');
  const [retryKey, setRetryKey] = useState(0);

  const mountedRef = useRef(true);
  const pageRef = useRef<PageDetails | null>(null);
  const pageRevisionRef = useRef(1);
  const titleRef = useRef('');
  const persistedTitleRef = useRef('');
  const blocksRef = useRef<Block[]>([]);
  const persistedBlockContentRef = useRef(new Map<string, string>());
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mutationAbortRef = useRef(new AbortController());
  const pendingMutationsRef = useRef(0);
  const dirtyDraftsRef = useRef(new Set<string>());
  const mutationIssuesRef = useRef(new Map<string, RevisionState>());
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blockTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const refreshSaveState = useCallback(() => {
    if (!mountedRef.current) return;
    const issues = [...mutationIssuesRef.current.values()];
    if (issues.includes('conflict')) {
      setSaveState('conflict');
    } else if (issues.includes('error')) {
      setSaveState('error');
    } else if (pendingMutationsRef.current > 0
      || titleTimerRef.current
      || blockTimersRef.current.size > 0) {
      setSaveState('saving');
    } else if (dirtyDraftsRef.current.size > 0) {
      // A dirty draft without a timer or request should only be transient, but it
      // must never be presented as persisted.
      setSaveState('saving');
    } else {
      setSaveState('saved');
    }
  }, []);

  const setDraftDirty = useCallback((key: string, dirty: boolean) => {
    if (dirty) {
      dirtyDraftsRef.current.add(key);
    } else {
      dirtyDraftsRef.current.delete(key);
      mutationIssuesRef.current.delete(key);
    }
    refreshSaveState();
  }, [refreshSaveState]);

  const updatePageState = useCallback((updater: (current: PageDetails) => PageDetails) => {
    const current = pageRef.current;
    if (!current) return;
    const next = updater(current);
    pageRef.current = next;
    pageRevisionRef.current = next.revision;
    blocksRef.current = next.blocks;
    if (mountedRef.current) setPage(next);
  }, []);

  const runMutation = useCallback(<Result,>(
    operation: (signal: AbortSignal) => Promise<Result>,
    issueKey = GENERAL_MUTATION_KEY,
  ): Promise<Result> => {
    pendingMutationsRef.current += 1;
    mutationIssuesRef.current.delete(issueKey);
    refreshSaveState();

    const signal = mutationAbortRef.current.signal;
    const execution = mutationQueueRef.current.then(() => {
      signal.throwIfAborted();
      return operation(signal);
    });
    mutationQueueRef.current = execution.then(() => undefined, () => undefined);

    void execution.then(() => {
      mutationIssuesRef.current.delete(issueKey);
    }, (error: unknown) => {
      if (signal.aborted) return;
      const issue: RevisionState = error instanceof DashboardApiError && error.code === 'CONFLICT'
        ? 'conflict'
        : 'error';
      mutationIssuesRef.current.set(issueKey, issue);
      showToast(errorMessage(error), { tone: 'error' });
    }).finally(() => {
      pendingMutationsRef.current -= 1;
      refreshSaveState();
    });

    return execution;
  }, [refreshSaveState, showToast]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setPage(null);
    setSaveState('saved');
    dirtyDraftsRef.current.clear();
    mutationIssuesRef.current.clear();
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
          loaded.blocks.map((block) => [block.id, block.content])
        );
        titleRef.current = loaded.title;
        persistedTitleRef.current = loaded.title;
        if (mountedRef.current) {
          setPage(loaded);
          setTitle(loaded.title);
          setTagsDraft(loaded.tags.join(', '));
          setImportanceDraft(loaded.importance);
          setLoading(false);
        }

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

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (pendingMutationsRef.current === 0
        && !titleTimerRef.current
        && blockTimersRef.current.size === 0
        && dirtyDraftsRef.current.size === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const applyPageRevision = useCallback((revision: number) => {
    if (revision <= pageRevisionRef.current) return;
    pageRevisionRef.current = revision;
    updatePageState((current) => ({ ...current, revision }));
  }, [updatePageState]);

  const saveTitle = useCallback(() => {
    if (titleTimerRef.current) {
      clearTimeout(titleTimerRef.current);
      titleTimerRef.current = null;
    }
    const submitted = titleRef.current.trim();
    if (!submitted) {
      const restored = persistedTitleRef.current;
      titleRef.current = restored;
      setDraftDirty(TITLE_DRAFT_KEY, false);
      if (mountedRef.current) {
        setTitle(restored);
        showToast('A page title cannot be empty', { tone: 'error' });
      }
      return;
    }
    if (submitted === persistedTitleRef.current || pageRef.current?.archived_at) {
      titleRef.current = persistedTitleRef.current;
      if (mountedRef.current) setTitle(persistedTitleRef.current);
      setDraftDirty(TITLE_DRAFT_KEY, false);
      return;
    }

    void runMutation(async (signal) => {
      const response = await api.page({
        action: 'update',
        page_id: pageId,
        revision: pageRevisionRef.current,
        title: submitted,
      }, { signal });
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
        if (mountedRef.current) setTitle(response.result.title);
      }
      setDraftDirty(
        TITLE_DRAFT_KEY,
        titleRef.current !== persistedTitleRef.current,
      );
      await refreshWorkspaceData();
      return response.result;
    }, TITLE_DRAFT_KEY);
  }, [api, pageId, refreshWorkspaceData, runMutation, setDraftDirty, showToast, updatePageState]);

  const scheduleTitleSave = useCallback((value: string) => {
    titleRef.current = value;
    setTitle(value);
    if (titleTimerRef.current) {
      clearTimeout(titleTimerRef.current);
      titleTimerRef.current = null;
    }
    setDraftDirty(TITLE_DRAFT_KEY, value !== persistedTitleRef.current);
    if (value === persistedTitleRef.current) {
      return;
    }
    titleTimerRef.current = setTimeout(saveTitle, 650);
    refreshSaveState();
  }, [refreshSaveState, saveTitle, setDraftDirty]);

  const updateLocalBlock = useCallback((blockId: string, update: (block: Block) => Block) => {
    updatePageState((current) => ({
      ...current,
      blocks: current.blocks.map((block) => block.id === blockId ? update(block) : block),
    }));
  }, [updatePageState]);

  const saveBlock = useCallback((blockId: string) => {
    const timer = blockTimersRef.current.get(blockId);
    if (timer) clearTimeout(timer);
    blockTimersRef.current.delete(blockId);
    const current = blocksRef.current.find((block) => block.id === blockId);
    if (!current || current.archived_at
      || persistedBlockContentRef.current.get(blockId) === current.content) {
      setDraftDirty(blockDraftKey(blockId), false);
      return;
    }

    void runMutation(async (signal) => {
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
      persistedBlockContentRef.current.set(blockId, response.result.block.content);
      applyPageRevision(response.result.page_revision);
      updateLocalBlock(blockId, (latest) => ({
        ...response.result.block,
        content: latest.content === submitted ? response.result.block.content : latest.content,
        metadata: latest.metadata,
      }));
      const latest = blocksRef.current.find((block) => block.id === blockId);
      setDraftDirty(
        blockDraftKey(blockId),
        latest?.content !== persistedBlockContentRef.current.get(blockId),
      );
      return response.result;
    }, blockDraftKey(blockId));
  }, [api, applyPageRevision, runMutation, setDraftDirty, updateLocalBlock]);

  const scheduleBlockSave = useCallback((blockId: string, content: string) => {
    updateLocalBlock(blockId, (block) => ({ ...block, content }));
    const existing = blockTimersRef.current.get(blockId);
    if (existing) {
      clearTimeout(existing);
      blockTimersRef.current.delete(blockId);
    }
    const dirty = content !== persistedBlockContentRef.current.get(blockId);
    setDraftDirty(blockDraftKey(blockId), dirty);
    if (!dirty) {
      return;
    }
    const timer = setTimeout(() => saveBlock(blockId), 550);
    blockTimersRef.current.set(blockId, timer);
    refreshSaveState();
  }, [refreshSaveState, saveBlock, setDraftDirty, updateLocalBlock]);

  const saveBlockMetadata = useCallback((blockId: string, metadata: JsonObject) => {
    updateLocalBlock(blockId, (block) => ({ ...block, metadata }));
    void runMutation(async (signal) => {
      const live = blocksRef.current.find((block) => block.id === blockId);
      if (!live || live.archived_at) return null;
      const response = await api.page({
        action: 'block_update',
        block_id: blockId,
        metadata,
        revision: live.revision,
      }, { signal });
      applyPageRevision(response.result.page_revision);
      updateLocalBlock(blockId, (latest) => ({
        ...response.result.block,
        content: latest.content,
        metadata: latest.metadata === metadata ? response.result.block.metadata : latest.metadata,
      }));
      return response.result;
    });
  }, [api, applyPageRevision, runMutation, updateLocalBlock]);

  const mutateBlockArchive = useCallback((blockId: string, restore: boolean) => {
    const timer = blockTimersRef.current.get(blockId);
    if (timer) clearTimeout(timer);
    blockTimersRef.current.delete(blockId);
    setBusyBlockIds((current) => new Set(current).add(blockId));
    const execution = runMutation(async (signal) => {
      let live = blocksRef.current.find((block) => block.id === blockId);
      if (!live) return null;
      if (restore ? live.archived_at === null : live.archived_at !== null) return null;

      if (!restore && persistedBlockContentRef.current.get(blockId) !== live.content) {
        const submitted = live.content;
        const updateResponse = await api.page({
          action: 'block_update',
          block_id: blockId,
          content: submitted,
          revision: live.revision,
        }, { signal });
        persistedBlockContentRef.current.set(blockId, updateResponse.result.block.content);
        applyPageRevision(updateResponse.result.page_revision);
        updateLocalBlock(blockId, (latest) => ({
          ...updateResponse.result.block,
          content: latest.content === submitted ? updateResponse.result.block.content : latest.content,
          metadata: latest.metadata,
        }));
        const latest = blocksRef.current.find((block) => block.id === blockId);
        setDraftDirty(
          blockDraftKey(blockId),
          latest?.content !== persistedBlockContentRef.current.get(blockId),
        );
        live = blocksRef.current.find((block) => block.id === blockId);
        if (!live) return null;
      }

      const response = await api.page({
        action: restore ? 'block_restore' : 'block_archive',
        block_id: blockId,
        revision: live.revision,
      }, { signal });
      applyPageRevision(response.result.page_revision);
      updateLocalBlock(blockId, () => response.result.block);
      showToast(restore ? 'Block restored' : 'Block archived');
      return response.result;
    });
    void execution.finally(() => {
      if (!mountedRef.current) return;
      setBusyBlockIds((current) => {
        const next = new Set(current);
        next.delete(blockId);
        return next;
      });
    }).catch(() => undefined);
  }, [api, applyPageRevision, runMutation, setDraftDirty, showToast, updateLocalBlock]);

  const appendBlock = useCallback((blockType: BlockType) => {
    void runMutation(async (signal) => {
      const response = await api.page({
        action: 'append',
        blocks: [{ block_type: blockType, content: '' }],
        page_id: pageId,
        revision: pageRevisionRef.current,
      }, { signal });
      applyPageRevision(response.result.page_revision);
      for (const block of response.result.blocks) {
        persistedBlockContentRef.current.set(block.id, block.content);
      }
      updatePageState((current) => ({
        ...current,
        blocks: [...current.blocks, ...response.result.blocks],
      }));
      return response.result;
    });
  }, [api, applyPageRevision, pageId, runMutation, updatePageState]);

  const saveProperties = useCallback(() => {
    const tags = [...new Set(tagsDraft.split(',').map((tag) => tag.trim()).filter(Boolean))];
    if (tags.length > 50 || tags.some((tag) => tag.length > 100)) {
      showToast('Use at most 50 tags, each no longer than 100 characters', { tone: 'error' });
      return;
    }
    void runMutation(async (signal) => {
      const response = await api.page({
        action: 'update',
        importance: importanceDraft,
        page_id: pageId,
        revision: pageRevisionRef.current,
        tags,
      }, { signal });
      pageRevisionRef.current = response.result.revision;
      updatePageState((current) => ({
        ...current,
        ...response.result,
        blocks: current.blocks,
        blocks_page: current.blocks_page,
      }));
      if (mountedRef.current) {
        setTagsDraft(response.result.tags.join(', '));
        setImportanceDraft(response.result.importance);
        setPropertiesOpen(false);
      }
      await refreshWorkspaceData();
      showToast('Page details saved');
      return response.result;
    });
  }, [api, importanceDraft, pageId, refreshWorkspaceData, runMutation, showToast, tagsDraft, updatePageState]);

  const setPageArchived = useCallback((restore: boolean) => {
    void runMutation(async (signal) => {
      const response = await api.page({
        action: restore ? 'restore' : 'archive',
        page_id: pageId,
        revision: pageRevisionRef.current,
      }, { signal });
      pageRevisionRef.current = response.result.revision;
      updatePageState((current) => ({
        ...current,
        ...response.result,
        blocks: current.blocks,
        blocks_page: current.blocks_page,
      }));
      await refreshWorkspaceData();
      showToast(restore ? 'Page restored' : 'Page moved to archive');
      if (mountedRef.current) {
        setArchivePrompt(false);
        if (!restore) navigate({ name: 'home' });
      }
      return response.result;
    });
  }, [api, navigate, pageId, refreshWorkspaceData, runMutation, showToast, updatePageState]);

  const reloadLatest = useCallback(() => {
    if (titleTimerRef.current) {
      clearTimeout(titleTimerRef.current);
      titleTimerRef.current = null;
    }
    for (const timer of blockTimersRef.current.values()) clearTimeout(timer);
    blockTimersRef.current.clear();
    dirtyDraftsRef.current.clear();
    mutationIssuesRef.current.clear();
    setLoading(true);
    mutationAbortRef.current.abort();
    const pending = mutationQueueRef.current;
    void pending.then(() => {
      if (!mountedRef.current) return;
      mutationAbortRef.current = new AbortController();
      setRetryKey((key) => key + 1);
    });
  }, []);

  useEffect(() => {
    const timers = blockTimersRef.current;
    return () => {
      if (titleTimerRef.current) saveTitle();
      for (const blockId of [...timers.keys()]) saveBlock(blockId);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [saveBlock, saveTitle]);

  if (loading) {
    return (
      <main className="page-view page-view--loading" aria-busy="true" id="main-content">
        <div className="page-skeleton page-skeleton--eyebrow" />
        <div className="page-skeleton page-skeleton--title" />
        <div className="page-skeleton page-skeleton--line" />
        <div className="page-skeleton page-skeleton--line page-skeleton--short" />
      </main>
    );
  }

  if (!page || loadError) {
    return (
      <main className="page-view page-view--error" id="main-content">
        <div className="view-message">
          <span className="view-message__mark"><Icon name="warning" /></span>
          <p className="eyebrow">Page unavailable</p>
          <h1>We couldn’t open this page.</h1>
          <p>{loadError ?? 'The page no longer exists.'}</p>
          <div className="view-message__actions">
            <button className="button button--primary" onClick={() => setRetryKey((key) => key + 1)} type="button">
              <Icon name="refresh" /> Retry
            </button>
            <button className="button" onClick={() => navigate({ name: 'home' })} type="button">
              Back to workspace
            </button>
          </div>
        </div>
      </main>
    );
  }

  const archived = page.archived_at !== null;
  const visibleBlocks = showArchivedBlocks
    ? page.blocks
    : page.blocks.filter((block) => block.archived_at === null);
  const archivedBlockCount = page.blocks.length - page.blocks.filter((block) => block.archived_at === null).length;

  return (
    <main className="page-view" id="main-content">
      {archived ? (
        <div className="archive-banner">
          <span>This page is archived and read-only.</span>
          <button
            className="text-button"
            disabled={saveState === 'saving'}
            onClick={() => setPageArchived(true)}
            type="button"
          >
            Restore page
          </button>
        </div>
      ) : null}

      <header className="page-view__header">
        <div className="page-view__breadcrumbs">
          <button className="breadcrumb-button" onClick={() => navigate({ name: 'home' })} type="button">
            {page.parent_page_id ? 'Nested page' : 'Page'}
          </button>
          <span aria-hidden="true">/</span>
          <span>rev {page.revision}</span>
        </div>
        <div className="page-view__tools">
          <RevisionRing state={saveState} />
          {saveState === 'conflict' || saveState === 'error' ? (
            <button
              aria-label="Reload latest and discard local drafts"
              className="text-button"
              onClick={reloadLatest}
              title="Discard local drafts and reload the latest saved page"
              type="button"
            >
              Reload latest
            </button>
          ) : null}
          <button
            aria-controls="page-details"
            aria-expanded={propertiesOpen}
            className="button button--quiet"
            onClick={() => setPropertiesOpen((open) => !open)}
            type="button"
          >
            Details
          </button>
          {!archived ? (
            <button
              aria-label="Archive page"
              className="icon-button"
              disabled={saveState === 'saving'}
              onClick={() => setArchivePrompt(true)}
              type="button"
            >
              <Icon name="archive" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="page-sheet">
        <div className="page-sheet__meta">
          {page.tags.length ? page.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>) : (
            <span className="page-sheet__quiet">Untyped knowledge</span>
          )}
        </div>
        <AutoTextarea
          className="page-title-input"
          disabled={archived}
          label="Page title"
          onBlur={saveTitle}
          onChange={scheduleTitleSave}
          placeholder="Untitled page"
          value={title}
        />

        {propertiesOpen ? (
          <section className="page-properties" aria-label="Page details" id="page-details">
            <label>
              <span>Tags</span>
              <input
                disabled={archived}
                onChange={(event) => setTagsDraft(event.target.value)}
                placeholder="research, architecture"
                value={tagsDraft}
              />
              <small>Separate tags with commas.</small>
            </label>
            <label>
              <span>Importance · {importanceDraft.toFixed(1)}</span>
              <input
                disabled={archived}
                max="1"
                min="0"
                onChange={(event: ChangeEvent<HTMLInputElement>) => setImportanceDraft(event.target.valueAsNumber)}
                step="0.1"
                type="range"
                value={importanceDraft}
              />
              <small>Higher importance gently improves retrieval order.</small>
            </label>
            {!archived ? (
              <button className="button button--primary" onClick={saveProperties} type="button">
                Save details
              </button>
            ) : null}
          </section>
        ) : null}

        <section className="page-blocks" aria-label="Page content" id="page-content">
          {visibleBlocks.length ? visibleBlocks.map((block) => (
            <BlockEditor
              block={block}
              disabled={archived || busyBlockIds.has(block.id)}
              key={block.id}
              onArchive={() => mutateBlockArchive(block.id, false)}
              onChange={(content) => scheduleBlockSave(block.id, content)}
              onRestore={() => mutateBlockArchive(block.id, true)}
              onSave={() => saveBlock(block.id)}
              onToggleTodo={(done) => saveBlockMetadata(block.id, { ...block.metadata, done })}
            />
          )) : (
            <div className="page-blocks__empty">
              <span className="page-blocks__sprout" aria-hidden="true">✣</span>
              <p>{archived ? 'This archived page has no active blocks.' : 'This page is open ground.'}</p>
              <span>{archived ? 'Restore the page to add content.' : 'Add a block to begin shaping it.'}</span>
            </div>
          )}
        </section>

        {!archived ? (
          <div className="block-composer" aria-label="Add a block">
            <span><Icon name="plus" size={16} /> Add</span>
            {(Object.keys(BLOCK_LABELS) as BlockType[]).map((type) => (
              <button key={type} onClick={() => appendBlock(type)} type="button">
                {BLOCK_LABELS[type]}
              </button>
            ))}
          </div>
        ) : null}

        {archivedBlockCount > 0 ? (
          <button
            aria-controls="page-content"
            aria-expanded={showArchivedBlocks}
            className="archived-blocks-toggle"
            onClick={() => setShowArchivedBlocks((shown) => !shown)}
            type="button"
          >
            {showArchivedBlocks ? 'Hide' : 'Show'} {archivedBlockCount} archived {archivedBlockCount === 1 ? 'block' : 'blocks'}
          </button>
        ) : null}
      </div>

      {archivePrompt ? (
        <Modal
          description="Agents will stop seeing it in normal reads and search. You can restore it from Archive."
          onClose={() => setArchivePrompt(false)}
          title="Archive this page?"
        >
          <div className="modal-actions">
            <button
              className="button"
              disabled={saveState === 'saving'}
              onClick={() => setArchivePrompt(false)}
              type="button"
            >
              Keep page
            </button>
            <button
              className="button button--danger"
              disabled={saveState === 'saving'}
              onClick={() => setPageArchived(false)}
              type="button"
            >
              Archive page
            </button>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}

export function PageView({ pageId }: { pageId: string }) {
  return <PageViewEditor key={pageId} pageId={pageId} />;
}
