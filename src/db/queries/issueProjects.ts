import { getPool } from '../client.js';
import { assertArchiveTransition } from './archiveState.js';

const PROJECT_COLUMNS = `
  id,
  project_key,
  name,
  description,
  next_issue_number,
  revision,
  archived_at,
  created_at,
  updated_at
`;

export interface IssueProject {
  id: string;
  project_key: string;
  name: string;
  description: string | null;
  next_issue_number: number;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function projectKey(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,19}$/u.test(normalized)) {
    throw new Error('Issue Project key must be 2-20 uppercase letters or digits and start with a letter');
  }
  return normalized;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new Error(`Expected an integer between 0 and ${maximum}`);
  }
  return resolved;
}

export async function createIssueProject(params: {
  project_key: string;
  name: string;
  description?: string;
}): Promise<IssueProject> {
  const name = params.name.trim();
  if (!name) throw new Error('Issue Project name cannot be empty');
  const { rows } = await getPool().query<IssueProject>(
    `INSERT INTO issue_projects (project_key, name, description)
     VALUES ($1, $2, $3)
     RETURNING ${PROJECT_COLUMNS}`,
    [projectKey(params.project_key), name, params.description?.trim() || null]
  );
  return rows[0];
}

export async function listIssueProjects(params: {
  include_archived?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<IssueProject[]> {
  const limit = boundedInteger(params.limit, 50, 101);
  const offset = boundedInteger(params.offset, 0, 1_000_000);
  const { rows } = await getPool().query<IssueProject>(
    `SELECT ${PROJECT_COLUMNS}
     FROM issue_projects
     WHERE ($1::boolean OR archived_at IS NULL)
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $2 OFFSET $3`,
    [params.include_archived ?? false, limit, offset]
  );
  return rows;
}

export async function getIssueProject(
  id: string,
  includeArchived = false
): Promise<IssueProject | null> {
  const { rows } = await getPool().query<IssueProject>(
    `SELECT ${PROJECT_COLUMNS}
     FROM issue_projects
     WHERE id = $1 AND ($2::boolean OR archived_at IS NULL)`,
    [id, includeArchived]
  );
  return rows[0] ?? null;
}

async function assertProjectRevision(id: string, revision: number): Promise<void> {
  const { rows } = await getPool().query<{ archived_at: string | null; revision: number }>(
    'SELECT revision, archived_at FROM issue_projects WHERE id = $1',
    [id]
  );
  if (rows[0] && rows[0].revision !== revision) {
    throw new Error(`Conflict: Issue Project ${id} is at revision ${rows[0].revision}, not ${revision}`);
  }
}

export async function updateIssueProject(id: string, params: {
  revision: number;
  name?: string;
  description?: string | null;
}): Promise<IssueProject | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (params.name !== undefined) {
    const name = params.name.trim();
    if (!name) throw new Error('Issue Project name cannot be empty');
    values.push(name);
    sets.push(`name = $${values.length}`);
  }
  if (params.description !== undefined) {
    values.push(params.description?.trim() || null);
    sets.push(`description = $${values.length}`);
  }
  if (sets.length === 0) throw new Error('At least one Issue Project field is required');
  values.push(id, params.revision);
  const { rows } = await getPool().query<IssueProject>(
    `UPDATE issue_projects SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length - 1} AND revision = $${values.length}
       AND archived_at IS NULL
     RETURNING ${PROJECT_COLUMNS}`,
    values
  );
  if (!rows[0]) await assertProjectRevision(id, params.revision);
  return rows[0] ?? null;
}

async function setProjectArchived(
  id: string,
  revision: number,
  archived: boolean
): Promise<IssueProject | null> {
  const { rows } = await getPool().query<IssueProject>(
    `UPDATE issue_projects
     SET archived_at = ${archived ? 'NOW()' : 'NULL'}, updated_at = NOW()
     WHERE id = $1 AND revision = $2
       AND archived_at IS ${archived ? 'NULL' : 'NOT NULL'}
     RETURNING ${PROJECT_COLUMNS}`,
    [id, revision]
  );
  if (!rows[0]) {
    const current = await getPool().query<{ archived_at: string | null; revision: number }>(
      'SELECT revision, archived_at FROM issue_projects WHERE id = $1',
      [id]
    );
    assertArchiveTransition('Issue Project', id, revision, archived, current.rows[0]);
  }
  return rows[0] ?? null;
}

export function archiveIssueProject(id: string, revision: number): Promise<IssueProject | null> {
  return setProjectArchived(id, revision, true);
}

export function restoreIssueProject(id: string, revision: number): Promise<IssueProject | null> {
  return setProjectArchived(id, revision, false);
}
