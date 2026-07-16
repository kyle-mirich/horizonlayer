import { getPool, type PoolClient } from '../client.js';
import { isLinkItemType, type LinkItemType } from '../../domain.js';
import {
  lockActiveLinkedItemsForWrite,
  requireActiveWorkspace,
  requireLink,
} from './scopeGuards.js';

const LINK_COLUMNS = `
  id,
  workspace_id,
  from_type,
  from_id,
  to_type,
  to_id,
  link_type,
  revision,
  archived_at,
  created_at,
  updated_at
`;

export interface Link {
  id: string;
  workspace_id: string;
  from_type: LinkItemType;
  from_id: string;
  to_type: LinkItemType;
  to_id: string;
  link_type: string;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function pagination(name: 'limit' | 'offset', value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  const max = name === 'limit' ? 101 : 1_000_000;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
  return resolved;
}

function itemType(value: string): LinkItemType {
  if (!isLinkItemType(value)) throw new Error(`Unsupported linked item type: ${value}`);
  return value;
}

function assertRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error('revision must be a positive integer');
  }
}

interface LinkEndpoint {
  id: string;
  type: LinkItemType;
}

async function lockLinkEndpoints(
  client: PoolClient,
  workspaceId: string,
  endpoints: LinkEndpoint[]
): Promise<void> {
  const scopes = await lockActiveLinkedItemsForWrite(endpoints, client);
  for (const scope of scopes) {
    if (scope.workspace_id !== workspaceId) {
      throw new Error(
        `${scope.type} ${scope.id} belongs to workspace ${scope.workspace_id}, not ${workspaceId}`
      );
    }
  }
}

export async function createLink(params: {
  workspace_id: string;
  from_type: LinkItemType | string;
  from_id: string;
  to_type: LinkItemType | string;
  to_id: string;
  link_type?: string;
}): Promise<Link> {
  const fromType = itemType(params.from_type);
  const toType = itemType(params.to_type);
  const linkType = (params.link_type ?? 'related').trim();
  if (!linkType) throw new Error('link_type cannot be empty');

  await requireActiveWorkspace(params.workspace_id);
  const client = await getPool().connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await lockLinkEndpoints(client, params.workspace_id, [
      { id: params.from_id, type: fromType },
      { id: params.to_id, type: toType },
    ]);
    const { rows } = await client.query<Link>(
      `INSERT INTO links
         (workspace_id, from_type, from_id, to_type, to_id, link_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${LINK_COLUMNS}`,
      [params.workspace_id, fromType, params.from_id, toType, params.to_id, linkType]
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return rows[0];
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listLinks(params: {
  workspace_id: string;
  item_type?: LinkItemType | string;
  item_id?: string;
  link_type?: string;
  direction?: 'from' | 'to' | 'both';
  include_archived?: boolean;
  limit?: number;
  offset?: number;
}): Promise<Link[]> {
  if ((params.item_type === undefined) !== (params.item_id === undefined)) {
    throw new Error('item_type and item_id must be supplied together');
  }
  if (params.direction !== undefined && !['from', 'to', 'both'].includes(params.direction)) {
    throw new Error('direction must be from, to, or both');
  }
  if (params.direction !== undefined && params.item_type === undefined) {
    throw new Error('direction requires item_type and item_id');
  }
  const type = params.item_type === undefined ? undefined : itemType(params.item_type);
  const linkType = params.link_type?.trim();
  if (params.link_type !== undefined && !linkType) throw new Error('link_type cannot be empty');
  const limit = pagination('limit', params.limit, 50);
  const offset = pagination('offset', params.offset, 0);

  await requireActiveWorkspace(params.workspace_id);
  const conditions = ['workspace_id = $1', '($2::boolean OR archived_at IS NULL)'];
  const values: unknown[] = [params.workspace_id, params.include_archived ?? false];

  if (linkType) {
    values.push(linkType);
    conditions.push(`link_type = $${values.length}`);
  }
  if (type && params.item_id) {
    const direction = params.direction ?? 'both';
    values.push(type, params.item_id);
    const typeParameter = `$${values.length - 1}`;
    const idParameter = `$${values.length}`;
    if (direction === 'from') {
      conditions.push(`from_type = ${typeParameter} AND from_id = ${idParameter}`);
    } else if (direction === 'to') {
      conditions.push(`to_type = ${typeParameter} AND to_id = ${idParameter}`);
    } else {
      conditions.push(
        `((from_type = ${typeParameter} AND from_id = ${idParameter})
          OR (to_type = ${typeParameter} AND to_id = ${idParameter}))`
      );
    }
  }

  values.push(limit, offset);
  const { rows } = await getPool().query<Link>(
    `SELECT ${LINK_COLUMNS}
     FROM links
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return rows;
}

async function archiveStoredLink(id: string, revision: number): Promise<Link | null> {
  assertRevision(revision);
  const scope = await requireLink(id);
  const { rows } = await getPool().query<Link>(
    `UPDATE links
     SET archived_at = NOW(),
         revision = revision + 1,
         updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2
       AND revision = $3
       AND archived_at IS NULL
     RETURNING ${LINK_COLUMNS}`,
    [id, scope.workspace_id, revision]
  );
  if (!rows[0]) {
    const { rows: currentRows } = await getPool().query<{ revision: number }>(
      'SELECT revision FROM links WHERE id = $1',
      [id]
    );
    if (currentRows[0] && currentRows[0].revision !== revision) {
      throw new Error(`Conflict: link ${id} is at revision ${currentRows[0].revision}, not ${revision}`);
    }
  }
  return rows[0] ?? null;
}

export function archiveLink(
  id: string,
  revision: number
): Promise<Link | null> {
  return archiveStoredLink(id, revision);
}

export function restoreLink(
  id: string,
  revision: number
): Promise<Link | null> {
  assertRevision(revision);
  return restoreArchivedLink(id, revision);
}

async function restoreArchivedLink(id: string, revision: number): Promise<Link | null> {
  const client = await getPool().connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const { rows: lockedRows } = await client.query<Link>(
      `SELECT ${LINK_COLUMNS}
       FROM links
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );
    const link = lockedRows[0];
    if (!link) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return null;
    }
    if (link.revision !== revision) {
      throw new Error(`Conflict: link ${id} is at revision ${link.revision}, not ${revision}`);
    }
    if (!link.archived_at) {
      await client.query('COMMIT');
      transactionOpen = false;
      return null;
    }

    await lockLinkEndpoints(client, link.workspace_id, [
      { id: link.from_id, type: link.from_type },
      { id: link.to_id, type: link.to_type },
    ]);
    const { rows } = await client.query<Link>(
      `UPDATE links
       SET archived_at = NULL,
           revision = revision + 1,
           updated_at = NOW()
       WHERE id = $1 AND revision = $2 AND archived_at IS NOT NULL
       RETURNING ${LINK_COLUMNS}`,
      [id, revision]
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return rows[0] ?? null;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
