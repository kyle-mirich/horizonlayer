import { useState } from 'react';

import type { DashboardApiClient } from '../api';
import { Icon } from '../components/Icon';
import type { Database, Page } from '../types';
import type { DashboardRouteTarget } from './routing';

const PAGE_SIZE = 50;

interface ArchiveViewProps {
  api: DashboardApiClient;
  databases: Database[];
  databasesHasMore: boolean;
  loading: boolean;
  navigate(route: DashboardRouteTarget): void;
  onChanged(): Promise<void>;
  pages: Page[];
  pagesHasMore: boolean;
  showToast(message: string, options?: { tone?: 'default' | 'error' }): void;
  workspaceId: string;
}

interface Cursor {
  initialized: boolean;
  next: number | null;
}

function uniqueById<Entity extends { id: string }>(items: Entity[]): Entity[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

export function ArchiveView(props: ArchiveViewProps) {
  const [restoring, setRestoring] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [extraPages, setExtraPages] = useState<Page[]>([]);
  const [extraDatabases, setExtraDatabases] = useState<Database[]>([]);
  const [pageCursor, setPageCursor] = useState<Cursor>({ initialized: false, next: null });
  const [databaseCursor, setDatabaseCursor] = useState<Cursor>({ initialized: false, next: null });

  const archivedPages = uniqueById([...props.pages, ...extraPages])
    .filter((page) => page.archived_at !== null);
  const archivedDatabases = uniqueById([...props.databases, ...extraDatabases])
    .filter((database) => database.archived_at !== null);
  const nextPageOffset = pageCursor.initialized
    ? pageCursor.next
    : props.pagesHasMore ? PAGE_SIZE : null;
  const nextDatabaseOffset = databaseCursor.initialized
    ? databaseCursor.next
    : props.databasesHasMore ? PAGE_SIZE : null;
  const canLoadOlder = nextPageOffset !== null || nextDatabaseOffset !== null;

  async function loadOlder() {
    if (loadingOlder || !canLoadOlder) return;
    setLoadingOlder(true);
    setLoadError(null);
    try {
      const [pagesEnvelope, databasesEnvelope] = await Promise.all([
        nextPageOffset === null
          ? Promise.resolve(null)
          : props.api.page({
              action: 'list',
              include_archived: true,
              limit: PAGE_SIZE,
              offset: nextPageOffset,
              workspace_id: props.workspaceId,
            }),
        nextDatabaseOffset === null
          ? Promise.resolve(null)
          : props.api.database({
              action: 'list',
              include_archived: true,
              limit: PAGE_SIZE,
              offset: nextDatabaseOffset,
              workspace_id: props.workspaceId,
            }),
      ]);
      if (pagesEnvelope) {
        setExtraPages((current) => uniqueById([...current, ...pagesEnvelope.result.items]));
        setPageCursor({ initialized: true, next: pagesEnvelope.result.page.next_offset });
      } else {
        setPageCursor({ initialized: true, next: null });
      }
      if (databasesEnvelope) {
        setExtraDatabases((current) => uniqueById([...current, ...databasesEnvelope.result.items]));
        setDatabaseCursor({ initialized: true, next: databasesEnvelope.result.page.next_offset });
      } else {
        setDatabaseCursor({ initialized: true, next: null });
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Older archived items could not be loaded.');
    } finally {
      setLoadingOlder(false);
    }
  }

  async function restorePage(page: Page) {
    if (restoring) return;
    setRestoring(page.id);
    try {
      await props.api.page({ action: 'restore', page_id: page.id, revision: page.revision });
      setExtraPages((current) => current.filter((item) => item.id !== page.id));
      props.showToast(`Restored “${page.title}”.`);
      props.navigate({ name: 'page', pageId: page.id });
      void props.onChanged();
    } catch (error) {
      props.showToast(error instanceof Error ? error.message : 'The page could not be restored.', { tone: 'error' });
    } finally {
      setRestoring(null);
    }
  }

  async function restoreDatabase(database: Database) {
    if (restoring) return;
    setRestoring(database.id);
    try {
      await props.api.database({ action: 'restore', database_id: database.id, revision: database.revision });
      setExtraDatabases((current) => current.filter((item) => item.id !== database.id));
      props.showToast(`Restored “${database.name}”.`);
      props.navigate({ name: 'database', databaseId: database.id });
      void props.onChanged();
    } catch (error) {
      props.showToast(error instanceof Error ? error.message : 'The database could not be restored.', { tone: 'error' });
    } finally {
      setRestoring(null);
    }
  }

  return (
    <main className="workspace-canvas archive-view" id="main-content">
      <header className="plain-page-header">
        <span className="entity-glyph entity-glyph--archive"><Icon name="archive" /></span>
        <div><p className="eyebrow">Workspace</p><h1>Archive</h1><p>Restore anything you want back in circulation.</p></div>
      </header>

      {props.loading ? <div className="home-skeleton"><i /><i /><i /></div> : null}
      {!props.loading && archivedPages.length === 0 && archivedDatabases.length === 0 ? (
        <div className="archive-empty">
          <Icon name="archive" size={24} />
          <h2>{canLoadOlder ? 'No recent items are archived' : 'Nothing archived'}</h2>
          <p>{canLoadOlder ? 'Older items are loaded only when you ask.' : 'Archived pages and databases will wait here.'}</p>
          {canLoadOlder ? (
            <button className="button button--quiet button--small" disabled={loadingOlder} onClick={() => void loadOlder()} type="button">
              {loadingOlder ? 'Checking…' : 'Check older items'}
            </button>
          ) : null}
        </div>
      ) : null}

      {archivedPages.length > 0 ? (
        <section className="archive-group" aria-labelledby="archived-pages-heading">
          <h2 id="archived-pages-heading">Pages</h2>
          {archivedPages.map((page) => (
            <div className="archive-row" key={page.id}>
              <span className="entity-glyph entity-glyph--page"><Icon name="page" size={16} /></span>
              <span><strong>{page.title}</strong><small>Archived page</small></span>
              <button className="button button--quiet button--small" disabled={restoring !== null} onClick={() => void restorePage(page)} type="button">
                <Icon name="refresh" size={14} /> {restoring === page.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          ))}
        </section>
      ) : null}

      {archivedDatabases.length > 0 ? (
        <section className="archive-group" aria-labelledby="archived-databases-heading">
          <h2 id="archived-databases-heading">Databases</h2>
          {archivedDatabases.map((database) => (
            <div className="archive-row" key={database.id}>
              <span className="entity-glyph entity-glyph--database"><Icon name="database" size={16} /></span>
              <span><strong>{database.name}</strong><small>Archived database</small></span>
              <button className="button button--quiet button--small" disabled={restoring !== null} onClick={() => void restoreDatabase(database)} type="button">
                <Icon name="refresh" size={14} /> {restoring === database.id ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          ))}
        </section>
      ) : null}

      {(archivedPages.length > 0 || archivedDatabases.length > 0) && canLoadOlder ? (
        <div className="archive-load-more">
          <button className="button button--quiet" disabled={loadingOlder} onClick={() => void loadOlder()} type="button">
            {loadingOlder ? 'Loading older items…' : 'Load older items'}
          </button>
        </div>
      ) : null}
      {loadError ? <p className="form-error archive-load-error" role="alert">{loadError}</p> : null}
    </main>
  );
}
