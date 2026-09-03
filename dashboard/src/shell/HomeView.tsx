import { Icon } from '../components/Icon';
import type { Database, Page, Workspace } from '../types';
import { dashboardHash } from './routing';
import { workspaceMark } from './WorkspaceDialog';

type RecentItem =
  | { id: string; kind: 'database'; name: string; updatedAt: string; description: string | null }
  | { id: string; kind: 'page'; name: string; updatedAt: string; description: string | null };

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently changed';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' as const }),
  }).format(date);
}

export function searchShortcutLabel(
  platform = typeof navigator === 'undefined' ? '' : (navigator.platform ?? ''),
  userAgent = typeof navigator === 'undefined' ? '' : (navigator.userAgent ?? ''),
): string {
  const target = `${platform} ${userAgent}`;
  return /mac/i.test(target) ? '⌘ K' : 'Ctrl K';
}

export function HomeView({
  creating,
  databases,
  databasesHasMore,
  loading,
  onCreateDatabase,
  onCreatePage,
  onOpenSearch,
  pages,
  pagesHasMore,
  workspace,
}: {
  creating: 'database' | 'page' | null;
  databases: Database[];
  databasesHasMore: boolean;
  loading: boolean;
  onCreateDatabase(): Promise<void>;
  onCreatePage(): Promise<void>;
  onOpenSearch(): void;
  pages: Page[];
  pagesHasMore: boolean;
  workspace: Workspace;
}) {
  const activePages = pages.filter((page) => page.archived_at === null);
  const activeDatabases = databases.filter((database) => database.archived_at === null);
  const recent: RecentItem[] = [
    ...activePages.map((page): RecentItem => ({
      description: page.tags.length > 0 ? page.tags.slice(0, 3).join(' · ') : null,
      id: page.id,
      kind: 'page',
      name: page.title,
      updatedAt: page.updated_at,
    })),
    ...activeDatabases.map((database): RecentItem => ({
      description: database.description,
      id: database.id,
      kind: 'database',
      name: database.name,
      updatedAt: database.updated_at,
    })),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 12);
  const recentPageCount = recent.filter((item) => item.kind === 'page').length;
  const recentDatabaseCount = recent.filter((item) => item.kind === 'database').length;

  return (
    <main className="workspace-canvas home-view" id="main-content">
      <header className="home-view__header">
        <span className="workspace-mark workspace-mark--page" aria-hidden="true">{workspaceMark(workspace)}</span>
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>{workspace.name}</h1>
          {workspace.description ? <p>{workspace.description}</p> : null}
        </div>
      </header>

      <div className="quick-actions" aria-label="Create knowledge">
        <button
          className="quick-action"
          disabled={creating !== null}
          onClick={() => void onCreatePage()}
          type="button"
        >
          <span className="quick-action__icon"><Icon name="page" /></span>
          <span><strong>{creating === 'page' ? 'Creating page…' : 'New page'}</strong><small>Write notes and agent context</small></span>
          <Icon name="chevron-right" size={16} />
        </button>
        <button
          className="quick-action"
          disabled={creating !== null}
          onClick={() => void onCreateDatabase()}
          type="button"
        >
          <span className="quick-action__icon"><Icon name="database" /></span>
          <span><strong>{creating === 'database' ? 'Creating database…' : 'New database'}</strong><small>Keep typed records together</small></span>
          <Icon name="chevron-right" size={16} />
        </button>
        <button className="quick-action" onClick={onOpenSearch} type="button">
          <span className="quick-action__icon"><Icon name="search" /></span>
          <span><strong>Search</strong><small>Find records or retrieve passages</small></span>
          <kbd>{searchShortcutLabel()}</kbd>
        </button>
      </div>

      <section className="recent-section" aria-labelledby="recent-heading">
        <header className="section-heading">
          <div>
            <p className="eyebrow">Workspace index</p>
            <h2 id="recent-heading">Recently changed</h2>
          </div>
          {!loading ? (
            <span>
              Showing {recentPageCount} pages · {recentDatabaseCount} databases
              {pagesHasMore || databasesHasMore ? ' · search finds older items' : ''}
            </span>
          ) : null}
        </header>

        {loading && recent.length === 0 ? <HomeSkeleton /> : null}
        {!loading && recent.length === 0 ? (
          <div className="empty-invitation">
            <div className="empty-invitation__rings" aria-hidden="true"><i /><i /><i /></div>
            <h3>This workspace is ready.</h3>
            <p>Create a page for open-ended context or a database for typed records.</p>
            <button className="button button--primary" onClick={() => void onCreatePage()} type="button">
              <Icon name="plus" size={16} /> Create the first page
            </button>
          </div>
        ) : null}
        {recent.length > 0 ? (
          <div className="recent-list">
            {recent.map((item) => (
              <a
                className="recent-row"
                href={item.kind === 'page'
                  ? dashboardHash({ name: 'page', pageId: item.id })
                  : dashboardHash({ name: 'database', databaseId: item.id })}
                key={`${item.kind}-${item.id}`}
              >
                <span className={`entity-glyph entity-glyph--${item.kind}`}>
                  <Icon name={item.kind} size={17} />
                </span>
                <span className="recent-row__copy">
                  <strong>{item.name}</strong>
                  <small>{item.description || (item.kind === 'page' ? 'Page' : 'Database')}</small>
                </span>
                <time dateTime={item.updatedAt}>{shortDate(item.updatedAt)}</time>
                <Icon name="chevron-right" size={15} />
              </a>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function HomeSkeleton() {
  return (
    <div className="home-skeleton" aria-label="Loading workspace">
      {[0, 1, 2, 3].map((item) => <i key={item} />)}
    </div>
  );
}
