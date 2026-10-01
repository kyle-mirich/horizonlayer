// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatRagSearch, formatRecordSearch } from '../../../src/tools/searchFormat';
import type { DashboardApiClient } from '../api';
import type { RagChunk, SearchRecord, Workspace } from '../types';
import { SearchPalette } from './SearchPalette';

const workspace: Workspace = {
  archived_at: null,
  created_at: '2026-07-01T00:00:00.000Z',
  description: null,
  icon: null,
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Research garden',
  revision: 1,
  updated_at: '2026-07-01T00:00:00.000Z',
};

const pageRecord: SearchRecord = {
  created_at: '2026-07-01T00:00:00.000Z',
  database_id: null,
  id: '20000000-0000-4000-8000-000000000001',
  importance: 0.5,
  parent_page_id: null,
  revision: 1,
  score: 1,
  session_id: null,
  snippet: 'A useful page result',
  tags: [],
  title: 'Page result',
  type: 'page',
  updated_at: '2026-07-01T00:00:00.000Z',
  workspace_id: workspace.id,
};

const rowRecord: SearchRecord = {
  ...pageRecord,
  database_id: '30000000-0000-4000-8000-000000000001',
  id: '40000000-0000-4000-8000-000000000001',
  snippet: 'A useful row result',
  title: 'Row result',
  type: 'row',
};

const chunk: RagChunk = {
  citation: {
    block_id: '50000000-0000-4000-8000-000000000001',
    block_position: 0,
    block_revision: 2,
    block_type: 'heading',
    char_end: 20,
    char_start: 0,
    id: '20000000-0000-4000-8000-000000000002',
    part: 'block',
    revision: 3,
    title: 'Retrieved page',
    type: 'page',
    updated_at: '2026-07-01T00:00:00.000Z',
    workspace_id: workspace.id,
  },
  rank: 1,
  score: 0.9,
  text: 'A matching block passage',
};

const rowChunk: RagChunk = {
  citation: {
    database_description: null,
    database_id: rowRecord.database_id!,
    database_name: 'Research records',
    id: rowRecord.id,
    properties: [],
    revision: rowRecord.revision,
    title: rowRecord.title,
    type: 'row',
    updated_at: rowRecord.updated_at,
    workspace_id: workspace.id,
  },
  rank: 1,
  score: 0.8,
  text: 'A matching row passage',
};

function success(result: unknown) {
  return { action: 'search', error: null, meta: {}, ok: true as const, result };
}

function renderPalette(options: {
  ragEnabled?: boolean;
  search?: (input: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const search = vi.fn(options.search ?? (async () => success({ mode: 'records', records: [], truncated: false })));
  const onClose = vi.fn();
  const onNavigate = vi.fn();
  render(
    <SearchPalette
      api={{ search } as unknown as DashboardApiClient}
      onClose={onClose}
      onNavigate={onNavigate}
      ragEnabled={options.ragEnabled ?? true}
      workspace={workspace}
    />,
  );
  return { onClose, onNavigate, search };
}

async function searchFor(query: string) {
  await runSearchDebounce(() => {
    fireEvent.change(screen.getByRole('combobox', { name: 'Search query' }), { target: { value: query } });
  });
}

async function runSearchDebounce(update: () => void) {
  update();
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 240));
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SearchPalette', () => {
  it('searches records, moves selection with arrows, and opens the selected row', async () => {
    const { onClose, onNavigate, search } = renderPalette({
      search: async (input) => success(formatRecordSearch(
        { records: [pageRecord, rowRecord], truncated: false },
        input.format === 'full' ? 'full' : 'compact',
      )),
    });

    expect(screen.getByText('Search the real records.')).toBeTruthy();
    await searchFor('agents');
    await waitFor(() => expect(search).toHaveBeenCalledWith({
      format: 'full',
      limit: 15,
      mode: 'records',
      query: 'agents',
      scope: { kind: 'workspace', workspace_id: workspace.id },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(screen.getByText('Page result')).toBeTruthy();
    expect(screen.getByText('Database row')).toBeTruthy();

    const input = screen.getByRole('combobox', { name: 'Search query' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Row result/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith({ name: 'database', databaseId: rowRecord.database_id, rowId: rowRecord.id });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('requests canonical record fields and opens a page with Enter', async () => {
    const { onClose, onNavigate } = renderPalette({
      search: async (input) => success(formatRecordSearch(
        { records: [pageRecord], truncated: false },
        input.format === 'full' ? 'full' : 'compact',
      )),
    });
    await searchFor('page');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search query' }), { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith({ name: 'page', pageId: pageRecord.id });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('option', { name: /Page result/ }).textContent).toContain('Page');
    expect(screen.queryByText('Database row')).toBeNull();
  });

  it('switches to semantic passages and navigates from a page citation', async () => {
    const { onClose, onNavigate, search } = renderPalette({
      search: async (input) => success(input.mode === 'rag'
        ? formatRagSearch({ chunks: [chunk], truncated: false }, input.format === 'full' ? 'full' : 'compact')
        : formatRecordSearch({ records: [], truncated: false }, input.format === 'full' ? 'full' : 'compact')),
    });
    await searchFor('retrieve');
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));

    await runSearchDebounce(() => {
      fireEvent.click(screen.getByRole('button', { name: /Passages/ }));
    });
    await waitFor(() => expect(search).toHaveBeenLastCalledWith(expect.objectContaining({
      format: 'full', limit: 10, mode: 'rag', query: 'retrieve',
    }), expect.anything()));
    expect(screen.getByText('Retrieved page')).toBeTruthy();
    expect(screen.getByText('Page block · heading')).toBeTruthy();
    expect(screen.getByText('A matching block passage')).toBeTruthy();

    fireEvent.click(screen.getByRole('option', { name: /Retrieved page/ }));
    expect(onNavigate).toHaveBeenCalledWith({ name: 'page', pageId: chunk.citation.id });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('requests canonical passage citations and opens their database row with Enter', async () => {
    const { onClose, onNavigate, search } = renderPalette({
      search: async (input) => success(input.mode === 'rag'
        ? formatRagSearch({ chunks: [rowChunk], truncated: false }, input.format === 'full' ? 'full' : 'compact')
        : formatRecordSearch({ records: [], truncated: false }, input.format === 'full' ? 'full' : 'compact')),
    });
    await searchFor('row passage');
    await runSearchDebounce(() => {
      fireEvent.click(screen.getByRole('button', { name: /Passages/ }));
    });
    expect(search).toHaveBeenLastCalledWith({
      format: 'full',
      limit: 10,
      mode: 'rag',
      query: 'row passage',
      scope: { kind: 'workspace', workspace_id: workspace.id },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByRole('option', { name: /Row result/ }).textContent).toContain('Research records · row passage');

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search query' }), { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith({ name: 'database', databaseId: rowRecord.database_id, rowId: rowRecord.id });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('handles disabled RAG, empty results, and search failures', async () => {
    const { search } = renderPalette({
      ragEnabled: false,
      search: async () => { throw new Error('search backend unavailable'); },
    });
    expect(screen.getByRole('button', { name: /Passages/ })).toHaveProperty('disabled', true);
    await searchFor('nothing');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('search backend unavailable'));
    expect(search).toHaveBeenCalledTimes(1);

    cleanup();
    renderPalette();
    await runSearchDebounce(() => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Search query' }), { target: { value: 'nothing' } });
      expect(screen.getByLabelText('Searching')).toBeTruthy();
    });
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('does not close when an orphaned row result has no database route', async () => {
    const { onClose, onNavigate } = renderPalette({
      search: async () => success({ mode: 'records', records: [{ ...rowRecord, database_id: null }], truncated: false }),
    });
    await searchFor('orphan');
    await waitFor(() => expect(screen.getByRole('option', { name: /Row result/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('option', { name: /Row result/ }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes from Escape through the shared modal behavior', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
