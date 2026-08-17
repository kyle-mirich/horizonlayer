// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DashboardApiClient } from '../api';
import { DashboardApiError } from '../api';
import { DashboardViewContext, type DashboardViewContextValue } from '../shell/DashboardContext';
import type { Block, Page, PageDetails, Workspace } from '../types';
import { PageView } from './PageView';

const NOW = '2026-07-22T00:00:00.000Z';
const PAGE_ID = 'page-1';
const workspace: Workspace = {
  archived_at: null, created_at: NOW, description: null, icon: null, id: 'workspace-1', name: 'Research',
  revision: 1, updated_at: NOW,
};
function block(overrides: Partial<Block> = {}): Block {
  return {
    archived_at: null, block_type: 'text', content: 'First note', created_at: NOW, id: 'block-1', metadata: {},
    page_id: PAGE_ID, position: 0, revision: 2, updated_at: NOW, ...overrides,
  };
}
const textBlock = block();
const todoBlock = block({ block_type: 'todo', content: 'Task', id: 'block-2', metadata: { done: false }, position: 1 });
const oldBlock = block({ archived_at: NOW, content: 'Old note', id: 'block-3', position: 2 });
function pageDetails(overrides: Partial<PageDetails> = {}): PageDetails {
  return {
    archived_at: null, blocks: [textBlock, todoBlock, oldBlock],
    blocks_page: { has_more: false, limit: 50, next_offset: null, offset: 0 }, created_at: NOW, id: PAGE_ID,
    importance: 0.4, parent_page_id: 'parent-1', revision: 3, session_id: null, tags: ['idea'],
    title: 'Field notes', updated_at: NOW, workspace_id: workspace.id, ...overrides,
  };
}
function pageRecord(details: PageDetails, overrides: Partial<Page> = {}): Page {
  const { blocks: _blocks, blocks_page: _blocksPage, ...result } = details;
  return { ...result, ...overrides };
}
function success(action: string, result: unknown) {
  return { action, error: null, meta: {}, ok: true as const, result };
}

function renderPage(options: { pageImpl?: (input: Record<string, unknown>) => Promise<unknown> } = {}) {
  let latest = pageDetails();
  const pageMethod = vi.fn(options.pageImpl ?? (async (input) => {
    switch (input.action) {
      case 'get': return success('get', latest);
      case 'update': {
        latest = { ...latest, ...(input.title ? { title: input.title } : {}), ...(input.tags ? { tags: input.tags } : {}),
          ...(input.importance !== undefined ? { importance: input.importance } : {}), revision: latest.revision + 1 };
        return success('update', pageRecord(latest));
      }
      case 'block_update': {
        const prior = latest.blocks.find((item) => item.id === input.block_id)!;
        const updated = { ...prior, ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}), revision: prior.revision + 1 };
        latest = { ...latest, blocks: latest.blocks.map((item) => item.id === updated.id ? updated : item), revision: latest.revision + 1 };
        return success('block_update', { block: updated, page_revision: latest.revision });
      }
      case 'block_archive': {
        const updated = { ...latest.blocks.find((item) => item.id === input.block_id)!, archived_at: NOW, revision: 4 };
        latest = { ...latest, blocks: latest.blocks.map((item) => item.id === updated.id ? updated : item), revision: latest.revision + 1 };
        return success('block_archive', { block: updated, page_revision: latest.revision });
      }
      case 'block_restore': {
        const updated = { ...latest.blocks.find((item) => item.id === input.block_id)!, archived_at: null, revision: 5 };
        latest = { ...latest, blocks: latest.blocks.map((item) => item.id === updated.id ? updated : item), revision: latest.revision + 1 };
        return success('block_restore', { block: updated, page_revision: latest.revision });
      }
      case 'append': {
        const added = block({ block_type: input.blocks?.[0]?.block_type ?? 'text', content: '', id: 'block-appended', position: latest.blocks.length });
        latest = { ...latest, blocks: [...latest.blocks, added], revision: latest.revision + 1 };
        return success('append', { blocks: [added], page_revision: latest.revision });
      }
      case 'archive': {
        latest = { ...latest, archived_at: NOW, revision: latest.revision + 1 };
        return success('archive', pageRecord(latest));
      }
      case 'restore': {
        latest = { ...latest, archived_at: null, revision: latest.revision + 1 };
        return success('restore', pageRecord(latest));
      }
      default: throw new Error(`Unexpected page ${String(input.action)}`);
    }
  }));
  const navigate = vi.fn();
  const refreshWorkspaceData = vi.fn(async () => undefined);
  const showToast = vi.fn();
  const context: DashboardViewContextValue = {
    api: { page: pageMethod } as unknown as DashboardApiClient,
    navigate, refreshWorkspaceData, showToast, workspace,
  };
  const rendered = render(
    <DashboardViewContext.Provider value={context}><PageView pageId={PAGE_ID} /></DashboardViewContext.Provider>,
  );
  return { ...rendered, navigate, pageMethod, refreshWorkspaceData, showToast };
}

afterEach(() => cleanup());

describe('PageView behavior', () => {
  it('edits details, blocks, archived-block visibility, appending, and page archival', async () => {
    const user = userEvent.setup();
    const { navigate, pageMethod, refreshWorkspaceData, showToast } = renderPage();
    expect(await screen.findByLabelText('Page title')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Nested page' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show 1 archived block' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Details' }));
    const details = screen.getByRole('region', { name: 'Page details' });
    const tags = within(details).getByRole('textbox', { name: /^Tags/ });
    fireEvent.change(tags, {
      target: { value: Array.from({ length: 51 }, (_, index) => `tag${index}`).join(',') },
    });
    await user.click(within(details).getByRole('button', { name: 'Save details' }));
    expect(showToast).toHaveBeenCalledWith('Use at most 50 tags, each no longer than 100 characters', { tone: 'error' });
    await user.clear(tags);
    await user.type(tags, 'agent, agent, mcp');
    fireEvent.change(within(details).getByRole('slider', { name: /^Importance/ }), { target: { value: '0.8', valueAsNumber: 0.8 } });
    await user.click(within(details).getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(pageMethod).toHaveBeenCalledWith(expect.objectContaining({
      action: 'update', importance: 0.8, tags: ['agent', 'mcp'],
    }), expect.anything()));
    expect(refreshWorkspaceData).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Page details saved');

    await user.click(screen.getByLabelText('Mark to-do complete'));
    await waitFor(() => expect(pageMethod).toHaveBeenCalledWith(expect.objectContaining({
      action: 'block_update', block_id: todoBlock.id, metadata: { done: true },
    }), expect.anything()));
    await user.click(screen.getByRole('button', { name: 'Archive text block' }));
    await waitFor(() => expect(pageMethod).toHaveBeenCalledWith(expect.objectContaining({ action: 'block_archive', block_id: textBlock.id }), expect.anything()));
    expect(showToast).toHaveBeenCalledWith('Block archived');
    await user.click(screen.getByRole('button', { name: 'Show 2 archived blocks' }));
    expect(await screen.findByDisplayValue('Old note')).toBeTruthy();
    const archivedArticle = screen.getByDisplayValue('Old note').closest('article')!;
    await user.click(within(archivedArticle).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(pageMethod).toHaveBeenCalledWith(expect.objectContaining({ action: 'block_restore', block_id: oldBlock.id }), expect.anything()));

    await user.click(screen.getByRole('button', { name: 'Callout' }));
    expect(await screen.findByLabelText('Callout block')).toBeTruthy();
    await waitFor(() => expect(pageMethod).toHaveBeenCalledWith(expect.objectContaining({ action: 'append' }), expect.anything()));

    await user.click(screen.getByRole('button', { name: 'Archive page' }));
    const prompt = await screen.findByRole('dialog', { name: 'Archive this page?' });
    await user.click(within(prompt).getByRole('button', { name: 'Keep page' }));
    expect(screen.queryByRole('dialog', { name: 'Archive this page?' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Archive page' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Archive this page?' })).getByRole('button', { name: 'Archive page' }));
    await waitFor(() => expect(pageMethod).toHaveBeenCalledWith(expect.objectContaining({ action: 'archive' }), expect.anything()));
    expect(navigate).toHaveBeenCalledWith({ name: 'home' });
    expect(await screen.findByText('This page is archived and read-only.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restore page' }));
    await waitFor(() => expect(pageMethod).toHaveBeenCalledWith(expect.objectContaining({ action: 'restore' }), expect.anything()));
  });

  it('shows error recovery UI for initial load failures and retries successfully', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { navigate, pageMethod } = renderPage({
      pageImpl: async (input) => {
        if (input.action !== 'get') throw new Error('unexpected');
        calls += 1;
        if (calls === 1) throw new Error('page offline');
        return success('get', pageDetails());
      },
    });
    expect(await screen.findByRole('heading', { name: 'We couldn’t open this page.' })).toBeTruthy();
    expect(screen.getByText('page offline')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back to workspace' }));
    expect(navigate).toHaveBeenCalledWith({ name: 'home' });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Page title')).toBeTruthy();
    expect(pageMethod).toHaveBeenCalledTimes(2);
  });

  it('keeps a partial page visible when loading an additional block page fails', async () => {
    const initial = pageDetails({ blocks: [textBlock], blocks_page: { has_more: true, limit: 50, next_offset: 1, offset: 0 } });
    let calls = 0;
    const { showToast } = renderPage({
      pageImpl: async (input) => {
        if (input.action !== 'get') throw new Error('unexpected');
        calls += 1;
        if (calls === 1) return success('get', initial);
        throw new Error('later blocks offline');
      },
    });
    expect(await screen.findByDisplayValue('First note')).toBeTruthy();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Some page blocks could not be loaded. Reload to try again.', { tone: 'error' },
    ));
  });

  it('renders empty page variants and restores an empty title instead of persisting it', async () => {
    const user = userEvent.setup();
    const empty = pageDetails({ blocks: [], parent_page_id: null, tags: [] });
    const { showToast } = renderPage({
      pageImpl: async (input) => {
        if (input.action !== 'get') throw new Error('unexpected');
        return success('get', empty);
      },
    });
    const title = await screen.findByLabelText('Page title');
    expect(screen.getByRole('button', { name: 'Page' })).toBeTruthy();
    expect(screen.getByText('Untyped knowledge')).toBeTruthy();
    expect(screen.getByText('This page is open ground.')).toBeTruthy();
    await user.clear(title);
    await user.tab();
    expect((title as HTMLTextAreaElement).value).toBe('Field notes');
    expect(showToast).toHaveBeenCalledWith('A page title cannot be empty', { tone: 'error' });
  });

  it('surfaces a title conflict and reloads latest page data after the user requests it', async () => {
    const user = userEvent.setup();
    let getCalls = 0;
    const conflict = new DashboardApiError('Page changed elsewhere', {
      action: 'update', code: 'CONFLICT', endpoint: '/api/tools/page', status: 409,
    });
    const { pageMethod, showToast } = renderPage({
      pageImpl: async (input) => {
        if (input.action === 'get') {
          getCalls += 1;
          return success('get', pageDetails({ title: getCalls === 1 ? 'Field notes' : 'Latest title' }));
        }
        if (input.action === 'update') throw conflict;
        throw new Error('unexpected');
      },
    });
    const title = await screen.findByLabelText('Page title');
    await user.clear(title);
    await user.type(title, 'Conflict title');
    await user.tab();
    expect(await screen.findByRole('status', { name: 'Changed elsewhere' })).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith('Page changed elsewhere', { tone: 'error' });
    await user.click(screen.getByRole('button', { name: 'Reload latest and discard local drafts' }));
    await waitFor(() => expect(pageMethod.mock.calls.filter(([input]) => input.action === 'get')).toHaveLength(2));
    expect(await screen.findByDisplayValue('Latest title')).toBeTruthy();
  });
});
