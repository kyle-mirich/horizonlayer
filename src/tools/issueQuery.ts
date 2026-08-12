import { ISSUE_PRIORITIES, ISSUE_STATUSES, type IssuePriority, type IssueStatus } from '../db/queries/issues.js';

export interface ParsedIssueQuery {
  assignee?: string | null;
  priority?: IssuePriority[];
  project_key?: string;
  ready?: boolean;
  status?: IssueStatus[];
  tags?: string[];
  text?: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function values(value: string): string[] {
  const normalized = value.trim().replace(/^\(/u, '').replace(/\)$/u, '');
  return normalized.split(',').map(unquote).map((item) => item.trim()).filter(Boolean);
}

/** Parse the intentionally small, AND-only HorizonLayer issue query language. */
export function parseIssueQuery(query: string): ParsedIssueQuery {
  const source = query.trim();
  if (!source) return {};
  const result: ParsedIssueQuery = {};
  const clauses = source.split(/\s+AND\s+/iu);
  for (const clause of clauses) {
    let match = clause.match(/^([a-z_]+)\s+(=|~)\s+(.+)$/iu);
    if (match) {
      const [, rawField, operator, rawValue] = match;
      const field = rawField.toLowerCase();
      const value = unquote(rawValue);
      if (field === 'project' && operator === '=') result.project_key = value.toUpperCase();
      else if (field === 'status' && operator === '=') {
        if (!ISSUE_STATUSES.includes(value as IssueStatus)) throw new Error(`Unknown Issue status: ${value}`);
        result.status = [value as IssueStatus];
      } else if (field === 'priority' && operator === '=') {
        if (!ISSUE_PRIORITIES.includes(value as IssuePriority)) throw new Error(`Unknown Issue priority: ${value}`);
        result.priority = [value as IssuePriority];
      } else if (field === 'assignee' && operator === '=') result.assignee = value;
      else if ((field === 'text' || field === 'summary') && operator === '~') result.text = value;
      else if (field === 'tag' && operator === '=') result.tags = [value];
      else if (field === 'ready' && operator === '=') result.ready = value.toLowerCase() === 'true';
      else throw new Error(`Unsupported Issue query clause: ${clause}`);
      continue;
    }
    match = clause.match(/^([a-z_]+)\s+IN\s+(.+)$/iu);
    if (match) {
      const field = match[1].toLowerCase();
      const items = values(match[2]);
      if (field === 'status') {
        if (items.some((item) => !ISSUE_STATUSES.includes(item as IssueStatus))) throw new Error('Unknown Issue status in IN clause');
        result.status = items as IssueStatus[];
      } else if (field === 'priority') {
        if (items.some((item) => !ISSUE_PRIORITIES.includes(item as IssuePriority))) throw new Error('Unknown Issue priority in IN clause');
        result.priority = items as IssuePriority[];
      } else if (field === 'tag') result.tags = items;
      else throw new Error(`Unsupported Issue query clause: ${clause}`);
      continue;
    }
    match = clause.match(/^assignee\s+IS\s+(NOT\s+)?EMPTY$/iu);
    if (match) {
      if (match[1]) throw new Error('Use assignee = NAME for assigned Issues');
      result.assignee = null;
      continue;
    }
    throw new Error(`Unsupported Issue query clause: ${clause}`);
  }
  return result;
}
