// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DashboardApiError, type DashboardApiClient, type DashboardRequestOptions } from '../api';
import { DashboardViewContext, type DashboardViewContextValue } from '../shell/DashboardContext';
import type { Block, Page, PageDetails, PageInput, Workspace } from '../types';
import { PageView } from './PageView';

const NOW = '2026-07-16T12:00:00.000Z';
const PAGE_ID = 'page-1';

function success<Action extends string, Result>(action: Action, result: Result) {
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

function pageRecord(details: PageDetails, overrides: Partial<Page> = {}): Page {
  const { blocks: _blocks, blocks_page: _blocksPage, ...page } = details;
  return { ...page, ...overrides };
}

type PageApi = (
  input: PageInput,
  options?: DashboardRequestOptions,
) => Promise<unknown>;

function renderPage(pageApi: ReturnType<typeof vi.fn<PageApi>>) {
  const navigate = vi.fn<DashboardViewContextValue['navigate']>();
  const refreshWorkspaceData = vi.fn(async () => undefined);
  const showToast = vi.fn<DashboardViewContextValue['showToast']>();
  const workspace: Workspace = {
    archived_at: null,
    created_at: NOW,
    description: null,
    icon: null,
    id: 'workspace-1',
    name: 'Research garden',
    revision: 1,
    updated_at: NOW,
  };
  const value: DashboardViewContextValue = {
    api: { page: pageApi } as unknown as DashboardApiClient,
    navigate,
    refreshWorkspaceData,
    showToast,
    workspace,
  };

  return {
    ...render(
      <DashboardViewContext.Provider value={value}>
        <PageView pageId={PAGE_ID} />
      </DashboardViewContext.Provider>
    ),
    navigate,
    refreshWorkspaceData,
    showToast,
  };
}

function deferred<Result>() {
  let resolve!: (value: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe('PageView', () => {
  it('presents the first block page immediately and appends later pages progressively', async () => {
    const firstBlock = makeBlock();
    const secondBlock = makeBlock({ content: 'Second thought', id: 'block-2', position: 1 });
    const secondPage = deferred<unknown>();
    const pageApi = vi.fn<PageApi>(async (input) => {
      if (input.action !== 'get') throw new Error(`Unexpected action ${input.action}`);
      if (input.block_offset === 1) {
        return secondPage.promise;
      }
      return success('get', makePage({
        blocks: [firstBlock],
        blocks_page: { has_more: true, limit: 50, next_offset: 1, offset: 0 },
      }));
    });

    renderPage(pageApi);

    expect(await screen.findByDisplayValue('Field notes')).toBeTruthy();
    expect(screen.getByDisplayValue('First thought')).toBeTruthy();
    expect(screen.queryByDisplayValue('Second thought')).toBeNull();
    await waitFor(() => expect(pageApi).toHaveBeenCalledTimes(2));
    expect(pageApi.mock.calls[1]?.[0]).toMatchObject({
      action: 'get',
      block_offset: 1,
      include_archived: true,
      page_id: PAGE_ID,
    });

    await act(async () => {
      secondPage.resolve(success('get', makePage({
        blocks: [secondBlock],
        blocks_page: { has_more: false, limit: 50, next_offset: null, offset: 1 },
      })));
      await Promise.resolve();
    });
    expect(await screen.findByDisplayValue('Second thought')).toBeTruthy();
  });

  it('cancels progressive block loading when the page unmounts', async () => {
    const laterPage = deferred<unknown>();
    let laterSignal: AbortSignal | undefined;
    const pageApi = vi.fn<PageApi>(async (input, options) => {
      if (input.action !== 'get') throw new Error(`Unexpected action ${input.action}`);
      if (input.block_offset === 1) {
        laterSignal = options?.signal;
        return laterPage.promise;
      }
      return success('get', makePage({
        blocks_page: { has_more: true, limit: 50, next_offset: 1, offset: 0 },
      }));
    });

    const { unmount } = renderPage(pageApi);
    expect(await screen.findByDisplayValue('First thought')).toBeTruthy();
    await waitFor(() => expect(laterSignal).toBeDefined());

    unmount();

    expect(laterSignal?.aborted).toBe(true);
    await act(async () => {
      laterPage.reject(new DOMException('The request was aborted', 'AbortError'));
      await laterPage.promise.catch(() => undefined);
    });
  });

  it('serializes title edits and gives the queued write the returned page revision', async () => {
    const loaded = makePage();
    const firstUpdate = deferred<unknown>();
    const secondUpdate = deferred<unknown>();
    let updateCount = 0;
    const pageApi = vi.fn<PageApi>(async (input) => {
      if (input.action === 'get') return success('get', loaded);
      if (input.action !== 'update') throw new Error(`Unexpected action ${input.action}`);
      updateCount += 1;
      return updateCount === 1 ? firstUpdate.promise : secondUpdate.promise;
    });
    const { refreshWorkspaceData } = renderPage(pageApi);
    const title = await screen.findByLabelText<HTMLTextAreaElement>('Page title');

    fireEvent.change(title, { target: { value: 'First edit' } });
    fireEvent.blur(title);
    await waitFor(() => expect(updateCount).toBe(1));

    fireEvent.change(title, { target: { value: 'Queued edit' } });
    fireEvent.blur(title);
    expect(updateCount).toBe(1);

    await act(async () => {
      firstUpdate.resolve(success('update', pageRecord(loaded, { revision: 4, title: 'First edit' })));
      await Promise.resolve();
    });

    await waitFor(() => expect(updateCount).toBe(2));
    const updates = pageApi.mock.calls
      .map(([input]) => input)
      .filter((input) => input.action === 'update');
    expect(updates).toEqual([
      expect.objectContaining({ revision: 3, title: 'First edit' }),
      expect.objectContaining({ revision: 4, title: 'Queued edit' }),
    ]);

    await act(async () => {
      secondUpdate.resolve(success('update', pageRecord(loaded, { revision: 5, title: 'Queued edit' })));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText('rev 5')).toBeTruthy());
    expect(screen.getByLabelText<HTMLTextAreaElement>('Page title').value).toBe('Queued edit');
    expect(refreshWorkspaceData).toHaveBeenCalledTimes(2);
  });

  it('propagates append revisions into the next block write', async () => {
    const loaded = makePage();
    const heading = makeBlock({
      block_type: 'heading',
      content: '',
      id: 'block-2',
      position: 1,
      revision: 1,
    });
    const pageApi = vi.fn<PageApi>(async (input) => {
      if (input.action === 'get') return success('get', loaded);
      if (input.action === 'append') {
        return success('append', { blocks: [heading], page_revision: 4 });
      }
      if (input.action === 'block_update') {
        return success('block_update', {
          block: { ...heading, content: input.content ?? '', revision: 2 },
          page_revision: 5,
        });
      }
      throw new Error(`Unexpected action ${input.action}`);
    });
    renderPage(pageApi);
    await screen.findByDisplayValue('Field notes');

    fireEvent.click(screen.getByRole('button', { name: 'Heading' }));
    const headingInput = await screen.findByLabelText<HTMLTextAreaElement>('Heading block');
    fireEvent.change(headingInput, { target: { value: 'A new section' } });
    fireEvent.blur(headingInput);

    await waitFor(() => expect(screen.getByText('rev 5')).toBeTruthy());
    const writes = pageApi.mock.calls.map(([input]) => input);
    expect(writes).toContainEqual(expect.objectContaining({ action: 'append', revision: 3 }));
    expect(writes).toContainEqual(expect.objectContaining({
      action: 'block_update',
      block_id: 'block-2',
      content: 'A new section',
      revision: 1,
    }));
  });

  it('saves a dirty block before archiving it, then restores the returned revision', async () => {
    const loaded = makePage();
    const persisted = loaded.blocks[0]!;
    const pageApi = vi.fn<PageApi>(async (input) => {
      if (input.action === 'get') return success('get', loaded);
      if (input.action === 'block_update') {
        return success('block_update', {
          block: { ...persisted, content: input.content ?? '', revision: 3 },
          page_revision: 4,
        });
      }
      if (input.action === 'block_archive') {
        return success('block_archive', {
          block: { ...persisted, archived_at: NOW, content: 'Unsaved insight', revision: 4 },
          page_revision: 5,
        });
      }
      if (input.action === 'block_restore') {
        return success('block_restore', {
          block: { ...persisted, archived_at: null, content: 'Unsaved insight', revision: 5 },
          page_revision: 6,
        });
      }
      throw new Error(`Unexpected action ${input.action}`);
    });
    const { showToast } = renderPage(pageApi);
    const blockInput = await screen.findByLabelText<HTMLTextAreaElement>('Text block');

    fireEvent.change(blockInput, { target: { value: 'Unsaved insight' } });
    fireEvent.click(screen.getByRole('button', { name: 'Archive text block' }));

    const archivedToggle = await screen.findByRole('button', { name: 'Show 1 archived block' });
    const writes = pageApi.mock.calls.map(([input]) => input);
    expect(writes).toContainEqual(expect.objectContaining({
      action: 'block_update',
      content: 'Unsaved insight',
      revision: 2,
    }));
    expect(writes).toContainEqual(expect.objectContaining({
      action: 'block_archive',
      revision: 3,
    }));

    fireEvent.click(archivedToggle);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.getByText('rev 6')).toBeTruthy());
    expect(screen.getByLabelText<HTMLTextAreaElement>('Text block').disabled).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Block archived');
    expect(showToast).toHaveBeenCalledWith('Block restored');
  });

  it('keeps a failed title draft dirty through an unrelated successful mutation and retries it', async () => {
    const loaded = makePage();
    const appended = makeBlock({ content: '', id: 'block-2', position: 1, revision: 1 });
    let titleUpdateCount = 0;
    const pageApi = vi.fn<PageApi>(async (input) => {
      if (input.action === 'get') return success('get', loaded);
      if (input.action === 'append') {
        return success('append', { blocks: [appended], page_revision: 4 });
      }
      if (input.action === 'update') {
        titleUpdateCount += 1;
        if (titleUpdateCount === 1) throw new Error('Title write failed');
        return success('update', pageRecord(loaded, {
          revision: 5,
          title: input.title ?? loaded.title,
        }));
      }
      throw new Error(`Unexpected action ${input.action}`);
    });
    renderPage(pageApi);
    const title = await screen.findByLabelText<HTMLTextAreaElement>('Page title');

    fireEvent.change(title, { target: { value: 'Local title draft' } });
    fireEvent.blur(title);

    await screen.findByRole('status', { name: 'Could not save' });
    expect(title.value).toBe('Local title draft');
    const dirtyUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    await waitFor(() => expect(screen.getByText('rev 4')).toBeTruthy());
    expect(screen.getByRole('status', { name: 'Could not save' })).toBeTruthy();
    expect(title.value).toBe('Local title draft');

    fireEvent.blur(title);

    await screen.findByRole('status', { name: 'Saved' });
    expect(screen.getByText('rev 5')).toBeTruthy();
    expect(title.value).toBe('Local title draft');
    const titleWrites = pageApi.mock.calls
      .map(([input]) => input)
      .filter((input) => input.action === 'update');
    expect(titleWrites).toEqual([
      expect.objectContaining({ revision: 3, title: 'Local title draft' }),
      expect.objectContaining({ revision: 4, title: 'Local title draft' }),
    ]);
    const savedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(savedUnload);
    expect(savedUnload.defaultPrevented).toBe(false);
  });

  it('keeps failed block content dirty after another field saves and recovers independently', async () => {
    const loaded = makePage();
    const persistedBlock = loaded.blocks[0]!;
    let blockUpdateCount = 0;
    const pageApi = vi.fn<PageApi>(async (input) => {
      if (input.action === 'get') return success('get', loaded);
      if (input.action === 'block_update') {
        blockUpdateCount += 1;
        if (blockUpdateCount === 1) throw new Error('Block write failed');
        return success('block_update', {
          block: { ...persistedBlock, content: input.content ?? '', revision: 3 },
          page_revision: 5,
        });
      }
      if (input.action === 'update') {
        return success('update', pageRecord(loaded, {
          revision: 4,
          title: input.title ?? loaded.title,
        }));
      }
      throw new Error(`Unexpected action ${input.action}`);
    });
    renderPage(pageApi);
    const block = await screen.findByLabelText<HTMLTextAreaElement>('Text block');
    const title = screen.getByLabelText<HTMLTextAreaElement>('Page title');

    fireEvent.change(block, { target: { value: 'Local block draft' } });
    fireEvent.blur(block);
    await screen.findByRole('status', { name: 'Could not save' });
    expect(block.value).toBe('Local block draft');

    fireEvent.change(title, { target: { value: 'Persisted title' } });
    fireEvent.blur(title);
    await waitFor(() => expect(screen.getByText('rev 4')).toBeTruthy());
    expect(screen.getByRole('status', { name: 'Could not save' })).toBeTruthy();
    expect(block.value).toBe('Local block draft');
    const stillDirtyUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(stillDirtyUnload);
    expect(stillDirtyUnload.defaultPrevented).toBe(true);

    fireEvent.blur(block);

    await screen.findByRole('status', { name: 'Saved' });
    expect(screen.getByText('rev 5')).toBeTruthy();
    expect(block.value).toBe('Local block draft');
    expect(blockUpdateCount).toBe(2);
    const savedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(savedUnload);
    expect(savedUnload.defaultPrevented).toBe(false);
  });

  it('keeps the local draft on conflict and offers explicit reload recovery', async () => {
    const loaded = makePage();
    const latest = makePage({ revision: 4, title: 'Agent revision' });
    const conflict = new DashboardApiError('Page changed elsewhere', {
      action: 'update',
      code: 'CONFLICT',
      endpoint: '/api/tools/page',
      retryable: true,
      status: 409,
    });
    let getCount = 0;
    const pageApi = vi.fn<PageApi>(async (input) => {
      if (input.action === 'get') {
        getCount += 1;
        return success('get', getCount === 1 ? loaded : latest);
      }
      if (input.action === 'update') throw conflict;
      throw new Error(`Unexpected action ${input.action}`);
    });
    const { refreshWorkspaceData, showToast } = renderPage(pageApi);
    const title = await screen.findByLabelText<HTMLTextAreaElement>('Page title');

    fireEvent.change(title, { target: { value: 'My local draft' } });
    fireEvent.blur(title);

    await screen.findByRole('status', { name: 'Changed elsewhere' });
    expect(screen.getByLabelText<HTMLTextAreaElement>('Page title').value).toBe('My local draft');
    expect(refreshWorkspaceData).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Page changed elsewhere', { tone: 'error' });

    fireEvent.click(screen.getByRole('button', {
      name: 'Reload latest and discard local drafts',
    }));
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>('Page title').value).toBe('Agent revision');
    });
    expect(getCount).toBe(2);
  });

  it('cancels queued drafts before reloading the latest page', async () => {
    const loaded = makePage({ blocks: [makeBlock({ block_type: 'todo' })] });
    const latest = makePage({
      blocks: [makeBlock({ block_type: 'todo', content: 'Agent block', revision: 3 })],
      revision: 4,
      title: 'Agent revision',
    });
    const titleUpdate = deferred<unknown>();
    const conflict = new DashboardApiError('Page changed elsewhere', {
      action: 'update',
      code: 'CONFLICT',
      endpoint: '/api/tools/page',
      retryable: true,
      status: 409,
    });
    let getCount = 0;
    const pageApi = vi.fn<PageApi>(async (input, options) => {
      if (input.action === 'get') {
        getCount += 1;
        return success('get', getCount === 1 ? loaded : latest);
      }
      if (input.action === 'update') return titleUpdate.promise;
      if (input.action === 'block_update' && input.content !== undefined) {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      if (input.action === 'block_update' && input.metadata !== undefined) {
        return success('block_update', {
          block: { ...loaded.blocks[0]!, metadata: input.metadata, revision: 3 },
          page_revision: 4,
        });
      }
      throw new Error(`Unexpected action ${input.action}`);
    });
    renderPage(pageApi);
    const title = await screen.findByLabelText<HTMLTextAreaElement>('Page title');
    const block = screen.getByLabelText<HTMLTextAreaElement>('To-do block');

    fireEvent.change(title, { target: { value: 'My local title' } });
    fireEvent.blur(title);
    fireEvent.change(block, { target: { value: 'My local block' } });
    fireEvent.blur(block);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark to-do complete' }));

    await act(async () => {
      titleUpdate.reject(conflict);
      await Promise.resolve();
    });
    await screen.findByRole('status', { name: 'Changed elsewhere' });
    await waitFor(() => {
      expect(pageApi.mock.calls.some(([input]) => (
        input.action === 'block_update' && input.content === 'My local block'
      ))).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', {
      name: 'Reload latest and discard local drafts',
    }));

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>('Page title').value).toBe('Agent revision');
      expect(screen.getByLabelText<HTMLTextAreaElement>('To-do block').value).toBe('Agent block');
    });
    const blockUpdates = pageApi.mock.calls.filter(([input]) => input.action === 'block_update');
    expect(blockUpdates).toHaveLength(1);
    expect(blockUpdates[0]?.[0]).toMatchObject({ content: 'My local block' });
  });

  it('keeps every block control read-only while its parent page is archived', async () => {
    const loaded = makePage({
      archived_at: NOW,
      blocks: [
        makeBlock(),
        makeBlock({ archived_at: NOW, id: 'block-2', position: 1 }),
      ],
    });
    const pageApi = vi.fn<PageApi>(async (input) => {
      if (input.action === 'get') return success('get', loaded);
      throw new Error(`Unexpected action ${input.action}`);
    });
    renderPage(pageApi);

    const activeBlock = await screen.findByLabelText<HTMLTextAreaElement>('Text block');
    expect(activeBlock.disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Archive text block' }).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Show 1 archived block' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Restore' }).disabled).toBe(true);
  });
});
