import { getPool } from '../client.js';
import type { AccessContext } from '../access.js';
import { assertLinkedItemAccess, assertLinkAccess } from './accessControl.js';

export interface Link {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  link_type: string;
  created_at: string;
}

function normalizeItemType(itemType: string): string {
  return itemType === 'database_row' ? 'row' : itemType;
}

function expandItemTypeAliases(itemType: string): string[] {
  if (itemType === 'row' || itemType === 'database_row') {
    // Backward compatibility for older stored values.
    return ['row', 'database_row'];
  }
  return [itemType];
}

export async function createLink(params: {
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  link_type?: string;
  access?: AccessContext;
}): Promise<Link> {
  const access = params.access ?? { kind: 'system' as const };
  await assertLinkedItemAccess(params.from_type, params.from_id, access, 'write');
  await assertLinkedItemAccess(params.to_type, params.to_id, access, 'write');
  const pool = getPool();
  const fromType = normalizeItemType(params.from_type);
  const toType = normalizeItemType(params.to_type);
  const { rows } = await pool.query<Link>(
    `INSERT INTO links (from_type, from_id, to_type, to_id, link_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      fromType,
      params.from_id,
      toType,
      params.to_id,
      params.link_type ?? 'related',
    ]
  );
  return rows[0];
}

export async function listLinks(params: {
  item_type: string;
  item_id: string;
  direction?: 'from' | 'to' | 'both';
  access?: AccessContext;
}): Promise<Link[]> {
  const access = params.access ?? { kind: 'system' as const };
  await assertLinkedItemAccess(params.item_type, params.item_id, access, 'read');
  const pool = getPool();
  const direction = params.direction ?? 'both';
  const itemTypes = expandItemTypeAliases(params.item_type);

  if (direction === 'from') {
    const { rows } = await pool.query<Link>(
      'SELECT * FROM links WHERE from_type = ANY($1) AND from_id = $2 ORDER BY created_at DESC',
      [itemTypes, params.item_id]
    );
    return filterLinksByAccess(rows, access);
  }

  if (direction === 'to') {
    const { rows } = await pool.query<Link>(
      'SELECT * FROM links WHERE to_type = ANY($1) AND to_id = $2 ORDER BY created_at DESC',
      [itemTypes, params.item_id]
    );
    return filterLinksByAccess(rows, access);
  }

  // both
  const { rows } = await pool.query<Link>(
    `SELECT * FROM links
     WHERE (from_type = ANY($1) AND from_id = $2)
        OR (to_type = ANY($1) AND to_id = $2)
     ORDER BY created_at DESC`,
    [itemTypes, params.item_id]
  );
  return filterLinksByAccess(rows, access);
}

export async function deleteLink(
  id: string,
  access: AccessContext = { kind: 'system' }
): Promise<boolean> {
  await assertLinkAccess(id, access, 'write');
  const pool = getPool();
  const { rowCount } = await pool.query('DELETE FROM links WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

async function filterLinksByAccess(links: Link[], access: AccessContext): Promise<Link[]> {
  const allowed: Link[] = [];
  for (const link of links) {
    try {
      await assertLinkedItemAccess(link.from_type, link.from_id, access, 'read');
      await assertLinkedItemAccess(link.to_type, link.to_id, access, 'read');
      allowed.push(link);
    } catch {
      continue;
    }
  }
  return allowed;
}
