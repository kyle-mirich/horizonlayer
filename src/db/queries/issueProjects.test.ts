import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../client.js', () => ({ getPool: () => ({ query: mocks.query }) }));

import {
  archiveIssueProject,
  createIssueProject,
  getIssueProject,
  listIssueProjects,
  restoreIssueProject,
  updateIssueProject,
} from './issueProjects.js';

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1', project_key: 'HL', name: 'HorizonLayer', description: null,
    next_issue_number: 1, revision: 1, archived_at: null,
    created_at: '2026-01-01', updated_at: '2026-01-01', ...overrides,
  };
}

describe('Issue Project persistence', () => {
  beforeEach(() => mocks.query.mockReset());

  it('creates normalized projects and validates names and keys', async () => {
    mocks.query.mockResolvedValue({ rows: [project()] });
    await expect(createIssueProject({
      description: ' local ', name: ' HorizonLayer ', project_key: ' hl ',
    })).resolves.toMatchObject({ project_key: 'HL' });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(['HL', 'HorizonLayer', 'local']);

    await expect(createIssueProject({ name: 'x', project_key: '1' })).rejects.toThrow('key');
    await expect(createIssueProject({ name: ' ', project_key: 'HL' })).rejects.toThrow('name');
  });

  it('lists and gets active or archived projects with bounded pagination', async () => {
    mocks.query.mockResolvedValue({ rows: [project()] });
    await expect(listIssueProjects()).resolves.toHaveLength(1);
    await expect(listIssueProjects({ include_archived: true, limit: 10, offset: 3 }))
      .resolves.toHaveLength(1);
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([true, 10, 3]);
    await expect(listIssueProjects({ limit: 102 })).rejects.toThrow('between');
    await expect(listIssueProjects({ offset: -1 })).rejects.toThrow('between');

    await expect(getIssueProject('project-1')).resolves.toMatchObject({ id: 'project-1' });
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(getIssueProject('missing', true)).resolves.toBeNull();
  });

  it('updates mutable fields and reports invalid or stale writes', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [project({ description: 'updated', revision: 2 })] });
    await expect(updateIssueProject('project-1', {
      description: ' updated ', name: ' New ', revision: 1,
    })).resolves.toMatchObject({ revision: 2 });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(['New', 'updated', 'project-1', 1]);

    await expect(updateIssueProject('project-1', { revision: 1 })).rejects.toThrow('At least');
    await expect(updateIssueProject('project-1', { name: ' ', revision: 1 })).rejects.toThrow('name');

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ archived_at: null, revision: 4 }],
    });
    await expect(updateIssueProject('project-1', { description: null, revision: 1 }))
      .rejects.toThrow('revision 4');
  });

  it('archives, restores, and distinguishes lifecycle conflicts from missing records', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [project({ archived_at: 'now', revision: 2 })] });
    await expect(archiveIssueProject('project-1', 1)).resolves.toMatchObject({ revision: 2 });

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ archived_at: 'now', revision: 1 }],
    });
    await expect(archiveIssueProject('project-1', 1)).rejects.toThrow('already archived');

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ archived_at: 'now', revision: 3 }],
    });
    await expect(restoreIssueProject('project-1', 1)).rejects.toThrow('revision 3');

    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(restoreIssueProject('missing', 1)).resolves.toBeNull();
  });
});
