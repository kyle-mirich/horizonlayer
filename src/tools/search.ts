import { z } from 'zod';
import type { AppServer } from '../mcp.js';
import { search } from '../db/queries/search.js';
import { accessFromSession, errorEnvelope, successEnvelope } from './common.js';

const SearchSchema = z.object({
  query: z.string().min(1).optional().describe('Search query text'),
  q: z.string().min(1).optional().describe('Alias for query'),
  mode: z
    .enum([
      'similarity',
      'similarity_recency',
      'similarity_importance',
      'full_text',
      'grep',
      'regex',
      'hybrid',
    ])
    .optional()
    .describe(
      'Optional mode (default: hybrid). Options: similarity, similarity_recency, similarity_importance, full_text, grep, regex, hybrid'
    ),
  type: z
    .enum(['all', 'page', 'row'])
    .optional()
    .describe('Optional content type shortcut (default: all)'),
  content_types: z
    .array(z.enum(['pages', 'rows']))
    .optional()
    .describe('Optional explicit content types (overrides type)'),
  workspace_id: z
    .string()
    .uuid()
    .optional()
    .describe('Filter results to a specific workspace'),
  session_id: z
    .string()
    .uuid()
    .optional()
    .describe('Optional session scope for page search'),
  database_id: z
    .string()
    .uuid()
    .optional()
    .describe('Limit row search to a specific database (automatically sets content_types to rows only)'),
  tags: z.array(z.string()).optional().describe('Filter by tags (any match)'),
  min_importance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum importance score'),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Max results to return (default 20)'),
  offset: z.number().int().min(0).optional().describe('Offset into the ranked result set'),
}).strict();

export function registerSearchTools(server: AppServer): void {
  server.addTool({
    name: 'search',
    description: 'Search pages and rows, with optional session scoping for page results.',
    parameters: SearchSchema,
    execute: async (params, context) => {
      const action = 'search';
      const access = accessFromSession(context.session);
      const query = params.query ?? params.q;
      if (!query) {
        return errorEnvelope(action, 'query (or q) is required');
      }

      const contentTypes: Array<'pages' | 'rows'> = params.database_id
        ? ['rows']
        : (params.content_types ??
          (params.type === 'page'
            ? ['pages']
            : params.type === 'row'
              ? ['rows']
              : ['pages', 'rows']));

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;
      const fetchLimit = limit + offset;
      const results = await search({
        query,
        mode: params.mode ?? 'hybrid',
        content_types: contentTypes,
        workspace_id: params.workspace_id,
        session_id: params.session_id,
        database_id: params.database_id,
        tags: params.tags,
        min_importance: params.min_importance,
        limit: fetchLimit,
        access,
      });

      return successEnvelope({
        action,
        result: results.slice(offset, offset + limit),
        meta: { limit, offset, total_available: results.length },
      });
    },
  });
}
