import { lazy, Suspense } from 'react';

import type { DashboardApiClient } from '../api';
import { Icon } from '../components/Icon';
import type { Database, Page, Workspace } from '../types';
import { ArchiveView } from './ArchiveView';
import { HomeView } from './HomeView';
import type { DashboardRoute, DashboardRouteTarget } from './routing';

const PageView = lazy(async () => {
  const module = await import('../views/PageView');
  return { default: module.PageView };
});

const DatabaseView = lazy(async () => {
  const module = await import('../views/DatabaseView');
  return { default: module.DatabaseView };
});

function EditorLoading() {
  return (
    <main className="workspace-canvas editor-loading" id="main-content" aria-label="Loading editor">
      <i /><i /><i />
    </main>
  );
}

export function WorkspaceContent({
  api,
  creating,
  databases,
  databasesHasMore,
  loading,
  navigate,
  onCreateDatabase,
  onCreatePage,
  onOpenSearch,
  onWorkspaceDataChanged,
  pages,
  pagesHasMore,
  route,
  showToast,
  workspace,
}: {
  api: DashboardApiClient;
  creating: 'database' | 'page' | null;
  databases: Database[];
  databasesHasMore: boolean;
  loading: boolean;
  navigate(route: DashboardRouteTarget): void;
  onCreateDatabase(): Promise<void>;
  onCreatePage(): Promise<void>;
  onOpenSearch(): void;
  onWorkspaceDataChanged(): Promise<void>;
  pages: Page[];
  pagesHasMore: boolean;
  route: DashboardRoute;
  showToast(message: string, options?: { tone?: 'default' | 'error' }): void;
  workspace: Workspace;
}) {
  if (route.name === 'page') {
    return <Suspense fallback={<EditorLoading />}><PageView key={route.pageId} pageId={route.pageId} /></Suspense>;
  }
  if (route.name === 'database') {
    return (
      <Suspense fallback={<EditorLoading />}>
        <DatabaseView databaseId={route.databaseId} key={route.databaseId} rowId={route.rowId} />
      </Suspense>
    );
  }
  if (route.name === 'archive') {
    return (
      <ArchiveView
        api={api}
        databases={databases}
        databasesHasMore={databasesHasMore}
        key={workspace.id}
        loading={loading}
        navigate={navigate}
        onChanged={onWorkspaceDataChanged}
        pages={pages}
        pagesHasMore={pagesHasMore}
        showToast={showToast}
        workspaceId={workspace.id}
      />
    );
  }
  if (route.name === 'not-found') {
    return (
      <main className="workspace-canvas route-missing" id="main-content">
        <span className="entity-glyph entity-glyph--archive"><Icon name="warning" /></span>
        <p className="eyebrow">Unknown view</p>
        <h1>That place isn’t in this workspace.</h1>
        <p>The link may be incomplete, or the item may have been archived.</p>
        <button className="button button--primary" onClick={() => navigate({ name: 'home' })} type="button">
          Back to workspace
        </button>
      </main>
    );
  }
  return (
    <HomeView
      creating={creating}
      databases={databases.filter((database) => database.archived_at === null)}
      databasesHasMore={databasesHasMore}
      loading={loading}
      onCreateDatabase={onCreateDatabase}
      onCreatePage={onCreatePage}
      onOpenSearch={onOpenSearch}
      pages={pages.filter((page) => page.archived_at === null)}
      pagesHasMore={pagesHasMore}
      workspace={workspace}
    />
  );
}
