// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DashboardApiClient } from '../api';
import type { Database, Page } from '../types';
import { ArchiveView } from './ArchiveView';

const NOW = '2026-07-22T12:00:00.000Z';

const page: Page = {
  archived_at: NOW,
  created_at: NOW,
  id: 'page-1',
  importance: 0.5,
  parent_page_id: null,
  revision: 3,
  session_id: null,
  tags: [],
  title: 'Archived notes',
  updated_at: NOW,
  workspace_id: 'workspace-1',
};

const database: Database = {
  archived_at: NOW,
  created_at: NOW,
  description: 'Old records',
  id: 'database-1',
  name: 'Archived records',
  parent_page_id: null,
  revision: 4,
  tags: [],
  updated_at: NOW,
  workspace_id: 'workspace-1',
};

const pageInfo = { has_more: false, limit: 50, next_offset: null, offset: 50 };

function success(action: string, result: unknown) {
  return { action, error: null, meta: {}, ok: true as const, result };
}

function renderView(options: {
  databases?: Database[];
  databasesHasMore?: boolean;
  loading?: boolean;
  pageImpl?: (input: Record<string, unknown>) => Promise<unknown>;
  pages?: Page[];
  pagesHasMore?: boolean;
} = {}) {
  const pageApi = vi.fn(options.pageImpl ?? (async (input) => success(String(input.action), {})));
  const databaseApi = vi.fn(async (input: Record<string, unknown>) => success(String(input.action), {}));
  const navigate = vi.fn();
  const onChanged = vi.fn(async () => undefined);
  const showToast = vi.fn();
  render(
    <ArchiveView
      api={{ database: databaseApi, page: pageApi } as unknown as DashboardApiClient}
      databases={options.databases ?? [database]}
      databasesHasMore={options.databasesHasMore ?? false}
      loading={options.loading ?? false}
      navigate={navigate}
      onChanged={onChanged}
      pages={options.pages ?? [page]}
      pagesHasMore={options.pagesHasMore ?? false}
      showToast={showToast}
      workspaceId="workspace-1"
    />,
  );
  return { databaseApi, navigate, onChanged, pageApi, showToast };
}

afterEach(() => cleanup());

describe('ArchiveView', () => {
  it('restores archived pages and databases, then opens the restored item', async () => {
    const user = userEvent.setup();
    const { databaseApi, navigate, onChanged, pageApi, showToast } = renderView();

    expect(screen.getByRole('heading', { name: 'Pages' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Databases' })).toBeTruthy();
    expect(screen.getByText('Archived notes')).toBeTruthy();

    const pageSection = screen.getByRole('heading', { name: 'Pages' }).parentElement!;
    await user.click(within(pageSection).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(pageApi).toHaveBeenCalledWith({
      action: 'restore', page_id: page.id, revision: page.revision,
    }));
    expect(navigate).toHaveBeenCalledWith({ name: 'page', pageId: page.id });
    expect(showToast).toHaveBeenCalledWith('Restored “Archived notes”.');

    const databaseSection = screen.getByRole('heading', { name: 'Databases' }).parentElement!;
    await user.click(within(databaseSection).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(databaseApi).toHaveBeenCalledWith({
      action: 'restore', database_id: database.id, revision: database.revision,
    }));
    expect(navigate).toHaveBeenCalledWith({ name: 'database', databaseId: database.id });
    expect(showToast).toHaveBeenCalledWith('Restored “Archived records”.');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  });

  it('loads older archived records, de-duplicates them, and shows the older results', async () => {
    const user = userEvent.setup();
    const olderPage = { ...page, id: 'page-2', title: 'Older page' };
    const olderDatabase = { ...database, id: 'database-2', name: 'Older database' };
    const pageApi = vi.fn(async (input: Record<string, unknown>) => success(String(input.action), {
      items: [page, olderPage], page: pageInfo,
    }));
    const databaseApi = vi.fn(async (input: Record<string, unknown>) => success(String(input.action), {
      items: [database, olderDatabase], page: pageInfo,
    }));
    const navigate = vi.fn();
    render(
      <ArchiveView
        api={{ database: databaseApi, page: pageApi } as unknown as DashboardApiClient}
        databases={[database]}
        databasesHasMore
        loading={false}
        navigate={navigate}
        onChanged={vi.fn(async () => undefined)}
        pages={[page]}
        pagesHasMore
        showToast={vi.fn()}
        workspaceId="workspace-1"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Load older items' }));
    await waitFor(() => expect(pageApi).toHaveBeenCalledWith({
      action: 'list', include_archived: true, limit: 50, offset: 50, workspace_id: 'workspace-1',
    }));
    expect(databaseApi).toHaveBeenCalledWith({
      action: 'list', include_archived: true, limit: 50, offset: 50, workspace_id: 'workspace-1',
    });
    expect(await screen.findByText('Older page')).toBeTruthy();
    expect(screen.getByText('Older database')).toBeTruthy();
    expect(screen.getAllByText('Archived notes')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load older items' })).toBeNull();
  });

  it('covers loading, empty, and failed older-load states', async () => {
    const { rerender } = render(
      <ArchiveView
        api={{ database: vi.fn(), page: vi.fn() } as unknown as DashboardApiClient}
        databases={[]}
        databasesHasMore={false}
        loading
        navigate={vi.fn()}
        onChanged={vi.fn(async () => undefined)}
        pages={[]}
        pagesHasMore={false}
        showToast={vi.fn()}
        workspaceId="workspace-1"
      />,
    );
    expect(document.querySelector('.home-skeleton')).toBeTruthy();

    rerender(
      <ArchiveView
        api={{ database: vi.fn(), page: vi.fn() } as unknown as DashboardApiClient}
        databases={[]}
        databasesHasMore={false}
        loading={false}
        navigate={vi.fn()}
        onChanged={vi.fn(async () => undefined)}
        pages={[]}
        pagesHasMore={false}
        showToast={vi.fn()}
        workspaceId="workspace-1"
      />,
    );
    expect(screen.getByRole('heading', { name: 'Nothing archived' })).toBeTruthy();

    cleanup();
    const user = userEvent.setup();
    const { pageApi } = renderView({
      databases: [],
      databasesHasMore: false,
      pageImpl: async () => { throw new Error('offline'); },
      pages: [],
      pagesHasMore: true,
    });
    await user.click(screen.getByRole('button', { name: 'Check older items' }));
    expect((await screen.findByRole('alert')).textContent).toContain('offline');
    expect(pageApi).toHaveBeenCalledTimes(1);
  });

  it('reports page restore errors without navigating', async () => {
    const user = userEvent.setup();
    const { navigate, showToast } = renderView({
      databases: [],
      pageImpl: async () => { throw new Error('Restore unavailable'); },
    });
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Restore unavailable', { tone: 'error' }));
    expect(navigate).not.toHaveBeenCalled();
  });
});
