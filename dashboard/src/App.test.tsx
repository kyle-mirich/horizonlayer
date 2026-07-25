// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import type { DashboardApiClient } from './api';
import type { DashboardStatus, Database, Page, Workspace } from './types';

type UnknownProps = Record<string, unknown>;

vi.mock('./shell/Sidebar', () => ({
  Sidebar: (props: UnknownProps) => (
    <aside
      data-creating={String(props.creating ?? '')}
      data-databases={(props.databases as Array<{ id: string }>).map((item) => item.id).join(',')}
      data-drawer={String(props.drawerOpen)}
      data-loading={String(props.loading)}
      data-pages={(props.pages as Array<{ id: string }>).map((item) => item.id).join(',')}
      data-testid="sidebar"
    >
      <button onClick={() => (props.onCloseDrawer as () => void)()} type="button">sidebar close drawer</button>
      <button onClick={() => void (props.onCreatePage as () => Promise<void>)()} type="button">sidebar create page</button>
      <button onClick={() => void (props.onCreateDatabase as () => Promise<void>)()} type="button">sidebar create database</button>
      <button onClick={() => (props.onOpenSearch as () => void)()} type="button">sidebar search</button>
      <button onClick={() => (props.onOpenStatus as () => void)()} type="button">sidebar status</button>
      <button onClick={() => (props.onOpenWorkspaces as () => void)()} type="button">sidebar workspaces</button>
    </aside>
  ),
}));

vi.mock('./shell/WorkspaceContent', () => ({
  WorkspaceContent: (props: UnknownProps) => (
    <main data-route={JSON.stringify(props.route)} data-testid="workspace-content" id="main-content">
      <output data-testid="content-workspace">{(props.workspace as Workspace).id}</output>
      <output data-testid="content-pages">{(props.pages as Array<{ id: string }>).map((item) => item.id).join(',')}</output>
      <output data-testid="content-databases">{(props.databases as Array<{ id: string }>).map((item) => item.id).join(',')}</output>
      <button onClick={() => void (props.onCreatePage as () => Promise<void>)()} type="button">content create page</button>
      <button onClick={() => void (props.onCreateDatabase as () => Promise<void>)()} type="button">content create database</button>
      <button onClick={() => (props.onOpenSearch as () => void)()} type="button">content search</button>
      <button onClick={() => void (props.onWorkspaceDataChanged as () => Promise<void>)()} type="button">content refresh</button>
      <button onClick={() => (props.navigate as (target: { name: 'archive' }) => void)({ name: 'archive' })} type="button">content archive route</button>
      <button onClick={() => (props.navigate as (target: { name: 'page'; pageId: string }) => void)({ name: 'page', pageId: 'missing-page' })} type="button">content missing page route</button>
      <button onClick={() => (props.navigate as (target: { name: 'database'; databaseId: string }) => void)({ name: 'database', databaseId: 'missing-database' })} type="button">content missing database route</button>
    </main>
  ),
}));

vi.mock('./shell/SearchPalette', () => ({
  SearchPalette: (props: UnknownProps) => (
    <div aria-label="Mock search" role="dialog">
      <output data-testid="search-rag">{String(props.ragEnabled)}</output>
      <output data-testid="search-workspace">{(props.workspace as Workspace).id}</output>
      <button onClick={() => (props.onClose as () => void)()} type="button">search close</button>
      <button onClick={() => (props.onNavigate as (target: { name: 'archive' }) => void)({ name: 'archive' })} type="button">search archive route</button>
    </div>
  ),
}));

vi.mock('./shell/StatusDialog', () => ({
  StatusDialog: (props: UnknownProps) => (
    <div aria-label="Mock status" role="dialog">
      <output data-testid="status-database">{(props.status as DashboardStatus).database}</output>
      <button onClick={() => (props.onClose as () => void)()} type="button">status close</button>
    </div>
  ),
}));

vi.mock('./shell/WorkspaceDialog', () => ({
  Onboarding: (props: UnknownProps) => (
    <section data-testid="onboarding">
      <output data-testid="archived-count">{String(props.archivedCount)}</output>
      <button onClick={() => void (props.onCreate as (draft: { name: string; description: string; icon: string }) => Promise<void>)({
        name: 'Onboarded', description: '', icon: '',
      })} type="button">onboarding create</button>
      <button onClick={() => (props.onOpenWorkspaces as () => void)()} type="button">onboarding workspaces</button>
    </section>
  ),
  WorkspaceDialog: (props: UnknownProps) => {
    const workspaces = props.workspaces as Workspace[];
    const current = workspaces.find((workspace) => workspace.id === props.currentWorkspaceId) ?? workspaces[0];
    const second = workspaces[1] ?? current;
    return (
      <div aria-label="Mock workspaces" role="dialog">
        <output data-testid="dialog-current">{String(props.currentWorkspaceId)}</output>
        <button onClick={() => (props.onClose as () => void)()} type="button">dialog close</button>
        <button onClick={() => void (props.onCreate as (draft: { name: string; description: string; icon: string }) => Promise<void>)({
          name: 'Created', description: 'New context', icon: '✦',
        })} type="button">dialog create</button>
        <button onClick={() => void (props.onUpdate as (workspace: Workspace, draft: { name: string; description: string; icon: string }) => Promise<void>)(current, {
          name: 'Renamed', description: '', icon: '',
        })} type="button">dialog update</button>
        <button onClick={() => void (props.onArchive as (workspace: Workspace) => Promise<void>)(current)} type="button">dialog archive</button>
        <button onClick={() => void (props.onArchive as (workspace: Workspace) => Promise<void>)(workspaces[0])} type="button">dialog archive first</button>
        <button onClick={() => void (props.onRestore as (workspace: Workspace) => Promise<void>)(current)} type="button">dialog restore</button>
        <button onClick={() => (props.onSelect as (workspace: Workspace) => void)(second)} type="button">dialog select second</button>
      </div>
    );
  },
}));

const status: DashboardStatus = {
  database: 'connected',
  mcp: { available: true, command: 'horizonlayer' },
  rag: { enabled: true },
  tools: ['workspace', 'page', 'database', 'row', 'search'],
  version: '2.0.0',
};

const pageInfo = {
  has_more: false,
  limit: 50,
  next_offset: null,
  offset: 0,
};

function workspace(id: string, name = id, archived_at: string | null = null): Workspace {
  return {
    archived_at,
    created_at: '2026-07-01T00:00:00.000Z',
    description: null,
    icon: null,
    id,
    name,
    revision: 1,
    updated_at: '2026-07-02T00:00:00.000Z',
  };
}

function page(id: string, workspace_id: string, updated_at = '2026-07-02T00:00:00.000Z', archived_at: string | null = null): Page {
  return {
    archived_at,
    created_at: '2026-07-01T00:00:00.000Z',
    id,
    importance: 0.5,
    parent_page_id: null,
    revision: 1,
    session_id: null,
    tags: [],
    title: id,
    updated_at,
    workspace_id,
  };
}

function database(id: string, workspace_id: string, updated_at = '2026-07-02T00:00:00.000Z', archived_at: string | null = null): Database {
  return {
    archived_at,
    created_at: '2026-07-01T00:00:00.000Z',
    description: null,
    id,
    name: id,
    parent_page_id: null,
    revision: 1,
    tags: [],
    updated_at,
    workspace_id,
  };
}

function success(action: string, result: unknown) {
  return { action, error: null, meta: {}, ok: true, result };
}

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

interface ApiOptions {
  databases?: Database[];
  pages?: Page[];
  status?: () => Promise<DashboardStatus>;
  workspace?: (input: Record<string, unknown>) => Promise<unknown>;
}

function makeApi(options: ApiOptions = {}) {
  const statusMock = vi.fn(options.status ?? (async () => status));
  const workspaceMock = vi.fn(options.workspace ?? (async (input: Record<string, unknown>) => {
    if (input.action === 'list') return success('list', { items: [workspace('workspace-1')], page: pageInfo });
    if (input.action === 'create') return success('create', workspace('workspace-created', String(input.name)));
    return success(String(input.action), workspace(String(input.workspace_id ?? 'workspace-1')));
  }));
  const pageMock = vi.fn(async (input: Record<string, unknown>) => {
    if (input.action === 'list') return success('list', { items: options.pages ?? [], page: pageInfo });
    return success('create', page('created-page', String(input.workspace_id)));
  });
  const databaseMock = vi.fn(async (input: Record<string, unknown>) => {
    if (input.action === 'list') return success('list', { items: options.databases ?? [], page: pageInfo });
    return success('create', database('created-database', String(input.workspace_id)));
  });
  return {
    api: {
      database: databaseMock,
      page: pageMock,
      status: statusMock,
      workspace: workspaceMock,
    } as unknown as DashboardApiClient,
    databaseMock,
    pageMock,
    statusMock,
    workspaceMock,
  };
}

async function waitForWorkspace(id: string) {
  await waitFor(() => expect(screen.getByTestId('content-workspace').textContent).toContain(id));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
});

describe('App orchestration', () => {
  it('boots from a paginated workspace index, honors saved selection, and sorts active records', async () => {
    const first = workspace('workspace-1', 'First');
    const saved = workspace('workspace-2', 'Saved');
    const archived = workspace('workspace-archived', 'Archived', '2026-07-03T00:00:00.000Z');
    window.localStorage.setItem('horizonlayer.workspace', saved.id);
    const workspaceMock = vi.fn(async (input: Record<string, unknown>) => {
      if (input.action !== 'list') return success(String(input.action), first);
      if (input.offset === 0) return success('list', { items: [first, archived], page: { ...pageInfo, next_offset: 2 } });
      return success('list', { items: [saved], page: { ...pageInfo, offset: 2 } });
    });
    const { api, databaseMock, pageMock } = makeApi({
      databases: [
        database('database-old', saved.id, '2026-07-01T00:00:00.000Z'),
        database('database-new', saved.id, '2026-07-03T00:00:00.000Z'),
        database('database-archived', saved.id, '2026-07-04T00:00:00.000Z', '2026-07-05T00:00:00.000Z'),
      ],
      pages: [
        page('page-old', saved.id, '2026-07-01T00:00:00.000Z'),
        page('page-new', saved.id, '2026-07-03T00:00:00.000Z'),
        page('page-archived', saved.id, '2026-07-04T00:00:00.000Z', '2026-07-05T00:00:00.000Z'),
      ],
      workspace: workspaceMock,
    });

    render(<App api={api} />);

    await waitForWorkspace(saved.id);
    expect(workspaceMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: 'list', offset: 0 }), expect.anything());
    expect(workspaceMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: 'list', offset: 2 }), expect.anything());
    expect(pageMock).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: saved.id }), expect.anything());
    expect(databaseMock).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: saved.id }), expect.anything());
    await waitFor(() => expect(screen.getByTestId('content-pages').textContent)
      .toBe('page-archived,page-new,page-old'));
    expect(screen.getByTestId('content-databases').textContent).toBe('database-archived,database-new,database-old');
    expect(screen.getByTestId('sidebar').getAttribute('data-pages')).toBe('page-new,page-old');
    expect(screen.getByTestId('sidebar').getAttribute('data-databases')).toBe('database-new,database-old');
    expect(window.location.hash).toBe('#/home');
    expect(window.localStorage.getItem('horizonlayer.workspace')).toBe(saved.id);
  });

  it('renders startup progress, retries failures, and describes non-Error startup failures safely', async () => {
    const pending = deferred<DashboardStatus>();
    const { api, statusMock, workspaceMock } = makeApi({ status: () => pending.promise });
    render(<App api={api} />);
    expect(screen.getByRole('main', { name: 'Loading HorizonLayer' })).toBeTruthy();
    await act(async () => pending.reject(new Error('PostgreSQL unavailable')));
    expect(await screen.findByText('PostgreSQL unavailable')).toBeTruthy();

    statusMock.mockResolvedValueOnce(status);
    workspaceMock.mockResolvedValueOnce(success('list', { items: [workspace('workspace-1')], page: pageInfo }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitForWorkspace('workspace-1');

    cleanup();
    const nonError = makeApi({ status: async () => Promise.reject('bad startup') });
    render(<App api={nonError.api} />);
    expect(await screen.findByText('The local dashboard could not start.')).toBeTruthy();
  });

  it('ignores startup outcomes after unmounting', async () => {
    const pending = deferred<DashboardStatus>();
    const { api } = makeApi({ status: () => pending.promise });
    const view = render(<App api={api} />);
    view.unmount();
    await act(async () => pending.reject(new Error('late startup failure')));
    expect(screen.queryByText('late startup failure')).toBeNull();
  });

  it('manages workspace create, update, archive, restore, and selection lifecycles', async () => {
    const first = workspace('workspace-1', 'First');
    const second = workspace('workspace-2', 'Second');
    const archived = workspace('workspace-archived', 'Archived', '2026-07-04T00:00:00.000Z');
    let listings: Workspace[] = [first, second, archived];
    const workspaceMock = vi.fn(async (input: Record<string, unknown>) => {
      switch (input.action) {
        case 'list':
          return success('list', { items: listings, page: pageInfo });
        case 'create': {
          const created = workspace('workspace-created', String(input.name));
          listings = [...listings, created];
          return success('create', created);
        }
        case 'archive':
          listings = listings.map((item) => item.id === input.workspace_id ? { ...item, archived_at: '2026-07-06T00:00:00.000Z' } : item);
          return success('archive', first);
        case 'restore':
          listings = listings.map((item) => item.id === input.workspace_id ? { ...item, archived_at: null } : item);
          return success('restore', first);
        default:
          return success(String(input.action), first);
      }
    });
    const { api } = makeApi({ workspace: workspaceMock });
    render(<App api={api} />);
    await waitForWorkspace(first.id);

    fireEvent.click(screen.getByRole('button', { name: 'sidebar workspaces' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mock workspaces' });
    expect(within(dialog).getByTestId('dialog-current').textContent).toBe(first.id);
    fireEvent.click(within(dialog).getByRole('button', { name: 'dialog update' }));
    await waitFor(() => expect(workspaceMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'update', description: null, icon: null, name: 'Renamed', workspace_id: first.id,
    })));
    expect(await screen.findByText('Workspace details saved.')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'dialog create' }));
    await waitFor(() => expect(workspaceMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'create', description: 'New context', icon: '✦', name: 'Created',
    })));
    expect(await screen.findByText('Created “Created”.')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'dialog select second' }));
    await waitForWorkspace(second.id);
    expect(screen.queryByRole('dialog', { name: 'Mock workspaces' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'sidebar workspaces' }));
    const selectedDialog = await screen.findByRole('dialog', { name: 'Mock workspaces' });
    fireEvent.click(within(selectedDialog).getByRole('button', { name: 'dialog archive first' }));
    await waitFor(() => expect(workspaceMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'archive', workspace_id: first.id,
    })));
    await waitForWorkspace(second.id);
    fireEvent.click(within(selectedDialog).getByRole('button', { name: 'dialog archive' }));
    await waitFor(() => expect(workspaceMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'archive', workspace_id: second.id,
    })));
    await waitForWorkspace('workspace-created');
    expect(screen.getByText('Archived “Second”.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'sidebar workspaces' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Mock workspaces' }))
      .getByRole('button', { name: 'dialog close' }));
    expect(screen.queryByRole('dialog', { name: 'Mock workspaces' })).toBeNull();

    expect(screen.queryByTestId('onboarding')).toBeNull();
  });

  it('uses onboarding actions when only archived workspaces exist', async () => {
    const archived = workspace('workspace-archived', 'Archived', '2026-07-04T00:00:00.000Z');
    let listings: Workspace[] = [archived];
    const workspaceMock = vi.fn(async (input: Record<string, unknown>) => {
      if (input.action === 'list') return success('list', { items: listings, page: pageInfo });
      if (input.action === 'create') {
        const created = workspace('workspace-onboarded', String(input.name));
        listings = [...listings, created];
        return success('create', created);
      }
      return success(String(input.action), archived);
    });
    const { api } = makeApi({ workspace: workspaceMock });
    render(<App api={api} />);

    const onboarding = await screen.findByTestId('onboarding');
    expect(within(onboarding).getByTestId('archived-count').textContent).toBe('1');
    fireEvent.click(within(onboarding).getByRole('button', { name: 'onboarding workspaces' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mock workspaces' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'dialog close' }));
    expect(screen.queryByRole('dialog', { name: 'Mock workspaces' })).toBeNull();

    fireEvent.click(within(onboarding).getByRole('button', { name: 'onboarding workspaces' }));
    const reopenedDialog = await screen.findByRole('dialog', { name: 'Mock workspaces' });
    fireEvent.click(within(reopenedDialog).getByRole('button', { name: 'dialog select second' }));
    fireEvent.click(within(reopenedDialog)
      .getByRole('button', { name: 'dialog restore' }));
    await waitFor(() => expect(workspaceMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'restore', workspace_id: 'workspace-archived',
    })));
    expect(screen.getByText('Restored “Archived”.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(screen.queryByText('Restored “Archived”.')).toBeNull();
  });

  it('creates onboarding workspaces without sending empty optional fields', async () => {
    const archived = workspace('workspace-archived', 'Archived', '2026-07-04T00:00:00.000Z');
    let listings: Workspace[] = [archived];
    const workspaceMock = vi.fn(async (input: Record<string, unknown>) => {
      if (input.action === 'list') return success('list', { items: listings, page: pageInfo });
      if (input.action === 'create') {
        const created = workspace('workspace-onboarded', String(input.name));
        listings = [...listings, created];
        return success('create', created);
      }
      return success(String(input.action), archived);
    });
    const { api } = makeApi({ workspace: workspaceMock });
    render(<App api={api} />);

    fireEvent.click(await screen.findByRole('button', { name: 'onboarding create' }));
    await waitFor(() => expect(workspaceMock).toHaveBeenCalledWith({ action: 'create', name: 'Onboarded' }));
    await waitForWorkspace('workspace-onboarded');
  });

  it('creates pages and databases, prevents concurrent creation, and shows actionable failures', async () => {
    const current = workspace('workspace-1');
    const createPage = deferred<ReturnType<typeof success>>();
    const { api, databaseMock, pageMock } = makeApi({
      workspace: async (input) => input.action === 'list'
        ? success('list', { items: [current], page: pageInfo })
        : success(String(input.action), current),
    });
    pageMock.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.action === 'list') return success('list', { items: [], page: pageInfo });
      return createPage.promise;
    });
    render(<App api={api} />);
    await waitForWorkspace(current.id);

    fireEvent.click(screen.getByRole('button', { name: 'content create page' }));
    await waitFor(() => expect(screen.getByTestId('sidebar').getAttribute('data-creating')).toBe('page'));
    fireEvent.click(screen.getByRole('button', { name: 'content create database' }));
    expect(databaseMock.mock.calls.filter(([input]) => (input as Record<string, unknown>).action === 'create')).toHaveLength(0);
    await act(async () => createPage.resolve(success('create', page('created-page', current.id))));
    await waitFor(() => expect(window.location.hash).toBe('#/page/created-page'));
    expect(pageMock).toHaveBeenCalledWith({
      action: 'create', blocks: [{ block_type: 'text', content: '' }], title: 'Untitled', workspace_id: current.id,
    });

    fireEvent.click(screen.getByRole('button', { name: 'content create database' }));
    await waitFor(() => expect(window.location.hash).toBe('#/database/created-database'));
    expect(databaseMock).toHaveBeenCalledWith({ action: 'create', name: 'Untitled database', workspace_id: current.id });

    pageMock.mockRejectedValueOnce(new Error('page write failed'));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar create page' }));
    expect((await screen.findByRole('alert')).textContent).toContain('page write failed');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(screen.queryByText('page write failed')).toBeNull();

    databaseMock.mockRejectedValueOnce('database write failed');
    fireEvent.click(screen.getByRole('button', { name: 'sidebar create database' }));
    expect((await screen.findByRole('alert')).textContent).toContain('A new database could not be created.');

    databaseMock.mockRejectedValueOnce(new Error('database object failure'));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar create database' }));
    expect(await screen.findByText('database object failure')).toBeTruthy();
  });

  it('retries failed workspace indexes, ignores stale index responses, and controls dialogs and navigation', async () => {
    const first = workspace('workspace-1', 'First');
    const second = workspace('workspace-2', 'Second');
    const firstPages = deferred<ReturnType<typeof success>>();
    const { api, databaseMock, pageMock } = makeApi({
      workspace: async (input) => input.action === 'list'
        ? success('list', { items: [first, second], page: pageInfo })
        : success(String(input.action), first),
    });
    pageMock.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.action === 'list' && input.workspace_id === first.id) return firstPages.promise;
      return success('list', { items: [page('second-page', second.id)], page: pageInfo });
    });
    databaseMock.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.action === 'list' && input.workspace_id === first.id) throw new Error('index unavailable');
      return success('list', { items: [database('second-database', second.id)], page: pageInfo });
    });
    render(<App api={api} />);
    await waitForWorkspace(first.id);
    expect((await screen.findByRole('alert')).textContent).toContain('index unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(pageMock.mock.calls.filter(([input]) => (input as Record<string, unknown>).workspace_id === first.id).length)
      .toBeGreaterThan(1));

    fireEvent.click(screen.getByRole('button', { name: 'sidebar workspaces' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Mock workspaces' }))
      .getByRole('button', { name: 'dialog select second' }));
    await waitForWorkspace(second.id);
    await act(async () => firstPages.resolve(success('list', { items: [page('stale-page', first.id)], page: pageInfo })));
    expect(screen.getByTestId('content-pages').textContent).toBe('second-page');
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByTestId('sidebar').getAttribute('data-drawer')).toBe('true');
    expect(screen.getByText('Skip to content').getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'sidebar close drawer' }));
    await waitFor(() => expect(screen.getByTestId('sidebar').getAttribute('data-drawer')).toBe('false'));
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'content archive route' }));
    await waitFor(() => expect(window.location.hash).toBe('#/archive'));
    await waitFor(() => expect(screen.getByTestId('sidebar').getAttribute('data-drawer')).toBe('false'));
    expect(screen.getAllByText('Archive').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'content missing page route' }));
    await waitFor(() => expect(screen.getAllByText('Page').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'content missing database route' }));
    await waitFor(() => expect(screen.getAllByText('Database').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'sidebar status' }));
    expect(await screen.findByRole('dialog', { name: 'Mock status' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'status close' }));
    expect(screen.queryByRole('dialog', { name: 'Mock status' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'sidebar search' }));
    expect(await screen.findByRole('dialog', { name: 'Mock search' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'search archive route' }));
    await waitFor(() => expect(window.location.hash).toBe('#/archive'));
    fireEvent.click(screen.getByRole('button', { name: 'search close' }));
    expect(screen.queryByRole('dialog', { name: 'Mock search' })).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Search knowledge' })[0]);
    expect(await screen.findByRole('dialog', { name: 'Mock search' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'search close' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Search knowledge' })[1]);
    expect(await screen.findByRole('dialog', { name: 'Mock search' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'search close' }));
    fireEvent.click(screen.getByRole('button', { name: 'content search' }));
    expect(await screen.findByRole('dialog', { name: 'Mock search' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'search close' }));
  });

  it('opens search from shortcuts only when a workspace is present and no dialog is active', async () => {
    const { api } = makeApi();
    render(<App api={api} />);
    await waitForWorkspace('workspace-1');

    fireEvent.keyDown(window, { ctrlKey: true, key: 'k' });
    expect(await screen.findByRole('dialog', { name: 'Mock search' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'search close' }));
    fireEvent.keyDown(window, { key: 'x' });

    fireEvent.click(screen.getByRole('button', { name: 'sidebar workspaces' }));
    expect(await screen.findByRole('dialog', { name: 'Mock workspaces' })).toBeTruthy();
    fireEvent.keyDown(window, { metaKey: true, key: 'K' });
    expect(screen.queryByRole('dialog', { name: 'Mock search' })).toBeNull();
  });

  it('focuses main content from the skip link and expires toast timers', async () => {
    const current = workspace('workspace-1');
    const { api, pageMock } = makeApi({
      workspace: async (input) => input.action === 'list'
        ? success('list', { items: [current], page: pageInfo })
        : success(String(input.action), current),
    });
    pageMock.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.action === 'list') return success('list', { items: [], page: pageInfo });
      throw 'page failed';
    });
    render(<App api={api} />);
    await waitForWorkspace(current.id);
    const skip = screen.getByText('Skip to content');
    fireEvent.click(skip);
    const main = screen.getByTestId('workspace-content');
    expect(document.activeElement).toBe(main);
    expect(main.getAttribute('tabindex')).toBe('-1');
    fireEvent.blur(main);
    expect(main.hasAttribute('tabindex')).toBe(false);
    main.setAttribute('tabindex', '0');
    fireEvent.click(skip);
    expect(main.getAttribute('tabindex')).toBe('0');
    main.remove();
    fireEvent.click(skip);

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'sidebar create page' }));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain('A new page could not be created.');
    await act(async () => vi.advanceTimersByTimeAsync(4_600));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
