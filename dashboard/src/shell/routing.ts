export type DashboardRoute =
  | { name: 'archive' }
  | { name: 'database'; databaseId: string; rowId?: string }
  | { name: 'home' }
  | { name: 'not-found' }
  | { name: 'page'; pageId: string };

export type DashboardRouteTarget = Exclude<DashboardRoute, { name: 'not-found' }>;

function decoded(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseDashboardHash(hash: string): DashboardRoute {
  const raw = hash.replace(/^#/u, '') || '/home';
  const [pathname = '/home', query = ''] = raw.split('?');
  const parts = pathname.split('/').filter(Boolean);

  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'home')) {
    return { name: 'home' };
  }
  if (parts.length === 1 && parts[0] === 'archive') return { name: 'archive' };
  if (parts.length === 2 && parts[0] === 'page') {
    const pageId = decoded(parts[1]);
    return pageId ? { name: 'page', pageId } : { name: 'not-found' };
  }
  if (parts.length === 2 && parts[0] === 'database') {
    const databaseId = decoded(parts[1]);
    if (!databaseId) return { name: 'not-found' };
    const rowId = decoded(new URLSearchParams(query).get('row') ?? undefined);
    return rowId
      ? { name: 'database', databaseId, rowId }
      : { name: 'database', databaseId };
  }
  return { name: 'not-found' };
}

export function dashboardHash(route: DashboardRouteTarget): string {
  switch (route.name) {
    case 'home':
      return '#/home';
    case 'archive':
      return '#/archive';
    case 'page':
      return `#/page/${encodeURIComponent(route.pageId)}`;
    case 'database': {
      const base = `#/database/${encodeURIComponent(route.databaseId)}`;
      return route.rowId ? `${base}?row=${encodeURIComponent(route.rowId)}` : base;
    }
  }
}
