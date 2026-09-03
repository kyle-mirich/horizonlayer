import { getPool } from '../client.js';
import { assertArchiveTransition } from './archiveState.js';

export const ISSUE_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'closed'] as const;
export type IssueStatus = typeof ISSUE_STATUSES[number];
export const ISSUE_PRIORITIES = ['lowest', 'low', 'medium', 'high', 'highest'] as const;
export type IssuePriority = typeof ISSUE_PRIORITIES[number];

const ISSUE_COLUMNS = `
  id,
  project_id,
  issue_number,
  issue_key,
  parent_issue_id,
  title,
  description,
  status,
  priority,
  assignee,
  created_by,
  tags,
  revision,
  archived_at,
  created_at,
  updated_at
`;

export interface Issue {
  id: string;
  project_id: string;
  issue_number: number;
  issue_key: string;
  parent_issue_id: string | null;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority | null;
  assignee: string | null;
  created_by: string;
  tags: string[];
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueComment {
  id: string;
  issue_id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface IssueDependency {
  id: string;
  blocking_issue_id: string;
  blocked_issue_id: string;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function nonempty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} cannot be empty`);
  return normalized;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new Error(`Expected an integer between 0 and ${maximum}`);
  }
  return resolved;
}

export async function createIssue(params: {
  project_id: string;
  title: string;
  created_by: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee?: string;
  tags?: string[];
  parent_issue_id?: string;
}): Promise<Issue> {
  const { rows } = await getPool().query<Issue>(
    `INSERT INTO issues
       (project_id, title, created_by, description, status, priority, assignee, tags, parent_issue_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${ISSUE_COLUMNS}`,
    [
      params.project_id,
      nonempty(params.title, 'Issue title'),
      nonempty(params.created_by, 'Issue creator'),
      params.description?.trim() || null,
      params.status ?? 'open',
      params.priority ?? null,
      params.assignee ? nonempty(params.assignee, 'Issue assignee') : null,
      params.tags ?? [],
      params.parent_issue_id ?? null,
    ]
  );
  return rows[0];
}

export async function getIssue(idOrKey: string, includeArchived = false): Promise<Issue | null> {
  const { rows } = await getPool().query<Issue>(
    `SELECT ${ISSUE_COLUMNS}
     FROM issues
     WHERE (id::text = $1 OR issue_key = UPPER($1))
       AND ($2::boolean OR archived_at IS NULL)`,
    [idOrKey, includeArchived]
  );
  return rows[0] ?? null;
}

export async function queryIssues(params: {
  project_id?: string;
  project_key?: string;
  priority?: IssuePriority[];
  status?: IssueStatus[];
  assignee?: string | null;
  tags?: string[];
  parent_issue_id?: string | null;
  ready?: boolean;
  text?: string;
  include_archived?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<Issue[]> {
  const conditions = ['($1::boolean OR candidate.archived_at IS NULL)'];
  const values: unknown[] = [params.include_archived ?? false];
  if (params.project_id) {
    values.push(params.project_id);
    conditions.push(`candidate.project_id = $${values.length}`);
  }
  if (params.project_key) {
    values.push(params.project_key.trim().toUpperCase());
    conditions.push(`EXISTS (
      SELECT 1 FROM issue_projects project
      WHERE project.id = candidate.project_id AND project.project_key = $${values.length}
    )`);
  }
  if (params.status?.length) {
    values.push(params.status);
    conditions.push(`candidate.status = ANY($${values.length}::text[])`);
  }
  if (params.priority?.length) {
    values.push(params.priority);
    conditions.push(`candidate.priority = ANY($${values.length}::text[])`);
  }
  if (params.assignee !== undefined) {
    values.push(params.assignee);
    conditions.push(`candidate.assignee IS NOT DISTINCT FROM $${values.length}::text`);
  }
  if (params.tags?.length) {
    values.push(params.tags);
    conditions.push(`candidate.tags && $${values.length}::text[]`);
  }
  if (params.parent_issue_id !== undefined) {
    values.push(params.parent_issue_id);
    conditions.push(`candidate.parent_issue_id IS NOT DISTINCT FROM $${values.length}::uuid`);
  }
  if (params.ready) {
    conditions.push("candidate.status = 'open'");
    conditions.push('candidate.assignee IS NULL');
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM issue_dependencies dependency
      JOIN issues blocker ON blocker.id = dependency.blocking_issue_id
      WHERE dependency.blocked_issue_id = candidate.id
        AND dependency.archived_at IS NULL
        AND blocker.archived_at IS NULL
        AND blocker.status NOT IN ('done', 'closed')
    )`);
  }
  if (params.text?.trim()) {
    values.push(params.text.trim());
    conditions.push(`to_tsvector('simple', candidate.title || ' ' || COALESCE(candidate.description, ''))
      @@ plainto_tsquery('simple', $${values.length})`);
  }
  values.push(
    boundedInteger(params.limit, 50, 101),
    boundedInteger(params.offset, 0, 1_000_000)
  );
  const { rows } = await getPool().query<Issue>(
    `SELECT ${ISSUE_COLUMNS.replaceAll('\n  ', '\n  candidate.')}
     FROM issues candidate
     WHERE ${conditions.join(' AND ')}
     ORDER BY candidate.updated_at DESC, candidate.created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return rows;
}

async function assertIssueRevision(id: string, revision: number): Promise<void> {
  const { rows } = await getPool().query<{ assignee: string | null; revision: number }>(
    'SELECT revision, assignee FROM issues WHERE id = $1',
    [id]
  );
  if (rows[0]?.revision !== undefined && rows[0].revision !== revision) {
    throw new Error(`Conflict: Issue ${id} is at revision ${rows[0].revision}, not ${revision}`);
  }
}

export async function updateIssue(id: string, params: {
  revision: number;
  title?: string;
  description?: string | null;
  status?: IssueStatus;
  priority?: IssuePriority | null;
  assignee?: string | null;
  tags?: string[];
  parent_issue_id?: string | null;
}): Promise<Issue | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (params.title !== undefined) add('title', nonempty(params.title, 'Issue title'));
  if (params.description !== undefined) add('description', params.description?.trim() || null);
  if (params.status !== undefined) add('status', params.status);
  if (params.priority !== undefined) add('priority', params.priority);
  if (params.assignee !== undefined) add(
    'assignee',
    params.assignee === null ? null : nonempty(params.assignee, 'Issue assignee')
  );
  if (params.tags !== undefined) add('tags', params.tags);
  if (params.parent_issue_id !== undefined) add('parent_issue_id', params.parent_issue_id);
  if (sets.length === 0) throw new Error('At least one Issue field is required');
  values.push(id, params.revision);
  const { rows } = await getPool().query<Issue>(
    `UPDATE issues SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length - 1} AND revision = $${values.length}
       AND archived_at IS NULL
     RETURNING ${ISSUE_COLUMNS}`,
    values
  );
  if (!rows[0]) await assertIssueRevision(id, params.revision);
  return rows[0] ?? null;
}

export async function claimIssue(id: string, assignee: string, revision: number): Promise<Issue> {
  const { rows } = await getPool().query<Issue>(
    `UPDATE issues candidate
     SET assignee = $2, status = 'in_progress', updated_at = NOW()
     WHERE candidate.id = $1 AND candidate.revision = $3
       AND candidate.archived_at IS NULL AND candidate.status = 'open'
       AND candidate.assignee IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM issue_dependencies dependency
         JOIN issues blocker ON blocker.id = dependency.blocking_issue_id
          WHERE dependency.blocked_issue_id = candidate.id
            AND dependency.archived_at IS NULL
            AND blocker.archived_at IS NULL
            AND blocker.status NOT IN ('done', 'closed')
        )
     RETURNING ${ISSUE_COLUMNS}`,
    [id, nonempty(assignee, 'Issue assignee'), revision]
  );
  if (rows[0]) return rows[0];
  const current = await getIssue(id, true);
  if (!current) throw new Error(`Issue ${id} not found`);
  if (current.revision !== revision) {
    throw new Error(`Conflict: Issue ${id} is at revision ${current.revision}, not ${revision}`);
  }
  if (current.assignee) throw new Error(`Issue ${current.issue_key} is already assigned to ${current.assignee}`);
  throw new Error(`Issue ${current.issue_key} is not ready to claim`);
}

export function releaseIssue(id: string, revision: number): Promise<Issue | null> {
  return updateIssue(id, { assignee: null, revision, status: 'open' });
}

async function setIssueArchived(id: string, revision: number, archived: boolean): Promise<Issue | null> {
  const { rows } = await getPool().query<Issue>(
    `UPDATE issues SET archived_at = ${archived ? 'NOW()' : 'NULL'}, updated_at = NOW()
     WHERE id = $1 AND revision = $2
       AND archived_at IS ${archived ? 'NULL' : 'NOT NULL'}
     RETURNING ${ISSUE_COLUMNS}`,
    [id, revision]
  );
  if (!rows[0]) {
    const current = await getPool().query<{ archived_at: string | null; revision: number }>(
      'SELECT revision, archived_at FROM issues WHERE id = $1',
      [id]
    );
    assertArchiveTransition('Issue', id, revision, archived, current.rows[0]);
  }
  return rows[0] ?? null;
}

export function archiveIssue(id: string, revision: number): Promise<Issue | null> {
  return setIssueArchived(id, revision, true);
}

export function restoreIssue(id: string, revision: number): Promise<Issue | null> {
  return setIssueArchived(id, revision, false);
}

export async function addIssueComment(params: {
  issue_id: string;
  author: string;
  body: string;
}): Promise<IssueComment> {
  const { rows } = await getPool().query<IssueComment>(
    `INSERT INTO issue_comments (issue_id, author, body)
     VALUES ($1, $2, $3)
     RETURNING id, issue_id, author, body, created_at`,
    [params.issue_id, nonempty(params.author, 'Comment author'), nonempty(params.body, 'Comment body')]
  );
  return rows[0];
}

export async function listIssueComments(issueId: string): Promise<IssueComment[]> {
  const { rows } = await getPool().query<IssueComment>(
    `SELECT id, issue_id, author, body, created_at
     FROM issue_comments WHERE issue_id = $1 ORDER BY created_at, id`,
    [issueId]
  );
  return rows;
}

export async function listIssueDependencies(issueId: string): Promise<IssueDependency[]> {
  const { rows } = await getPool().query<IssueDependency>(
    `SELECT id, blocking_issue_id, blocked_issue_id, revision, archived_at, created_at, updated_at
     FROM issue_dependencies
     WHERE (blocking_issue_id = $1 OR blocked_issue_id = $1) AND archived_at IS NULL
     ORDER BY created_at, id`,
    [issueId]
  );
  return rows;
}

export async function createIssueDependency(
  blockingIssueId: string,
  blockedIssueId: string
): Promise<IssueDependency> {
  const { rows } = await getPool().query<IssueDependency>(
    `INSERT INTO issue_dependencies (blocking_issue_id, blocked_issue_id)
     VALUES ($1, $2)
     RETURNING id, blocking_issue_id, blocked_issue_id, revision, archived_at, created_at, updated_at`,
    [blockingIssueId, blockedIssueId]
  );
  return rows[0];
}

export async function archiveIssueDependency(
  id: string,
  revision: number
): Promise<IssueDependency | null> {
  const { rows } = await getPool().query<IssueDependency>(
    `UPDATE issue_dependencies SET archived_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND revision = $2 AND archived_at IS NULL
     RETURNING id, blocking_issue_id, blocked_issue_id, revision, archived_at, created_at, updated_at`,
    [id, revision]
  );
  return rows[0] ?? null;
}
