// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database, Page, Workspace } from '../types';
import { HomeView, searchShortcutLabel } from './HomeView';

const workspace: Workspace = {
  archived_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  description: 'Shared context for agents',
  icon: '🌱',
  id: 'workspace-1',
  name: 'Research garden',
  revision: 1,
  updated_at: '2026-01-01T00:00:00.000Z',
};

const page: Page = {
  archived_at: null,
  created_at: '2026-07-01T00:00:00.000Z',
  id: 'page / 1',
  importance: 0.5,
  parent_page_id: null,
  revision: 1,
  session_id: null,
  tags: ['idea', 'mcp'],
  title: 'Page notes',
  updated_at: '2026-07-20T00:00:00.000Z',
  workspace_id: workspace.id,
};

const database: Database = {
  archived_at: null,
  created_at: '2026-07-01T00:00:00.000Z',
  description: null,
  id: 'database / 1',
  name: 'Records',
  parent_page_id: null,
  revision: 1,
  tags: [],
  updated_at: '2026-07-21T00:00:00.000Z',
  workspace_id: workspace.id,
};

function renderView(overrides: Partial<React.ComponentProps<typeof HomeView>> = {}) {
  const onCreateDatabase = vi.fn(async () => undefined);
  const onCreatePage = vi.fn(async () => undefined);
  const onOpenSearch = vi.fn();
  render(
    <HomeView
      creating={null}
      databases={[]}
      databasesHasMore={false}
      loading={false}
      onCreateDatabase={onCreateDatabase}
      onCreatePage={onCreatePage}
      onOpenSearch={onOpenSearch}
      pages={[]}
      pagesHasMore={false}
      workspace={workspace}
      {...overrides}
    />,
  );
  return { onCreateDatabase, onCreatePage, onOpenSearch };
}

afterEach(() => cleanup());

describe('HomeView', () => {
  it('offers the empty workspace invitation and starts page creation', async () => {
    const user = userEvent.setup();
    const { onCreatePage } = renderView();

    expect(screen.getByRole('heading', { name: 'Research garden' })).toBeTruthy();
    expect(screen.getByText('Shared context for agents')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'This workspace is ready.' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Create the first page/ }));
    expect(onCreatePage).toHaveBeenCalledTimes(1);
  });

  it('renders sorted recent pages and databases with useful fallbacks', async () => {
    const user = userEvent.setup();
    const invalidDatePage = { ...page, id: 'page-2', title: 'Unparseable date', updated_at: 'not-a-date', tags: [] };
    const { onOpenSearch } = renderView({
      databases: [database],
      databasesHasMore: true,
      pages: [page, invalidDatePage],
      pagesHasMore: true,
    });

    const rows = [...document.querySelectorAll<HTMLAnchorElement>('.recent-row')];
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Unparseable date'),
      expect.stringContaining('Records'),
      expect.stringContaining('Page notes'),
    ]);
    expect(rows[1]?.getAttribute('href')).toBe('#/database/database%20%2F%201');
    expect(rows[2]?.getAttribute('href')).toBe('#/page/page%20%2F%201');
    expect(screen.getByText('Page')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recently changed' })).toBeTruthy();
    expect(screen.getByText(/search finds older items/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Search/ }));
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it('shows loading skeletons and disables competing create actions while creating', async () => {
    const { rerender } = render(
      <HomeView
        creating={null}
        databases={[]}
        databasesHasMore={false}
        loading
        onCreateDatabase={vi.fn(async () => undefined)}
        onCreatePage={vi.fn(async () => undefined)}
        onOpenSearch={vi.fn()}
        pages={[]}
        pagesHasMore={false}
        workspace={{ ...workspace, description: null, icon: '  ' }}
      />,
    );
    expect(screen.getByLabelText('Loading workspace')).toBeTruthy();
    expect(document.querySelector('.workspace-mark')?.textContent).toBe('R');

    rerender(
      <HomeView
        creating="page"
        databases={[]}
        databasesHasMore={false}
        loading={false}
        onCreateDatabase={vi.fn(async () => undefined)}
        onCreatePage={vi.fn(async () => undefined)}
        onOpenSearch={vi.fn()}
        pages={[]}
        pagesHasMore={false}
        workspace={workspace}
      />,
    );
    const creation = screen.getByLabelText('Create knowledge');
    expect(within(creation).getByRole('button', { name: /Creating page/ })).toHaveProperty('disabled', true);
    expect(within(creation).getByRole('button', { name: /New database/ })).toHaveProperty('disabled', true);
  });

  it('starts database creation through the quick action', async () => {
    const user = userEvent.setup();
    const { onCreateDatabase } = renderView();
    await user.click(screen.getByRole('button', { name: /New database/ }));
    expect(onCreateDatabase).toHaveBeenCalledTimes(1);
  });

  it('labels the search shortcut for the current platform', () => {
    expect(searchShortcutLabel('MacIntel', 'Mozilla/5.0 (Macintosh)')).toBe('⌘ K');
    expect(searchShortcutLabel('Win32', 'Mozilla/5.0 (Windows NT 10.0)')).toBe('Ctrl K');
    expect(searchShortcutLabel('', '')).toBe('Ctrl K');
    renderView();
    const hint = document.querySelector('.quick-action kbd')?.textContent;
    expect(hint === '⌘ K' || hint === 'Ctrl K').toBe(true);
  });

  it('counts only the rendered recent items and excludes archived resources', () => {
    const manyPages = Array.from({ length: 10 }, (_, index): Page => ({
      ...page,
      id: `page-${index}`,
      title: `Page ${index}`,
      updated_at: `2026-07-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const manyDatabases = Array.from({ length: 10 }, (_, index): Database => ({
      ...database,
      id: `database-${index}`,
      name: `Database ${index}`,
      updated_at: `2026-08-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const archivedPage = { ...page, archived_at: '2026-07-22T00:00:00.000Z', id: 'page-archived', title: 'Archived page' };
    renderView({ databases: [...manyDatabases, { ...database, archived_at: '2026-08-22T00:00:00.000Z', id: 'database-archived' }], pages: [...manyPages, archivedPage] });

    const rows = [...document.querySelectorAll('.recent-row')];
    expect(rows).toHaveLength(12);
    expect(rows.some((row) => row.textContent?.includes('Archived page'))).toBe(false);
    expect(screen.getByText('Showing 2 pages · 10 databases')).toBeTruthy();
  });
});
