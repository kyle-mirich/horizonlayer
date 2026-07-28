// @vitest-environment jsdom

import type { PropsWithChildren } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DashboardApiClient, DashboardRequestOptions } from '../../api';
import { DashboardViewContext, type DashboardViewContextValue } from '../../shell/DashboardContext';
import type { Block, PageDetails, PageInput, Workspace } from '../../types';
import { PageDetailsPanel } from './PageDetailsPanel';
import { usePageEditor } from './usePageEditor';

const NOW = '2026-07-27T00:00:00.000Z';
const PAGE_ID = 'page-1';

function success(action: string, result: unknown) {
  return { action, error: null, meta: {}, ok: true as const, result };
}

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    archived_at: null,
    block_type: 'text',
    content: 'First thought',
    created_at: NOW,
    id: 'block-1',
    metadata: {},
    page_id: PAGE_ID,
    position: 0,
    revision: 2,
    updated_at: NOW,
    ...overrides,
  };
}

function makePage(overrides: Partial<PageDetails> = {}): PageDetails {
  return {
    archived_at: null,
    blocks: [makeBlock()],
    blocks_page: { has_more: false, limit: 50, next_offset: null, offset: 0 },
    created_at: NOW,
    id: PAGE_ID,
    importance: 0.5,
    parent_page_id: null,
    revision: 3,
    session_id: null,
    tags: ['notes'],
    title: 'Field notes',
    updated_at: NOW,
    workspace_id: 'workspace-1',
    ...overrides,
  };
}

type PageApi = (
  input: PageInput,
  options?: DashboardRequestOptions,
) => Promise<unknown>;

function deferred<Result>() {
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function renderEditor(pageImpl: PageApi) {
  const page = vi.fn<PageApi>(pageImpl);
  const navigate = vi.fn<DashboardViewContextValue['navigate']>();
  const refreshWorkspaceData = vi.fn(async () => undefined);
  const showToast = vi.fn<DashboardViewContextValue['showToast']>();
  const workspace: Workspace = {
    archived_at: null,
    created_at: NOW,
    description: null,
    icon: null,
    id: 'workspace-1',
    name: 'Research',
    revision: 1,
    updated_at: NOW,
  };
  const value: DashboardViewContextValue = {
    api: { page } as unknown as DashboardApiClient,
    navigate,
    refreshWorkspaceData,
    showToast,
    workspace,
  };
  const wrapper = ({ children }: PropsWithChildren) => (
    <DashboardViewContext.Provider value={value}>{children}</DashboardViewContext.Provider>
  );
  return {
    ...renderHook(() => usePageEditor(PAGE_ID), { wrapper }),
    navigate,
    page,
    refreshWorkspaceData,
    showToast,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('page editor edge behavior', () => {
  it('keeps archived page details read-only', () => {
    const onChangeImportance = vi.fn();
    const onChangeTags = vi.fn();
    const onSave = vi.fn();
    const view = render(
      <PageDetailsPanel
        archived={false}
        importance={0.5}
        onChangeImportance={onChangeImportance}
        onChangeTags={onChangeTags}
        onSave={onSave}
        tags="notes"
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: /^Tags/ }), { target: { value: 'new' } });
    fireEvent.change(screen.getByRole('slider', { name: /^Importance · 0.5/ }), {
      target: { value: '0.8', valueAsNumber: 0.8 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    expect(onChangeTags).toHaveBeenCalledWith('new');
    expect(onChangeImportance).toHaveBeenCalledWith(0.8);
    expect(onSave).toHaveBeenCalledOnce();

    view.rerender(
      <PageDetailsPanel
        archived
        importance={0.8}
        onChangeImportance={onChangeImportance}
        onChangeTags={onChangeTags}
        onSave={onSave}
        tags="new"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Save details' })).toBeNull();
    expect(screen.getByRole('textbox', { name: /^Tags/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('slider', { name: /^Importance · 0.8/ })).toHaveProperty('disabled', true);
  });

  it('recovers from an unstructured load failure and ignores operations for missing blocks', async () => {
    let loads = 0;
    const editor = renderEditor(async (input) => {
      if (input.action !== 'get') throw new Error(`Unexpected action ${input.action}`);
      loads += 1;
      if (loads === 1) throw 'offline';
      return success('get', makePage());
    });

    await waitFor(() => expect(editor.result.current.loading).toBe(false));
    expect(editor.result.current.loadError).toBe('The page could not be updated');

    act(() => editor.result.current.retryLoad());
    await waitFor(() => expect(editor.result.current.page?.title).toBe('Field notes'));

    act(() => {
      editor.result.current.saveTitle();
      editor.result.current.saveBlock('missing-block');
      editor.result.current.saveBlockMetadata('missing-block', { done: true });
      editor.result.current.mutateBlockArchive('missing-block', false);
    });

    await waitFor(() => {
      expect(editor.result.current.busyBlockIds.size).toBe(0);
      expect(editor.result.current.saveState).toBe('saved');
    });
    expect(editor.page.mock.calls.every(([input]) => input.action === 'get')).toBe(true);
  });

  it('discards edits to archived content and treats redundant archive transitions as no-ops', async () => {
    const active = makeBlock();
    const archived = makeBlock({ archived_at: NOW, id: 'block-archived', position: 1 });
    const editor = renderEditor(async (input) => {
      if (input.action !== 'get') throw new Error(`Unexpected action ${input.action}`);
      return success('get', makePage({ archived_at: NOW, blocks: [active, archived] }));
    });
    await waitFor(() => expect(editor.result.current.page).not.toBeNull());

    act(() => {
      editor.result.current.scheduleTitleSave('Archived draft');
      editor.result.current.saveTitle();
      editor.result.current.saveBlock(archived.id);
      editor.result.current.saveBlockMetadata(archived.id, { done: true });
      editor.result.current.mutateBlockArchive(active.id, true);
      editor.result.current.mutateBlockArchive(archived.id, false);
    });

    await waitFor(() => {
      expect(editor.result.current.busyBlockIds.size).toBe(0);
      expect(editor.result.current.saveState).toBe('saved');
    });
    expect(editor.result.current.title).toBe('Field notes');
    expect(editor.page.mock.calls.every(([input]) => input.action === 'get')).toBe(true);
  });

  it('keeps the newest metadata while serialized writes return and archives clean content directly', async () => {
    const loaded = makePage();
    const firstMetadata = deferred<unknown>();
    let metadataWrites = 0;
    const editor = renderEditor(async (input) => {
      if (input.action === 'get') return success('get', loaded);
      if (input.action === 'block_update' && input.metadata) {
        metadataWrites += 1;
        if (metadataWrites === 1) return firstMetadata.promise;
        return success('block_update', {
          block: { ...loaded.blocks[0]!, metadata: input.metadata, revision: 4 },
          page_revision: 4,
        });
      }
      if (input.action === 'block_archive') {
        return success('block_archive', {
          block: { ...loaded.blocks[0]!, archived_at: NOW, revision: 5 },
          page_revision: 5,
        });
      }
      throw new Error(`Unexpected action ${input.action}`);
    });
    await waitFor(() => expect(editor.result.current.page).not.toBeNull());

    act(() => editor.result.current.saveBlockMetadata('block-1', { done: true }));
    await waitFor(() => expect(metadataWrites).toBe(1));
    act(() => editor.result.current.saveBlockMetadata('block-1', { done: false, source: 'latest' }));
    await act(async () => {
      firstMetadata.resolve(success('block_update', {
        block: { ...loaded.blocks[0]!, metadata: { done: true }, revision: 3 },
        page_revision: 3,
      }));
      await firstMetadata.promise;
    });

    await waitFor(() => expect(metadataWrites).toBe(2));
    await waitFor(() => expect(editor.result.current.page?.blocks[0]?.metadata).toEqual({
      done: false,
      source: 'latest',
    }));

    act(() => editor.result.current.mutateBlockArchive('block-1', false));
    await waitFor(() => expect(editor.result.current.page?.blocks[0]?.archived_at).toBe(NOW));
    expect(editor.page.mock.calls.filter(([input]) => input.action === 'block_update')).toHaveLength(2);
  });

  it('preserves a newer block draft when an earlier save finishes first', async () => {
    const loaded = makePage();
    const firstWrite = deferred<unknown>();
    let contentWrites = 0;
    const editor = renderEditor(async (input) => {
      if (input.action === 'get') return success('get', loaded);
      if (input.action === 'block_update' && input.content !== undefined) {
        contentWrites += 1;
        if (contentWrites === 1) return firstWrite.promise;
        return success('block_update', {
          block: { ...loaded.blocks[0]!, content: input.content, revision: 4 },
          page_revision: 5,
        });
      }
      throw new Error(`Unexpected action ${input.action}`);
    });
    await waitFor(() => expect(editor.result.current.page).not.toBeNull());

    act(() => {
      editor.result.current.scheduleBlockSave('block-1', 'First draft');
      editor.result.current.saveBlock('block-1');
    });
    await waitFor(() => expect(contentWrites).toBe(1));
    act(() => {
      editor.result.current.scheduleBlockSave('block-1', 'Newest draft');
      editor.result.current.saveBlock('block-1');
    });
    await act(async () => {
      firstWrite.resolve(success('block_update', {
        block: { ...loaded.blocks[0]!, content: 'First draft', revision: 3 },
        page_revision: 4,
      }));
      await firstWrite.promise;
    });

    await waitFor(() => expect(contentWrites).toBe(2));
    await waitFor(() => {
      expect(editor.result.current.page?.blocks[0]?.content).toBe('Newest draft');
      expect(editor.result.current.saveState).toBe('saved');
    });
  });

  it('does not apply a load or archive response after unmount', async () => {
    const load = deferred<unknown>();
    let loadSignal: AbortSignal | undefined;
    const loadingEditor = renderEditor(async (input, options) => {
      if (input.action !== 'get') throw new Error(`Unexpected action ${input.action}`);
      loadSignal = options?.signal;
      return load.promise;
    });
    await waitFor(() => expect(loadSignal).toBeDefined());
    loadingEditor.unmount();
    await act(async () => {
      load.resolve(success('get', makePage()));
      await load.promise;
      await Promise.resolve();
    });
    expect(loadSignal?.aborted).toBe(true);

    const archive = deferred<unknown>();
    let archiveSignal: AbortSignal | undefined;
    const archiveEditor = renderEditor(async (input, options) => {
      if (input.action === 'get') return success('get', makePage());
      if (input.action === 'block_archive') {
        archiveSignal = options?.signal;
        return archive.promise;
      }
      throw new Error(`Unexpected action ${input.action}`);
    });
    await waitFor(() => expect(archiveEditor.result.current.page).not.toBeNull());
    act(() => archiveEditor.result.current.mutateBlockArchive('block-1', false));
    await waitFor(() => expect(archiveSignal).toBeDefined());
    archiveEditor.unmount();
    await act(async () => {
      archive.resolve(success('block_archive', {
        block: { ...makeBlock(), archived_at: NOW, revision: 3 },
        page_revision: 4,
      }));
      await archive.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(archiveSignal?.aborted).toBe(false);
  });
});
