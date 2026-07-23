import { useEffect, useLayoutEffect, useRef } from 'react';

import { Icon } from '../components/Icon';
import type { Database, Page, Workspace } from '../types';
import type { DashboardRoute } from './routing';
import { dashboardHash } from './routing';
import { workspaceMark } from './WorkspaceDialog';

interface SidebarProps {
  creating: 'database' | 'page' | null;
  databases: Database[];
  drawerOpen: boolean;
  loading: boolean;
  onCloseDrawer(): void;
  onCreateDatabase(): Promise<void>;
  onCreatePage(): Promise<void>;
  onOpenSearch(): void;
  onOpenStatus(): void;
  onOpenWorkspaces(): void;
  pages: Page[];
  route: DashboardRoute;
  workspace: Workspace;
}

function routeMatches(route: DashboardRoute, kind: 'database' | 'page', id: string): boolean {
  if (kind === 'page') return route.name === 'page' && route.pageId === id;
  return route.name === 'database' && route.databaseId === id;
}

function NavItem({
  active,
  children,
  href,
  icon,
  onNavigate,
}: {
  active?: boolean;
  children: React.ReactNode;
  href: string;
  icon: 'archive' | 'page';
  onNavigate(): void;
}) {
  return (
    <a
      aria-current={active ? 'page' : undefined}
      className={`sidebar-link${active ? ' sidebar-link--active' : ''}`}
      href={href}
      onClick={onNavigate}
    >
      <Icon name={icon} size={17} />
      <span>{children}</span>
    </a>
  );
}

export function Sidebar(props: SidebarProps) {
  const recentPages = props.pages.slice(0, 6);
  const recentDatabases = props.databases.slice(0, 6);
  const sidebarRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseDrawerRef = useRef(props.onCloseDrawer);

  useLayoutEffect(() => {
    onCloseDrawerRef.current = props.onCloseDrawer;
  }, [props.onCloseDrawer]);

  useEffect(() => {
    if (!props.drawerOpen) return;
    const priorFocus = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseDrawerRef.current();
      if (event.key !== 'Tab' || !sidebarRef.current) return;
      const focusable = [...sidebarRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('drawer-open');
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('drawer-open');
      priorFocus?.focus();
    };
  }, [props.drawerOpen]);

  return (
    <>
      <button
        aria-label="Close navigation"
        aria-hidden="true"
        className={`sidebar-scrim${props.drawerOpen ? ' sidebar-scrim--open' : ''}`}
        onClick={props.onCloseDrawer}
        tabIndex={-1}
        type="button"
      />
      <aside
        aria-label="Workspace navigation"
        aria-modal={props.drawerOpen ? true : undefined}
        className={`sidebar${props.drawerOpen ? ' sidebar--open' : ''}`}
        ref={sidebarRef}
        role={props.drawerOpen ? 'dialog' : undefined}
      >
        <div className="sidebar__top">
          <button
            className="workspace-switcher"
            onClick={() => {
              props.onCloseDrawer();
              props.onOpenWorkspaces();
            }}
            type="button"
          >
            <span className="workspace-mark" aria-hidden="true">{workspaceMark(props.workspace)}</span>
            <span className="workspace-switcher__copy">
              <strong>{props.workspace.name}</strong>
              <small>Workspace</small>
            </span>
            <Icon name="chevron-down" size={15} />
          </button>
          <button
            aria-label="Close navigation"
            className="icon-button sidebar__close"
            onClick={props.onCloseDrawer}
            ref={closeButtonRef}
            type="button"
          >
            <Icon name="close" />
          </button>
        </div>

        <button
          className="search-trigger"
          onClick={() => {
            props.onCloseDrawer();
            props.onOpenSearch();
          }}
          type="button"
        >
          <Icon name="search" size={17} />
          <span>Search knowledge</span>
          <kbd>⌘ K</kbd>
        </button>

        <nav className="sidebar__nav">
          <NavItem
            active={props.route.name === 'home'}
            href={dashboardHash({ name: 'home' })}
            icon="page"
            onNavigate={props.onCloseDrawer}
          >Home</NavItem>

          <section className="sidebar-group" aria-labelledby="sidebar-pages-heading">
            <header className="sidebar-group__header">
              <h2 id="sidebar-pages-heading">Pages</h2>
              <button
                aria-label="Create page"
                className="icon-button icon-button--small"
                disabled={props.creating !== null}
                onClick={() => {
                  props.onCloseDrawer();
                  void props.onCreatePage();
                }}
                type="button"
              ><Icon name="plus" size={15} /></button>
            </header>
            {props.loading && recentPages.length === 0 ? <SidebarSkeleton /> : null}
            {!props.loading && recentPages.length === 0 ? <p className="sidebar-empty">No pages yet</p> : null}
            {recentPages.map((page) => (
              <a
                aria-current={routeMatches(props.route, 'page', page.id) ? 'page' : undefined}
                className={`sidebar-entity${routeMatches(props.route, 'page', page.id) ? ' sidebar-entity--active' : ''}`}
                href={dashboardHash({ name: 'page', pageId: page.id })}
                key={page.id}
                onClick={props.onCloseDrawer}
              >
                <Icon name="page" size={15} /><span>{page.title}</span>
              </a>
            ))}
          </section>

          <section className="sidebar-group" aria-labelledby="sidebar-databases-heading">
            <header className="sidebar-group__header">
              <h2 id="sidebar-databases-heading">Databases</h2>
              <button
                aria-label="Create database"
                className="icon-button icon-button--small"
                disabled={props.creating !== null}
                onClick={() => {
                  props.onCloseDrawer();
                  void props.onCreateDatabase();
                }}
                type="button"
              ><Icon name="plus" size={15} /></button>
            </header>
            {props.loading && recentDatabases.length === 0 ? <SidebarSkeleton /> : null}
            {!props.loading && recentDatabases.length === 0 ? <p className="sidebar-empty">No databases yet</p> : null}
            {recentDatabases.map((database) => (
              <a
                aria-current={routeMatches(props.route, 'database', database.id) ? 'page' : undefined}
                className={`sidebar-entity${routeMatches(props.route, 'database', database.id) ? ' sidebar-entity--active' : ''}`}
                href={dashboardHash({ name: 'database', databaseId: database.id })}
                key={database.id}
                onClick={props.onCloseDrawer}
              >
                <Icon name="database" size={15} /><span>{database.name}</span>
              </a>
            ))}
          </section>
        </nav>

        <div className="sidebar__bottom">
          <NavItem
            active={props.route.name === 'archive'}
            href={dashboardHash({ name: 'archive' })}
            icon="archive"
            onNavigate={props.onCloseDrawer}
          >Archive</NavItem>
          <button
            className="local-status"
            onClick={() => {
              props.onCloseDrawer();
              props.onOpenStatus();
            }}
            type="button"
          >
            <span className="local-status__pulse" aria-hidden="true" />
            <span><strong>Local dashboard</strong><small>MCP available to agents</small></span>
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
      </aside>
    </>
  );
}

function SidebarSkeleton() {
  return (
    <div className="sidebar-skeleton" aria-hidden="true">
      <i /><i /><i />
    </div>
  );
}
