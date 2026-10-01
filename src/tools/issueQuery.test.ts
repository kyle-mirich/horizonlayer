import { describe, expect, it } from 'vitest';
import { parseIssueQuery } from './issueQuery.js';

describe('parseIssueQuery', () => {
  it('parses the supported agent-oriented filters', () => {
    expect(parseIssueQuery('project = HL AND status IN (open, blocked) AND assignee IS EMPTY AND tag = agent AND text ~ "database migration"')).toEqual({
      assignee: null,
      project_key: 'HL',
      status: ['open', 'blocked'],
      tags: ['agent'],
      text: 'database migration',
    });
  });

  it('supports ready, priority, and empty input', () => {
    expect(parseIssueQuery('ready = true AND priority = highest')).toEqual({
      priority: ['highest'],
      ready: true,
    });
    expect(parseIssueQuery('ready = TRUE')).toEqual({ ready: true });
    expect(parseIssueQuery('ready = False')).toEqual({ ready: false });
    expect(parseIssueQuery('')).toEqual({});
  });

  it.each(['banana', '1', '""'])('rejects invalid ready values: %s', (value) => {
    expect(() => parseIssueQuery(`project = HL AND ready = ${value}`)).toThrow(
      'Issue ready filter must be true or false'
    );
  });

  it.each(['status', 'priority', 'tag'])('rejects empty %s collections instead of removing the filter', (field) => {
    expect(() => parseIssueQuery(`${field} IN ()`)).toThrow('requires at least one value');
  });

  it.each(['""', '"   "'])('rejects an empty project filter: %s', (value) => {
    expect(() => parseIssueQuery(`project = ${value}`)).toThrow('project filter cannot be empty');
  });

  it('rejects unsupported clauses instead of silently broadening a query', () => {
    expect(() => parseIssueQuery('status = flying')).toThrow('Unknown Issue status');
    expect(() => parseIssueQuery('project != HL')).toThrow('Unsupported Issue query clause');
    expect(() => parseIssueQuery('assignee IS NOT EMPTY')).toThrow('Use assignee = NAME');
  });

  it('covers every supported scalar and collection form', () => {
    expect(parseIssueQuery("status = done AND priority = low AND assignee = 'agent-a' AND summary ~ 'fix parser' AND ready = false"))
      .toEqual({
        assignee: 'agent-a',
        priority: ['low'],
        ready: false,
        status: ['done'],
        text: 'fix parser',
      });
    expect(parseIssueQuery('priority IN (low, highest) AND tag IN (backend, agent)')).toEqual({
      priority: ['low', 'highest'],
      tags: ['backend', 'agent'],
    });
    expect(parseIssueQuery('tag IN backend')).toEqual({ tags: ['backend'] });
  });

  it('rejects invalid scalar and collection values', () => {
    expect(() => parseIssueQuery('priority = urgent')).toThrow('Unknown Issue priority');
    expect(() => parseIssueQuery('status IN (open, flying)')).toThrow('Unknown Issue status in IN');
    expect(() => parseIssueQuery('priority IN (low, urgent)')).toThrow('Unknown Issue priority in IN');
    expect(() => parseIssueQuery('assignee IN (a, b)')).toThrow('Unsupported Issue query clause');
    expect(() => parseIssueQuery('unknown = value')).toThrow('Unsupported Issue query clause');
  });
});
