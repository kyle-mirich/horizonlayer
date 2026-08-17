import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import { dashboardApi, type DashboardApiClient } from './api';
import { Icon } from './components/Icon';
import type { DashboardStatus, Database, Page, Workspace } from './types';
import { DashboardViewContext } from './shell/DashboardContext';
import { SearchPalette } from './shell/SearchPalette';
import { Sidebar } from './shell/Sidebar';
import { StatusDialog } from './shell/StatusDialog';
import { WorkspaceContent } from './shell/WorkspaceContent';
import {
  Onboarding,
  WorkspaceDialog,
  type WorkspaceDraft,
} from './shell/WorkspaceDialog';
import {
  dashboardHash,
  parseDashboardHash,
  type DashboardRoute,
  type DashboardRouteTarget,
} from './shell/routing';

const WORKSPACE_STORAGE_KEY = 'horizonlayer.workspace';
const PAGE_SIZE = 50;

interface WorkspaceIndex {
  databases: Database[];
  databasesHasMore: boolean;
  error: string | null;
  loading: boolean;
  pages: Page[];
  pagesHasMore: boolean;
  workspaceId: string | null;
}

interface Toast {
  id: number;
  message: string;
  tone: 'default' | 'error';
}

async function listAllWorkspaces(api: DashboardApiClient, signal?: AbortSignal): Promise<Workspace[]> {
  const items: Workspace[] = [];
  let offset = 0;
  while (true) {
    const envelope = await api.workspace({
      action: 'list',
      include_archived: true,
      limit: PAGE_SIZE,
      offset,
    }, { signal });
    items.push(...envelope.result.items);
    if (envelope.result.page.next_offset === null) return items;
    offset = envelope.result.page.next_offset;
  }
}

async function listWorkspacePages(
  api: DashboardApiClient,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<{ hasMore: boolean; items: Page[] }> {
  const envelope = await api.page({
    action: 'list',
    include_archived: true,
    limit: PAGE_SIZE,
    offset: 0,
    workspace_id: workspaceId,
  }, { signal });
  return { hasMore: envelope.result.page.has_more, items: envelope.result.items };
}

async function listWorkspaceDatabases(
  api: DashboardApiClient,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<{ hasMore: boolean; items: Database[] }> {
  const envelope = await api.database({
    action: 'list',
    include_archived: true,
    limit: PAGE_SIZE,
    offset: 0,
    workspace_id: workspaceId,
  }, { signal });
  return { hasMore: envelope.result.page.has_more, items: envelope.result.items };
}

function storedWorkspaceId(): string | null {
  try {
    return window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function useHashRoute() {
  const [route, setRoute] = useState<DashboardRoute>(() => parseDashboardHash(window.location.hash));

  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', dashboardHash({ name: 'home' }));
    const onHashChange = () => setRoute(parseDashboardHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((target: DashboardRouteTarget) => {
    const hash = dashboardHash(target);
    if (window.location.hash === hash) setRoute(parseDashboardHash(hash));
    else window.location.hash = hash;
  }, []);

  return { navigate, route };
}

function focusMainContent(event: ReactMouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const main = document.getElementById('main-content');
  if (!main) return;
  const hadTabIndex = main.hasAttribute('tabindex');
  if (!hadTabIndex) main.setAttribute('tabindex', '-1');
  main.focus();
  if (!hadTabIndex) {
    main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true });
  }
}

export function App({ api = dashboardApi }: { api?: DashboardApiClient }) {
  const { navigate, route } = useHashRoute();
  const [status, setStatus] = useState<DashboardStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [starting, setStarting] = useState(true);
  const [workspaceIndex, setWorkspaceIndex] = useState<WorkspaceIndex>({
    databases: [],
    databasesHasMore: false,
    error: null,
    loading: false,
    pages: [],
    pagesHasMore: false,
    workspaceId: null,
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [creating, setCreating] = useState<'database' | 'page' | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const toastTimers = useRef(new Set<number>());
  const dataRequest = useRef(0);

  const activeWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.archived_at === null),
    [workspaces],
  );
  const workspace = activeWorkspaces.find((item) => item.id === workspaceId)
    ?? activeWorkspaces[0]
    ?? null;

  const showToast = useCallback((message: string, options?: { tone?: 'default' | 'error' }) => {
    const id = ++toastId.current;
    setToasts((value) => [...value, { id, message, tone: options?.tone ?? 'default' }]);
    const timer = window.setTimeout(() => {
      toastTimers.current.delete(timer);
      setToasts((value) => value.filter((toast) => toast.id !== id));
    }, 4_600);
    toastTimers.current.add(timer);
  }, []);

  useEffect(() => () => {
    for (const timer of toastTimers.current) window.clearTimeout(timer);
    toastTimers.current.clear();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setStarting(true);
    setStartupError(null);
    void Promise.all([
      api.status({ signal: controller.signal }),
      listAllWorkspaces(api, controller.signal),
    ]).then(([nextStatus, nextWorkspaces]) => {
      const active = nextWorkspaces.filter((item) => item.archived_at === null);
      const savedId = storedWorkspaceId();
      const selected = active.find((item) => item.id === savedId) ?? active[0] ?? null;
      setStatus(nextStatus);
      setWorkspaces(nextWorkspaces);
      setWorkspaceId(selected?.id ?? null);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setStartupError(error instanceof Error ? error.message : 'The local dashboard could not start.');
      }
    }).finally(() => {
      if (!controller.signal.aborted) setStarting(false);
    });
    return () => controller.abort();
  }, [api, startupAttempt]);

  useEffect(() => {
    if (!workspace) return;
    try {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, workspace.id);
    } catch {
      // A blocked localStorage does not prevent a local dashboard from working.
    }
  }, [workspace]);

  const loadWorkspaceIndex = useCallback(async (targetWorkspaceId: string, signal?: AbortSignal) => {
    const request = ++dataRequest.current;
    setWorkspaceIndex((current) => ({
      databases: current.workspaceId === targetWorkspaceId ? current.databases : [],
      databasesHasMore: current.workspaceId === targetWorkspaceId ? current.databasesHasMore : false,
      error: null,
      loading: true,
      pages: current.workspaceId === targetWorkspaceId ? current.pages : [],
      pagesHasMore: current.workspaceId === targetWorkspaceId ? current.pagesHasMore : false,
      workspaceId: targetWorkspaceId,
    }));
    try {
      const [pagesResult, databasesResult] = await Promise.all([
        listWorkspacePages(api, targetWorkspaceId, signal),
        listWorkspaceDatabases(api, targetWorkspaceId, signal),
      ]);
      if (request !== dataRequest.current) return;
      setWorkspaceIndex({
        databases: databasesResult.items.sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
        databasesHasMore: databasesResult.hasMore,
        error: null,
        loading: false,
        pages: pagesResult.items.sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
        pagesHasMore: pagesResult.hasMore,
        workspaceId: targetWorkspaceId,
      });
    } catch (error) {
      if (signal?.aborted || request !== dataRequest.current) return;
      setWorkspaceIndex((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Workspace contents could not be loaded.',
        loading: false,
      }));
    }
  }, [api]);

  useEffect(() => {
    if (!workspace) {
      setWorkspaceIndex({
        databases: [],
        databasesHasMore: false,
        error: null,
        loading: false,
        pages: [],
        pagesHasMore: false,
        workspaceId: null,
      });
      return;
    }
    const controller = new AbortController();
    void loadWorkspaceIndex(workspace.id, controller.signal);
    return () => controller.abort();
  }, [loadWorkspaceIndex, workspace]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [route]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (workspace && !document.querySelector('[role="dialog"]')) setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [workspace]);

  const refreshWorkspaces = useCallback(async (preferredId?: string) => {
    const next = await listAllWorkspaces(api);
    const active = next.filter((item) => item.archived_at === null);
    const selected = active.find((item) => item.id === preferredId)
      ?? active.find((item) => item.id === workspaceId)
      ?? active[0]
      ?? null;
    setWorkspaces(next);
    setWorkspaceId(selected?.id ?? null);
  }, [api, workspaceId]);

  const refreshWorkspaceData = useCallback(async () => {
    if (workspace) await loadWorkspaceIndex(workspace.id);
  }, [loadWorkspaceIndex, workspace]);

  async function createWorkspace(draft: WorkspaceDraft) {
    const envelope = await api.workspace({
      action: 'create',
      ...(draft.description ? { description: draft.description } : {}),
      ...(draft.icon ? { icon: draft.icon } : {}),
      name: draft.name,
    });
    await refreshWorkspaces(envelope.result.id);
    navigate({ name: 'home' });
    showToast(`Created “${envelope.result.name}”.`);
  }

  async function updateWorkspace(target: Workspace, draft: WorkspaceDraft) {
    await api.workspace({
      action: 'update',
      description: draft.description || null,
      icon: draft.icon || null,
      name: draft.name,
      revision: target.revision,
      workspace_id: target.id,
    });
    await refreshWorkspaces(target.id);
    showToast('Workspace details saved.');
  }

  async function archiveWorkspace(target: Workspace) {
    await api.workspace({
      action: 'archive',
      revision: target.revision,
      workspace_id: target.id,
    });
    await refreshWorkspaces(target.id === workspace?.id ? undefined : workspace?.id);
    if (target.id === workspace?.id) navigate({ name: 'home' });
    showToast(`Archived “${target.name}”.`);
  }

  async function restoreWorkspace(target: Workspace) {
    await api.workspace({
      action: 'restore',
      revision: target.revision,
      workspace_id: target.id,
    });
    await refreshWorkspaces(target.id);
    navigate({ name: 'home' });
    showToast(`Restored “${target.name}”.`);
  }

  async function createPage() {
    if (!workspace || creating) return;
    setCreating('page');
    try {
      const envelope = await api.page({
        action: 'create',
        blocks: [{ block_type: 'text', content: '' }],
        title: 'Untitled',
        workspace_id: workspace.id,
      });
      navigate({ name: 'page', pageId: envelope.result.id });
      void refreshWorkspaceData();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'A new page could not be created.', { tone: 'error' });
    } finally {
      setCreating(null);
    }
  }

  async function createDatabase() {
    if (!workspace || creating) return;
    setCreating('database');
    try {
      const envelope = await api.database({
        action: 'create',
        name: 'Untitled database',
        workspace_id: workspace.id,
      });
      navigate({ name: 'database', databaseId: envelope.result.id });
      void refreshWorkspaceData();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'A new database could not be created.', { tone: 'error' });
    } finally {
      setCreating(null);
    }
  }

  const contextValue = useMemo(() => workspace ? {
    api,
    navigate,
    refreshWorkspaceData,
    showToast,
    workspace,
  } : null, [api, navigate, refreshWorkspaceData, showToast, workspace]);

  if (starting) return <StartupScreen />;
  if (startupError || !status) {
    return (
      <main className="startup-screen">
        <div className="startup-card startup-card--error">
          <span className="entity-glyph entity-glyph--error"><Icon name="warning" /></span>
          <p className="eyebrow">Local dashboard</p>
          <h1>HorizonLayer isn’t reachable.</h1>
          <p>{startupError ?? 'The dashboard returned an incomplete status response.'}</p>
          <button className="button button--primary" onClick={() => setStartupAttempt((value) => value + 1)} type="button">
            <Icon name="refresh" size={16} /> Try again
          </button>
          <small>Check that PostgreSQL is running, then restart <code>horizonlayer dashboard</code>.</small>
        </div>
      </main>
    );
  }

  if (!workspace || !contextValue) {
    return (
      <>
        <Onboarding
          archivedCount={workspaces.filter((item) => item.archived_at !== null).length}
          onCreate={createWorkspace}
          onOpenWorkspaces={() => setWorkspaceDialogOpen(true)}
        />
        {workspaceDialogOpen ? (
          <WorkspaceDialog
            currentWorkspaceId={null}
            onArchive={archiveWorkspace}
            onClose={() => setWorkspaceDialogOpen(false)}
            onCreate={createWorkspace}
            onRestore={restoreWorkspace}
            onSelect={() => undefined}
            onUpdate={updateWorkspace}
            workspaces={workspaces}
          />
        ) : null}
        <ToastRegion onDismiss={(id) => setToasts((value) => value.filter((toast) => toast.id !== id))} toasts={toasts} />
      </>
    );
  }

  const currentIndex = workspaceIndex.workspaceId === workspace.id
    ? workspaceIndex
    : {
        databases: [],
        databasesHasMore: false,
        error: null,
        loading: true,
        pages: [],
        pagesHasMore: false,
        workspaceId: workspace.id,
      };
  const activePages = currentIndex.pages.filter((page) => page.archived_at === null);
  const activeDatabases = currentIndex.databases.filter((database) => database.archived_at === null);
  const routeLabel = route.name === 'page'
    ? activePages.find((page) => page.id === route.pageId)?.title ?? 'Page'
    : route.name === 'database'
      ? activeDatabases.find((database) => database.id === route.databaseId)?.name ?? 'Database'
      : route.name === 'archive'
        ? 'Archive'
        : workspace.name;

  return (
    <DashboardViewContext.Provider value={contextValue}>
      <a
        aria-hidden={drawerOpen ? true : undefined}
        className="skip-link"
        href="#main-content"
        onClick={focusMainContent}
        tabIndex={drawerOpen ? -1 : undefined}
      >Skip to content</a>
      <div className="app-shell">
        <Sidebar
          creating={creating}
          databases={activeDatabases}
          drawerOpen={drawerOpen}
          loading={currentIndex.loading}
          onCloseDrawer={() => setDrawerOpen(false)}
          onCreateDatabase={createDatabase}
          onCreatePage={createPage}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenStatus={() => setStatusOpen(true)}
          onOpenWorkspaces={() => setWorkspaceDialogOpen(true)}
          pages={activePages}
          route={route}
          workspace={workspace}
        />
        <div className="app-main" inert={drawerOpen ? true : undefined}>
          <header className="mobile-toolbar">
            <button className="icon-button" onClick={() => setDrawerOpen(true)} type="button" aria-label="Open navigation">
              <Icon name="menu" />
            </button>
            <span>{routeLabel}</span>
            <button className="icon-button" onClick={() => setSearchOpen(true)} type="button" aria-label="Search knowledge">
              <Icon name="search" />
            </button>
          </header>
          <header className="desktop-context-bar">
            <span>{workspace.name}</span><i aria-hidden="true" /> <strong>{routeLabel}</strong>
            <div className="desktop-context-bar__actions">
              <button className="icon-button" onClick={() => setSearchOpen(true)} type="button" aria-label="Search knowledge">
                <Icon name="search" size={17} />
              </button>
            </div>
          </header>
          {currentIndex.error ? (
            <div className="inline-alert" role="alert">
              <Icon name="warning" size={17} />
              <span><strong>Workspace index is out of date.</strong> {currentIndex.error}</span>
              <button className="text-button" onClick={() => void refreshWorkspaceData()} type="button">Retry</button>
            </div>
          ) : null}
          <WorkspaceContent
            api={api}
            creating={creating}
            databases={currentIndex.databases}
            databasesHasMore={currentIndex.databasesHasMore}
            loading={currentIndex.loading}
            navigate={navigate}
            onCreateDatabase={createDatabase}
            onCreatePage={createPage}
            onOpenSearch={() => setSearchOpen(true)}
            onWorkspaceDataChanged={refreshWorkspaceData}
            pages={currentIndex.pages}
            pagesHasMore={currentIndex.pagesHasMore}
            route={route}
            showToast={showToast}
            workspace={workspace}
          />
        </div>
      </div>

      {searchOpen ? (
        <SearchPalette
          api={api}
          onClose={() => setSearchOpen(false)}
          onNavigate={navigate}
          ragEnabled={status.rag.enabled}
          workspace={workspace}
        />
      ) : null}
      {statusOpen ? (
        <StatusDialog api={api} onClose={() => setStatusOpen(false)} status={status} />
      ) : null}
      {workspaceDialogOpen ? (
        <WorkspaceDialog
          currentWorkspaceId={workspace.id}
          onArchive={archiveWorkspace}
          onClose={() => setWorkspaceDialogOpen(false)}
          onCreate={createWorkspace}
          onRestore={restoreWorkspace}
          onSelect={(selected) => {
            setWorkspaceId(selected.id);
            setWorkspaceDialogOpen(false);
            navigate({ name: 'home' });
          }}
          onUpdate={updateWorkspace}
          workspaces={workspaces}
        />
      ) : null}
      <ToastRegion onDismiss={(id) => setToasts((value) => value.filter((toast) => toast.id !== id))} toasts={toasts} />
    </DashboardViewContext.Provider>
  );
}

function StartupScreen() {
  return (
    <main className="startup-screen" aria-label="Loading HorizonLayer">
      <div className="startup-mark" aria-hidden="true"><i /><i /><i /></div>
      <p>Opening local knowledge…</p>
    </main>
  );
}

function ToastRegion({ onDismiss, toasts }: { onDismiss(id: number): void; toasts: Toast[] }) {
  return (
    <div className="toast-region" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <div className={`toast${toast.tone === 'error' ? ' toast--error' : ''}`} key={toast.id} role={toast.tone === 'error' ? 'alert' : 'status'}>
          <span>{toast.message}</span>
          <button className="icon-button icon-button--small" onClick={() => onDismiss(toast.id)} type="button" aria-label="Dismiss message">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
