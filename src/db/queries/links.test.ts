import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn();
const assertLinkedItemAccessMock = vi.fn();
const assertLinkAccessMock = vi.fn();

vi.mock('../client.js', () => ({
  getPool: () => ({
    query: poolQueryMock,
  }),
}));

vi.mock('./accessControl.js', () => ({
  assertLinkedItemAccess: assertLinkedItemAccessMock,
  assertLinkAccess: assertLinkAccessMock,
}));

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    from_type: 'row',
    from_id: 'row-1',
    to_type: 'page',
    to_id: 'page-1',
    link_type: 'related',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('link queries', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    assertLinkedItemAccessMock.mockReset();
    assertLinkAccessMock.mockReset();
    assertLinkedItemAccessMock.mockResolvedValue(undefined);
    assertLinkAccessMock.mockResolvedValue(undefined);
  });

  it('normalizes database_row aliases when creating links', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [link()] });

    const { createLink } = await import('./links.js');
    const created = await createLink({
      from_type: 'database_row',
      from_id: 'row-1',
      to_type: 'page',
      to_id: 'page-1',
    });

    expect(created.id).toBe('link-1');
    expect(assertLinkedItemAccessMock).toHaveBeenNthCalledWith(1, 'database_row', 'row-1', { kind: 'system' }, 'write');
    expect(poolQueryMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO links'), [
      'row',
      'row-1',
      'page',
      'page-1',
      'related',
    ]);
  });

  it.each([
    ['from', 'from_type = ANY($1) AND from_id = $2'],
    ['to', 'to_type = ANY($1) AND to_id = $2'],
    ['both', 'OR (to_type = ANY($1) AND to_id = $2)'],
  ] as const)('lists %s links and filters inaccessible endpoints', async (direction, sqlNeedle) => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        link({ id: 'allowed' }),
        link({ id: 'denied', to_id: 'hidden-page' }),
      ],
    });
    assertLinkedItemAccessMock.mockImplementation(async (_type: string, id: string) => {
      if (id === 'hidden-page') {
        throw new Error('hidden');
      }
    });

    const { listLinks } = await import('./links.js');
    const result = await listLinks({ item_type: 'database_row', item_id: 'row-1', direction });

    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain(sqlNeedle);
    expect(poolQueryMock.mock.calls[0]?.[1]).toEqual([['row', 'database_row'], 'row-1']);
    expect(result.map((item) => item.id)).toEqual(['allowed']);
  });

  it('deletes links only after link write access succeeds', async () => {
    poolQueryMock.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const { deleteLink } = await import('./links.js');
    await expect(deleteLink('link-1')).resolves.toBe(true);

    expect(assertLinkAccessMock).toHaveBeenCalledWith('link-1', { kind: 'system' }, 'write');
    expect(poolQueryMock).toHaveBeenCalledWith('DELETE FROM links WHERE id = $1', ['link-1']);
  });

  it('returns false when deleting a missing link', async () => {
    poolQueryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const { deleteLink } = await import('./links.js');
    await expect(deleteLink('missing')).resolves.toBe(false);
  });
});
