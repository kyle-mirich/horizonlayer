import { z } from 'zod';
import type { AppServer, AppToolDefinition } from '../mcp.js';
import {
  archiveIssueProject,
  createIssueProject,
  getIssueProject,
  listIssueProjects,
  restoreIssueProject,
  updateIssueProject,
} from '../db/queries/issueProjects.js';
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  addIssueComment,
  archiveIssue,
  archiveIssueDependency,
  claimIssue,
  createIssue,
  createIssueDependency,
  getIssue,
  listIssueComments,
  listIssueDependencies,
  queryIssues,
  releaseIssue,
  restoreIssue,
  updateIssue,
} from '../db/queries/issues.js';
import { archiveLink, createLink, listLinks, restoreLink, traverseLinks } from '../db/queries/links.js';
import { LINK_ITEM_TYPES } from '../domain.js';
import { errorEnvelopeFromUnknown, successEnvelope } from './common.js';
import { coreToolDefinitions } from './core.js';
import { parseIssueQuery } from './issueQuery.js';

export const MODULES = ['knowledge', 'issues'] as const;
export type HorizonModule = typeof MODULES[number];
export type ToolCatalogMode = 'modules' | 'legacy';

const JsonInput = z.record(z.unknown()).describe('Operation arguments; use an empty object when none are needed');
const ModuleOutputSchema = {
  type: 'object' as const,
  additionalProperties: true,
  description: 'A compact HorizonLayer success or error envelope',
};

interface CompactCoreDefinition {
  execute: (parameters: unknown) => unknown | Promise<unknown>;
  parameters: z.ZodTypeAny;
}
function coreDefinition(name: string): CompactCoreDefinition | undefined {
  return coreToolDefinitions().find((definition) => definition.name === name) as unknown as CompactCoreDefinition | undefined;
}
const KnowledgeOperation = z.enum([
  'workspace',
  'session',
  'page',
  'database',
  'row',
  'link',
  'search',
  'run',
  'navigate',
]);
const KnowledgeSchema = z.object({
  operation: KnowledgeOperation.describe('Knowledge operation family'),
  input: JsonInput.optional().default({}),
}).strict();

function invalidInput(label: string, error: z.ZodError): Error {
  return new Error(`Invalid ${label} input: ${error.issues.map((issue) => (
    `${issue.path.join('.') || '<root>'}: ${issue.message}`
  )).join('; ')}`);
}

function knowledgeDefinition(): AppToolDefinition<typeof KnowledgeSchema> {
  return {
    name: 'knowledge',
    description: 'Use durable workspaces, pages, typed databases, search, runs, and explicit links. Content is expanded only when requested.',
    parameters: KnowledgeSchema,
    outputSchema: ModuleOutputSchema,
    execute: async ({ operation, input }) => {
      try {
        if (operation === 'navigate') {
          const parsed = NavigateSchema.safeParse(input);
          if (!parsed.success) throw invalidInput('navigate', parsed.error);
          return successEnvelope({ action: operation, result: await traverseLinks(parsed.data) });
        }
        const definition = coreDefinition(operation);
        if (!definition) throw new Error(`Unknown Knowledge operation: ${operation}`);
        const parsed = definition.parameters.safeParse(input);
        if (!parsed.success) throw invalidInput(operation, parsed.error);
        return await definition.execute(parsed.data) as ReturnType<AppToolDefinition<typeof KnowledgeSchema>['execute']>;
      } catch (error) {
        return errorEnvelopeFromUnknown(operation, error);
      }
    },
  };
}

const Id = z.string().uuid();
const Revision = z.number().int().positive();
const Limit = z.number().int().min(1).max(50).optional();
const Offset = z.number().int().nonnegative().optional();
const IssueId = z.string().trim().min(1).describe('Issue UUID or readable key such as HL-12');
const Tags = z.array(z.string().trim().min(1).max(100)).max(50);
const NavigateSchema = z.object({
  item_type: z.enum(LINK_ITEM_TYPES),
  item_id: Id,
  depth: z.number().int().min(1).max(3).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

const IssueAction = z.enum([
  'project.create', 'project.list', 'project.get', 'project.update', 'project.archive', 'project.restore',
  'issue.create', 'issue.get', 'issue.query', 'issue.update', 'issue.claim', 'issue.release', 'issue.archive', 'issue.restore',
  'comment.add', 'comment.list',
  'dependency.create', 'dependency.archive',
  'dependency.list',
  'link.create', 'link.list', 'link.archive', 'link.restore', 'link.traverse',
]);
const IssuesSchema = z.object({
  action: IssueAction.describe('Issue operation to perform'),
  input: JsonInput.optional().default({}),
}).strict();

const issueInputs: Record<z.infer<typeof IssueAction>, z.ZodTypeAny> = {
  'project.create': z.object({ project_key: z.string(), name: z.string(), description: z.string().optional() }).strict(),
  'project.list': z.object({ include_archived: z.boolean().optional(), limit: Limit, offset: Offset }).strict(),
  'project.get': z.object({ project_id: Id, include_archived: z.boolean().optional() }).strict(),
  'project.update': z.object({ project_id: Id, revision: Revision, name: z.string().optional(), description: z.string().nullable().optional() }).strict(),
  'project.archive': z.object({ project_id: Id, revision: Revision }).strict(),
  'project.restore': z.object({ project_id: Id, revision: Revision }).strict(),
  'issue.create': z.object({
    project_id: Id, title: z.string(), created_by: z.string(), description: z.string().optional(),
    status: z.enum(ISSUE_STATUSES).optional(), priority: z.enum(ISSUE_PRIORITIES).optional(),
    assignee: z.string().optional(), tags: Tags.optional(), parent_issue: IssueId.optional(),
  }).strict(),
  'issue.get': z.object({ issue: IssueId, include_archived: z.boolean().optional(), include_comments: z.boolean().optional(), include_links: z.boolean().optional() }).strict(),
  'issue.query': z.object({ query: z.string().optional(), include_archived: z.boolean().optional(), limit: Limit, offset: Offset }).strict(),
  'issue.update': z.object({
    issue: IssueId, revision: Revision, title: z.string().optional(), description: z.string().nullable().optional(),
    status: z.enum(ISSUE_STATUSES).optional(), priority: z.enum(ISSUE_PRIORITIES).nullable().optional(),
    assignee: z.string().nullable().optional(), tags: Tags.optional(), parent_issue: IssueId.nullable().optional(),
  }).strict(),
  'issue.claim': z.object({ issue: IssueId, assignee: z.string(), revision: Revision }).strict(),
  'issue.release': z.object({ issue: IssueId, revision: Revision }).strict(),
  'issue.archive': z.object({ issue: IssueId, revision: Revision }).strict(),
  'issue.restore': z.object({ issue: IssueId, revision: Revision }).strict(),
  'comment.add': z.object({ issue: IssueId, author: z.string(), body: z.string() }).strict(),
  'comment.list': z.object({ issue: IssueId }).strict(),
  'dependency.create': z.object({ blocking_issue: IssueId, blocked_issue: IssueId }).strict(),
  'dependency.archive': z.object({ dependency_id: Id, revision: Revision }).strict(),
  'dependency.list': z.object({ issue: IssueId }).strict(),
  'link.create': z.object({ workspace_id: Id.optional(), from_type: z.enum(LINK_ITEM_TYPES), from_id: Id, to_type: z.enum(LINK_ITEM_TYPES), to_id: Id, link_type: z.string().optional() }).strict(),
  'link.list': z.object({ workspace_id: Id.optional(), item_type: z.enum(LINK_ITEM_TYPES).optional(), item_id: Id.optional(), link_type: z.string().optional(), direction: z.enum(['from', 'to', 'both']).optional(), include_archived: z.boolean().optional(), limit: Limit, offset: Offset }).strict(),
  'link.archive': z.object({ link_id: Id, revision: Revision }).strict(),
  'link.restore': z.object({ link_id: Id, revision: Revision }).strict(),
  'link.traverse': NavigateSchema,
};

async function requireIssue(value: string, includeArchived = false) {
  const issue = await getIssue(value, includeArchived);
  if (!issue) throw new Error(`Issue ${value} not found`);
  return issue;
}

async function executeIssueAction(action: z.infer<typeof IssueAction>, input: Record<string, unknown>): Promise<unknown> {
  // Each action-specific Zod schema has already validated this object.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = input;
  switch (action) {
    case 'project.create': return createIssueProject(params);
    case 'project.list': return listIssueProjects(params);
    case 'project.get': return getIssueProject(params.project_id, params.include_archived);
    case 'project.update': return updateIssueProject(params.project_id, params);
    case 'project.archive': return archiveIssueProject(params.project_id, params.revision);
    case 'project.restore': return restoreIssueProject(params.project_id, params.revision);
    case 'issue.create': {
      const parent = params.parent_issue ? await requireIssue(params.parent_issue) : null;
      return createIssue({ ...params, parent_issue_id: parent?.id });
    }
    case 'issue.get': {
      const issue = await requireIssue(params.issue, params.include_archived);
      return {
        issue,
        dependencies: await listIssueDependencies(issue.id),
        subtasks: await queryIssues({ parent_issue_id: issue.id, limit: 50 }),
        ...(params.include_comments ? { comments: await listIssueComments(issue.id) } : {}),
        ...(params.include_links ? { links: await listLinks({ item_type: 'issue', item_id: issue.id }) } : {}),
      };
    }
    case 'issue.query': return queryIssues({ ...parseIssueQuery(params.query ?? ''), include_archived: params.include_archived, limit: params.limit, offset: params.offset });
    case 'issue.update': {
      const issue = await requireIssue(params.issue);
      const parent = params.parent_issue === undefined ? undefined
        : params.parent_issue === null ? null : (await requireIssue(params.parent_issue)).id;
      return updateIssue(issue.id, { ...params, parent_issue_id: parent });
    }
    case 'issue.claim': return claimIssue((await requireIssue(params.issue)).id, params.assignee, params.revision);
    case 'issue.release': return releaseIssue((await requireIssue(params.issue)).id, params.revision);
    case 'issue.archive': return archiveIssue((await requireIssue(params.issue, true)).id, params.revision);
    case 'issue.restore': return restoreIssue((await requireIssue(params.issue, true)).id, params.revision);
    case 'comment.add': return addIssueComment({ ...params, issue_id: (await requireIssue(params.issue)).id });
    case 'comment.list': return listIssueComments((await requireIssue(params.issue)).id);
    case 'dependency.create': return createIssueDependency((await requireIssue(params.blocking_issue)).id, (await requireIssue(params.blocked_issue)).id);
    case 'dependency.archive': return archiveIssueDependency(params.dependency_id, params.revision);
    case 'dependency.list': return listIssueDependencies((await requireIssue(params.issue)).id);
    case 'link.create': return createLink(params);
    case 'link.list': return listLinks(params);
    case 'link.archive': return archiveLink(params.link_id, params.revision);
    case 'link.restore': return restoreLink(params.link_id, params.revision);
    case 'link.traverse': return traverseLinks(params);
  }
}

function issuesDefinition(): AppToolDefinition<typeof IssuesSchema> {
  return {
    name: 'issues',
    description: 'Manage Jira-style projects, Issues, comments, subtasks, dependencies, claims, compact queries, and explicit knowledge links.',
    parameters: IssuesSchema,
    outputSchema: ModuleOutputSchema,
    execute: async ({ action, input }) => {
      try {
        const parsed = issueInputs[action].safeParse(input);
        if (!parsed.success) throw invalidInput(action, parsed.error);
        return successEnvelope({ action, result: await executeIssueAction(action, parsed.data) });
      } catch (error) {
        return errorEnvelopeFromUnknown(action, error);
      }
    },
  };
}

export function registerModuleTools(server: AppServer, modules: readonly HorizonModule[]): void {
  if (modules.includes('knowledge')) server.addTool(knowledgeDefinition());
  if (modules.includes('issues')) server.addTool(issuesDefinition());
}
