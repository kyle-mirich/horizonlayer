import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  archiveIssue: vi.fn(), archiveIssueDependency: vi.fn(), archiveIssueProject: vi.fn(), archiveLink: vi.fn(),
  claimIssue: vi.fn(), createIssue: vi.fn(), createIssueDependency: vi.fn(), createIssueProject: vi.fn(), createLink: vi.fn(),
  getIssue: vi.fn(), getIssueProject: vi.fn(), listIssueComments: vi.fn(), listIssueProjects: vi.fn(), listLinks: vi.fn(),
  queryIssues: vi.fn(), releaseIssue: vi.fn(), restoreIssue: vi.fn(), restoreIssueProject: vi.fn(), restoreLink: vi.fn(),
  traverseLinks: vi.fn(), updateIssue: vi.fn(), updateIssueProject: vi.fn(), addIssueComment: vi.fn(),
  coreExecute: vi.fn(),
}));

vi.mock('../db/queries/issueProjects.js', () => ({
  archiveIssueProject: mocks.archiveIssueProject,
  createIssueProject: mocks.createIssueProject,
  getIssueProject: mocks.getIssueProject,
  listIssueProjects: mocks.listIssueProjects,
  restoreIssueProject: mocks.restoreIssueProject,
  updateIssueProject: mocks.updateIssueProject,
}));
vi.mock('../db/queries/issues.js', () => ({
  ISSUE_PRIORITIES: ['lowest', 'low', 'medium', 'high', 'highest'],
  ISSUE_STATUSES: ['open', 'in_progress', 'blocked', 'done', 'closed'],
  addIssueComment: mocks.addIssueComment,
  archiveIssue: mocks.archiveIssue,
  archiveIssueDependency: mocks.archiveIssueDependency,
  claimIssue: mocks.claimIssue,
  createIssue: mocks.createIssue,
  createIssueDependency: mocks.createIssueDependency,
  getIssue: mocks.getIssue,
  listIssueComments: mocks.listIssueComments,
  queryIssues: mocks.queryIssues,
  releaseIssue: mocks.releaseIssue,
  restoreIssue: mocks.restoreIssue,
  updateIssue: mocks.updateIssue,
}));
vi.mock('../db/queries/links.js', () => ({
  archiveLink: mocks.archiveLink,
  createLink: mocks.createLink,
  listLinks: mocks.listLinks,
  restoreLink: mocks.restoreLink,
  traverseLinks: mocks.traverseLinks,
}));
vi.mock('./core.js', () => ({
  coreToolDefinitions: () => [{
    name: 'workspace',
    parameters: z.object({ action: z.literal('list') }).strict(),
    execute: mocks.coreExecute,
  }],
}));

import type { AppToolDefinition } from '../mcp.js';
import { registerModuleTools } from './modules.js';

const id = '00000000-0000-4000-8000-000000000001';
const id2 = '00000000-0000-4000-8000-000000000002';

function definitions(modules: Array<'issues' | 'knowledge'>) {
  const tools: AppToolDefinition<z.ZodTypeAny>[] = [];
  registerModuleTools({ addTool: (tool: AppToolDefinition<z.ZodTypeAny>) => tools.push(tool) } as never, modules);
  return tools;
}

describe('compact module handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of Object.values(mocks)) mock.mockResolvedValue({ id });
    mocks.getIssue.mockResolvedValue({ id, issue_key: 'HL-1' });
    mocks.listIssueComments.mockResolvedValue([]);
    mocks.listLinks.mockResolvedValue([]);
  });

  it('dispatches Knowledge operations and bounded navigation', async () => {
    const [knowledge] = definitions(['knowledge']);
    mocks.coreExecute.mockResolvedValue({ content: [], structuredContent: { ok: true } });
    const coreResult = await knowledge.execute({ operation: 'workspace', input: { action: 'list' } });
    expect(coreResult.structuredContent).toMatchObject({ ok: true });
    expect(mocks.coreExecute).toHaveBeenCalledWith({ action: 'list' });

    const navigateResult = await knowledge.execute({
      operation: 'navigate', input: { item_type: 'page', item_id: id, depth: 2 },
    });
    expect(navigateResult.structuredContent).toMatchObject({ action: 'navigate', ok: true });
    expect(mocks.traverseLinks).toHaveBeenCalled();
  });

  it('returns compact validation errors without invoking persistence', async () => {
    const [knowledge, issues] = definitions(['knowledge', 'issues']);
    const knowledgeError = await knowledge.execute({ operation: 'workspace', input: { action: 'bad' } });
    const issueError = await issues.execute({ action: 'issue.claim', input: {} });
    expect(knowledgeError.structuredContent).toMatchObject({ ok: false });
    expect(issueError.structuredContent).toMatchObject({ ok: false });
    const navigationError = await knowledge.execute({ operation: 'navigate', input: { item_type: 'page' } });
    expect(navigationError.structuredContent).toMatchObject({ ok: false });
  });

  it('handles optional Issue expansions and missing references', async () => {
    const [issues] = definitions(['issues']);
    await expect(issues.execute({ action: 'issue.create', input: {
      project_id: id, title: 'No parent', created_by: 'agent',
    } })).resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(issues.execute({ action: 'issue.get', input: { issue: 'HL-1' } }))
      .resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(issues.execute({ action: 'issue.update', input: {
      issue: 'HL-1', revision: 1, parent_issue: 'HL-2',
    } })).resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(issues.execute({ action: 'issue.update', input: {
      issue: 'HL-1', revision: 1, title: 'No parent change',
    } })).resolves.toMatchObject({ structuredContent: { ok: true } });

    mocks.getIssue.mockResolvedValueOnce(null);
    await expect(issues.execute({ action: 'issue.get', input: { issue: 'MISSING-1' } }))
      .resolves.toMatchObject({ structuredContent: { ok: false } });
  });

  it.each([
    ['project.create', { project_key: 'HL', name: 'HorizonLayer' }],
    ['project.list', {}],
    ['project.get', { project_id: id }],
    ['project.update', { project_id: id, revision: 1, name: 'New name' }],
    ['project.archive', { project_id: id, revision: 1 }],
    ['project.restore', { project_id: id, revision: 1 }],
    ['issue.create', { project_id: id, title: 'Issue', created_by: 'agent', parent_issue: 'HL-1' }],
    ['issue.get', { issue: 'HL-1', include_comments: true, include_links: true }],
    ['issue.query', { query: 'project = HL AND ready = true' }],
    ['issue.update', { issue: 'HL-1', revision: 1, title: 'Updated', parent_issue: null }],
    ['issue.claim', { issue: 'HL-1', revision: 1, assignee: 'agent' }],
    ['issue.release', { issue: 'HL-1', revision: 1 }],
    ['issue.archive', { issue: 'HL-1', revision: 1 }],
    ['issue.restore', { issue: 'HL-1', revision: 1 }],
    ['comment.add', { issue: 'HL-1', author: 'agent', body: 'Note' }],
    ['comment.list', { issue: 'HL-1' }],
    ['dependency.create', { blocking_issue: 'HL-1', blocked_issue: 'HL-2' }],
    ['dependency.archive', { dependency_id: id, revision: 1 }],
    ['link.create', { from_type: 'page', from_id: id, to_type: 'issue', to_id: id2 }],
    ['link.list', { item_type: 'issue', item_id: id }],
    ['link.archive', { link_id: id, revision: 1 }],
    ['link.restore', { link_id: id, revision: 1 }],
    ['link.traverse', { item_type: 'issue', item_id: id, depth: 3 }],
  ] as const)('dispatches %s', async (action, input) => {
    const [issues] = definitions(['issues']);
    const result = await issues.execute({ action, input });
    expect(result.structuredContent).toMatchObject({ action, ok: true });
  });
});
