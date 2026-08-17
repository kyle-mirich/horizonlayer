// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../views/PageView', () => ({
  PageView: ({ pageId }: { pageId: string }) => <div>Mock page {pageId}</div>,
}));
vi.mock('../views/DatabaseView', () => ({
  DatabaseView: ({ databaseId, rowId }: { databaseId: string; rowId?: string }) => (
    <div>Mock database {databaseId} {rowId ?? 'no row'}</div>
  ),
}));

import type { DashboardApiClient } from '../api';
import type { Database, Page, Workspace } from '../types';
import { WorkspaceContent } from './WorkspaceContent';

const NOW = '2026-07-01T00:00:00.000Z';
const workspace: Workspace = {
  archived_at: null, created_at: NOW, description: null, icon: null, id: 'workspace-1',
  name: 'Research', revision: 1, updated_at: NOW,
};
const archivedPage: Page = {
  archived_at: NOW, created_at: NOW, id: 'page-1', importance: 0.5, parent_page_id: null,
  revision: 1, session_id: null, tags: [], title: 'Archived page', updated_at: NOW, workspace_id: workspace.id,
};
const archivedDatabase: Database = {
  archived_at: NOW, created_at: NOW, description: null, id: 'database-1', name: 'Archived database',
  parent_page_id: null, revision: 1, tags: [], updated_at: NOW, workspace_id: workspace.id,
};

function renderContent(route: React.ComponentProps<typeof WorkspaceContent>['route']) {
  const navigate = vi.fn();
  const onCreateDatabase = vi.fn(async () => undefined);
  const onCreatePage = vi.fn(async () => undefined);
  const onOpenSearch = vi.fn();
  const rendered = render(
    <WorkspaceContent
      api={{ database: vi.fn(), page: vi.fn() } as unknown as DashboardApiClient}
      creating={null}
      databases={[archivedDatabase]}
      databasesHasMore={false}
      loading={false}
      navigate={navigate}
      onCreateDatabase={onCreateDatabase}
      onCreatePage={onCreatePage}
      onOpenSearch={onOpenSearch}
      onWorkspaceDataChanged={vi.fn(async () => undefined)}
      pages={[archivedPage]}
      pagesHasMore={false}
      route={route}
      showToast={vi.fn()}
      workspace={workspace}
    />,
  );
  return { ...rendered, navigate, onCreateDatabase, onCreatePage, onOpenSearch };
}

afterEach(() => cleanup());

describe('WorkspaceContent', () => {
  it('passes active resources into the home view and preserves its actions', () => {
    const { onCreatePage, onOpenSearch } = renderContent({ name: 'home' });
    expect(screen.getByRole('heading', { name: 'This workspace is ready.' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Create the first page/ }));
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    expect(onCreatePage).toHaveBeenCalledTimes(1);
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it('routes archive and unknown views to their respective screens', () => {
    const { unmount } = renderContent({ name: 'archive' });
    expect(screen.getAllByText('Archived page')).toHaveLength(2);
    expect(screen.getAllByText('Archived database')).toHaveLength(2);
    unmount();

    const { navigate } = renderContent({ name: 'not-found' });
    expect(screen.getByRole('heading', { name: 'That place isn’t in this workspace.' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }));
    expect(navigate).toHaveBeenCalledWith({ name: 'home' });
  });

  it('loads the page and database editor branches lazily', async () => {
    const { unmount } = renderContent({ name: 'page', pageId: 'page-9' });
    expect(await screen.findByText('Mock page page-9')).toBeTruthy();
    unmount();

    renderContent({ name: 'database', databaseId: 'database-9', rowId: 'row-9' });
    expect(await screen.findByText('Mock database database-9 row-9')).toBeTruthy();
  });
});
