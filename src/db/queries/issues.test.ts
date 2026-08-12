import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../client.js', () => ({ getPool: () => ({ query: mocks.query }) }));

import {
  addIssueComment,
  archiveIssue,
  archiveIssueDependency,
  claimIssue,
  createIssue,
  createIssueDependency,
  getIssue,
  listIssueComments,
  queryIssues,
  releaseIssue,
  restoreIssue,
  updateIssue,
} from './issues.js';

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'issue-1', project_id: 'project-1', issue_number: 1, issue_key: 'HL-1',
    parent_issue_id: null, title: 'Issue', description: null, status: 'open', priority: null,
    assignee: null, created_by: 'agent', tags: [], revision: 1, archived_at: null,
    created_at: '2026-01-01', updated_at: '2026-01-01', ...overrides,
  };
}

describe('Issue persistence', () => {
  beforeEach(() => mocks.query.mockReset());

  it('creates minimal and fully populated Issues with normalized text', async () => {
    mocks.query.mockResolvedValue({ rows: [issue()] });
    await expect(createIssue({ created_by: ' agent ', project_id: 'project-1', title: ' Work ' }))
      .resolves.toMatchObject({ id: 'issue-1' });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      'project-1', 'Work', 'agent', null, 'open', null, null, [], null,
    ]);

    await createIssue({
      assignee: ' owner ', created_by: 'agent', description: ' details ',
      parent_issue_id: 'parent', priority: 'high', project_id: 'project-1',
      status: 'blocked', tags: ['backend'], title: 'Full',
    });
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([
      'project-1', 'Full', 'agent', 'details', 'blocked', 'high', 'owner', ['backend'], 'parent',
    ]);
    await expect(createIssue({ created_by: 'agent', project_id: 'p', title: ' ' }))
      .rejects.toThrow('title');
    await expect(createIssue({ created_by: ' ', project_id: 'p', title: 'x' }))
      .rejects.toThrow('creator');
    await expect(createIssue({ assignee: ' ', created_by: 'a', project_id: 'p', title: 'x' }))
      .rejects.toThrow('assignee');
  });

  it('gets Issues by ID or key and returns null for misses', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [issue()] }).mockResolvedValueOnce({ rows: [] });
    await expect(getIssue('HL-1')).resolves.toMatchObject({ id: 'issue-1' });
    await expect(getIssue('missing', true)).resolves.toBeNull();
  });

  it('builds default and fully filtered ready-work queries', async () => {
    mocks.query.mockResolvedValue({ rows: [issue()] });
    await expect(queryIssues()).resolves.toHaveLength(1);
    await expect(queryIssues({
      assignee: null,
      include_archived: true,
      limit: 10,
      offset: 2,
      parent_issue_id: null,
      project_id: 'project-1',
      ready: true,
      status: ['open'],
      tags: ['backend'],
      text: ' migration ',
    })).resolves.toHaveLength(1);
    const [sql, values] = mocks.query.mock.calls[1] ?? [];
    expect(String(sql)).toContain('candidate.assignee IS NULL');
    expect(String(sql)).toContain('plainto_tsquery');
    expect(String(sql)).toContain('issue_dependencies');
    expect(values).toEqual([
      true, 'project-1', ['open'], null, ['backend'], null, 'migration', 10, 2,
    ]);
    await expect(queryIssues({ limit: 102 })).rejects.toThrow('between');
    await expect(queryIssues({ offset: -1 })).rejects.toThrow('between');
  });

  it('updates every mutable field and validates empty or stale writes', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [issue({ revision: 2 })] });
    await expect(updateIssue('issue-1', {
      assignee: ' owner ', description: null, parent_issue_id: null, priority: null,
      revision: 1, status: 'done', tags: ['done'], title: ' Complete ',
    })).resolves.toMatchObject({ revision: 2 });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      'Complete', null, 'done', null, 'owner', ['done'], null, 'issue-1', 1,
    ]);

    await expect(updateIssue('issue-1', { revision: 1 })).rejects.toThrow('At least');
    await expect(updateIssue('issue-1', { revision: 1, title: ' ' })).rejects.toThrow('title');
    await expect(updateIssue('issue-1', { assignee: ' ', revision: 1 })).rejects.toThrow('assignee');

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ assignee: null, revision: 5 }],
    });
    await expect(updateIssue('issue-1', { description: 'x', revision: 1 }))
      .rejects.toThrow('revision 5');
  });

  it('claims only ready unassigned Issues and explains every rejected claim', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [issue({ assignee: 'agent-a', revision: 2 })] });
    await expect(claimIssue('issue-1', ' agent-a ', 1)).resolves.toMatchObject({ revision: 2 });
    await expect(claimIssue('issue-1', ' ', 1)).rejects.toThrow('assignee');

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(claimIssue('missing', 'agent', 1)).rejects.toThrow('not found');

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [issue({ revision: 3 })],
    });
    await expect(claimIssue('issue-1', 'agent', 1)).rejects.toThrow('revision 3');

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [issue({ assignee: 'agent-a' })],
    });
    await expect(claimIssue('issue-1', 'agent-b', 1)).rejects.toThrow('already assigned');

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [issue()] });
    await expect(claimIssue('issue-1', 'agent', 1)).rejects.toThrow('not ready');
  });

  it('releases, archives, restores, and reports lifecycle conflicts', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [issue({ revision: 2 })] });
    await expect(releaseIssue('issue-1', 1)).resolves.toMatchObject({ revision: 2 });

    mocks.query.mockResolvedValueOnce({ rows: [issue({ archived_at: 'now', revision: 2 })] });
    await expect(archiveIssue('issue-1', 1)).resolves.toMatchObject({ archived_at: 'now' });

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ archived_at: 'now', revision: 1 }],
    });
    await expect(archiveIssue('issue-1', 1)).rejects.toThrow('already archived');

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ archived_at: 'now', revision: 4 }],
    });
    await expect(restoreIssue('issue-1', 1)).rejects.toThrow('revision 4');

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(restoreIssue('missing', 1)).resolves.toBeNull();
  });

  it('appends and lists comments and creates or archives dependencies', async () => {
    const comment = { id: 'comment-1', issue_id: 'issue-1', author: 'agent', body: 'note', created_at: 'now' };
    mocks.query.mockResolvedValueOnce({ rows: [comment] }).mockResolvedValueOnce({ rows: [comment] });
    await expect(addIssueComment({ author: ' agent ', body: ' note ', issue_id: 'issue-1' }))
      .resolves.toEqual(comment);
    await expect(listIssueComments('issue-1')).resolves.toEqual([comment]);
    await expect(addIssueComment({ author: ' ', body: 'note', issue_id: 'issue-1' }))
      .rejects.toThrow('author');
    await expect(addIssueComment({ author: 'agent', body: ' ', issue_id: 'issue-1' }))
      .rejects.toThrow('body');

    const dependency = {
      id: 'dependency-1', blocking_issue_id: 'a', blocked_issue_id: 'b', revision: 1,
      archived_at: null, created_at: 'now', updated_at: 'now',
    };
    mocks.query.mockResolvedValueOnce({ rows: [dependency] }).mockResolvedValueOnce({
      rows: [{ ...dependency, archived_at: 'now', revision: 2 }],
    });
    await expect(createIssueDependency('a', 'b')).resolves.toEqual(dependency);
    await expect(archiveIssueDependency('dependency-1', 1))
      .resolves.toMatchObject({ archived_at: 'now' });
  });
});
