import { describe, expect, it } from 'vitest';

import { dashboardHash, parseDashboardHash } from './routing';

describe('dashboard hash routing', () => {
  it('defaults to home and rejects unknown paths', () => {
    expect(parseDashboardHash('')).toEqual({ name: 'home' });
    expect(parseDashboardHash('#/')).toEqual({ name: 'home' });
    expect(parseDashboardHash('#/anything/else')).toEqual({ name: 'not-found' });
  });

  it('round-trips entity routes and an optional selected row', () => {
    const page = { name: 'page' as const, pageId: 'page/one' };
    const database = { name: 'database' as const, databaseId: 'database one', rowId: 'row/two' };

    expect(parseDashboardHash(dashboardHash(page))).toEqual(page);
    expect(parseDashboardHash(dashboardHash(database))).toEqual(database);
  });

  it('treats malformed URI components as not found', () => {
    expect(parseDashboardHash('#/page/%E0%A4%A')).toEqual({ name: 'not-found' });
  });

  it('covers archive, incomplete, database-only, and malformed row variants', () => {
    expect(parseDashboardHash('#/archive')).toEqual({ name: 'archive' });
    expect(parseDashboardHash('#/page/')).toEqual({ name: 'not-found' });
    expect(parseDashboardHash('#/database/')).toEqual({ name: 'not-found' });
    expect(parseDashboardHash('#/database/database-one')).toEqual({ name: 'database', databaseId: 'database-one' });
    expect(parseDashboardHash('#/database/database-one?row=%E0%A4%A')).toEqual({ name: 'database', databaseId: 'database-one' });
    expect(dashboardHash({ name: 'home' })).toBe('#/home');
    expect(dashboardHash({ name: 'archive' })).toBe('#/archive');
    expect(dashboardHash({ name: 'database', databaseId: 'database one' })).toBe('#/database/database%20one');
  });
});
