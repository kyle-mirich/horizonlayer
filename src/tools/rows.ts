import { z } from 'zod';
import type { AppServer, AppSessionData } from '../mcp.js';
import {
  createRow,
  getRow,
  getRowDatabaseId,
  updateRow,
  deleteRow,
  queryRows,
  countRows,
  bulkCreateRows,
  cleanupExpired,
} from '../db/queries/rows.js';
import { getDatabase } from '../db/queries/databases.js';
import {
  accessFromSession,
  errorEnvelope,
  successEnvelope,
} from './common.js';
import {
  decodeCursor,
  encodeCursor,
  isPreview,
  projectResult,
  type ReturnMode,
} from './utils.js';

async function requireProperties(databaseId: string, session?: AppSessionData) {
  const db = await getDatabase(databaseId, accessFromSession(session));
  if (!db) throw new Error(`Database ${databaseId} not found`);
  return db.properties;
}

const RowActionEnum = z.enum([
  'create',
  'get',
  'update',
  'delete',
  'query',
  'count',
  'bulk_create',
  'cleanup_expired',
]);
type RowAction = z.infer<typeof RowActionEnum>;
type NormalizedOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'is_empty';

const RowFilterSchema = z.object({
  property: z.string().describe('Property name to filter on'),
  operator: z
    .enum(['eq', 'neq', 'gt', 'lt', 'contains', 'is_empty', 'equals', 'not_equals'])
    .describe('Filter operator'),
  value: z.unknown().optional().describe('Filter value (not needed for is_empty)'),
});

function normalizeFilters(filters: Array<z.infer<typeof RowFilterSchema>> | undefined): Array<{
  property: string;
  operator: NormalizedOperator;
  value?: unknown;
}> | undefined {
  if (!filters) return undefined;
  return filters.map((filter) => ({
    property: filter.property,
    operator:
      filter.operator === 'equals'
        ? 'eq'
        : filter.operator === 'not_equals'
          ? 'neq'
          : filter.operator,
    value: filter.value,
  }));
}

const RowCreateInputSchema = z.object({
  values: z.record(z.unknown()).describe('Property values keyed by property name'),
  tags: z.array(z.string()).optional(),
  source: z.string().max(500).optional(),
  importance: z.number().min(0).max(1).optional(),
  expires_in_days: z.number().positive().optional(),
});

function respond(
  action: string,
  result: unknown,
  returnMode: ReturnMode,
  fields?: string[],
  meta?: Record<string, unknown>
) {
  return successEnvelope({
    action,
    result: projectResult(result, returnMode, fields),
    meta,
  });
}

export function registerRowTools(server: AppServer): void {
  server.addTool({
    name: 'row',
    description: 'Consolidated row tool: create/get/update/delete/query/count/bulk_create/cleanup_expired',
    parameters: z.object({
      action: RowActionEnum.optional().describe('Row action to run'),
      op: RowActionEnum.optional().describe('Alias for action'),

      id: z.string().uuid().optional().describe('Row ID for get/update/delete'),
      database_id: z.string().uuid().optional().describe('Database ID'),

      values: z
        .record(z.unknown())
        .optional()
        .describe('Property values for create/update'),
      tags: z.array(z.string()).optional().describe('Tags for create/update'),
      source: z.string().max(500).optional().describe('Source for create'),
      importance: z.number().min(0).max(1).optional().describe('Importance for create/update'),
      expires_in_days: z.number().positive().optional().describe('Expiry in days for create'),
      expected_updated_at: z.string().datetime().optional().describe('Optimistic concurrency precondition for update/delete'),

      filters: z.array(RowFilterSchema).optional().describe('Filters for query/count'),
      sort_by: z.string().optional().describe('Sort property for query'),
      limit: z.number().positive().max(500).optional().describe('Limit for query'),
      offset: z.number().min(0).optional().describe('Offset for query'),
      cursor: z.string().optional().describe('Cursor for query pagination'),

      rows: z.array(RowCreateInputSchema).optional().describe('Rows for bulk_create (max 100)'),
      return: z.enum(['minimal', 'full']).optional().describe('Response shape'),
      fields: z.array(z.string()).optional().describe('Optional projected fields'),
      dry_run: z.boolean().optional().describe('Preview mutation without writing'),
      validate_only: z.boolean().optional().describe('Validate request without writing'),
    }),
    execute: async (params, context) => {
      try {
        const access = accessFromSession(context.session);
        const returnMode = params.return ?? 'full';
        const action: RowAction =
          params.action ??
          params.op ??
          (params.rows?.length
            ? 'bulk_create'
            : params.id && params.database_id && (params.values != null || params.tags != null || params.importance != null)
                ? 'update'
                : params.id
                  ? 'get'
                  : params.database_id && params.values
                    ? 'create'
                    : params.filters != null || params.sort_by != null || params.limit != null || params.offset != null
                      ? 'query'
                      : 'query');

        switch (action) {
          case 'create': {
            if (!params.database_id) return errorEnvelope(action, 'database_id is required for row action=create');
            if (!params.values) return errorEnvelope(action, 'values is required for row action=create');
            if (isPreview(params)) {
              return respond(action, { preview: true, values: params }, returnMode, params.fields);
            }
            const properties = await requireProperties(params.database_id, context.session);
            const row = await createRow({
              database_id: params.database_id,
              values: params.values,
              tags: params.tags,
              source: params.source,
              importance: params.importance,
              expires_in_days: params.expires_in_days,
              properties,
              access,
            });
            return respond(action, row, returnMode, params.fields);
          }

          case 'get': {
            if (!params.id) return errorEnvelope(action, 'id is required for row action=get');
            const databaseId = params.database_id ?? (await getRowDatabaseId(params.id, access));
            if (!databaseId) return errorEnvelope(action, `Row ${params.id} not found`);
            const properties = await requireProperties(databaseId, context.session);
            const row = await getRow(params.id, properties, access);
            if (!row) return errorEnvelope(action, `Row ${params.id} not found`);
            return respond(action, row, returnMode, params.fields);
          }

          case 'update': {
            if (!params.id) return errorEnvelope(action, 'id is required for row action=update');
            if (!params.database_id) return errorEnvelope(action, 'database_id is required for row action=update');
            if (isPreview(params)) {
              return respond(action, { preview: true, id: params.id, updates: params }, returnMode, params.fields);
            }
            const properties = await requireProperties(params.database_id, context.session);
            const row = await updateRow(
              params.id,
              {
                values: params.values,
                tags: params.tags,
                importance: params.importance,
                properties,
                expected_updated_at: params.expected_updated_at,
              },
              access
            );
            if (!row) return errorEnvelope(action, `Row ${params.id} not found`);
            return respond(action, row, returnMode, params.fields);
          }

          case 'delete': {
            if (!params.id) return errorEnvelope(action, 'id is required for row action=delete');
            if (isPreview(params)) {
              return respond(action, { preview: true, id: params.id, success: true }, returnMode, params.fields);
            }
            const deleted = await deleteRow(params.id, access, params.expected_updated_at);
            if (!deleted) return errorEnvelope(action, `Row ${params.id} not found`);
            return respond(action, { success: true, id: params.id }, returnMode, params.fields);
          }

          case 'query': {
            if (!params.database_id) return errorEnvelope(action, 'database_id is required for row action=query');
            const properties = await requireProperties(params.database_id, context.session);
            const filters = normalizeFilters(params.filters);
            const limit = params.limit ?? 50;
            const offset = params.offset ?? decodeCursor(params.cursor);
            const result = await queryRows({
              database_id: params.database_id,
              filters,
              sort_by: params.sort_by,
              limit,
              offset,
              properties,
              access,
            });
            const next = result.rows.length === limit ? encodeCursor(offset + limit) : null;
            return respond(action, result, returnMode, params.fields, {
              limit,
              offset,
              next_cursor: next,
              total: result.total,
            });
          }

          case 'count': {
            if (!params.database_id) return errorEnvelope(action, 'database_id is required for row action=count');
            const properties = await requireProperties(params.database_id, context.session);
            const filters = normalizeFilters(params.filters);
            const total = await countRows({
              database_id: params.database_id,
              filters,
              properties,
              access,
            });
            return respond(action, { count: total }, returnMode, params.fields);
          }

          case 'bulk_create': {
            if (!params.database_id) {
              return errorEnvelope(action, 'database_id is required for row action=bulk_create');
            }
            if (!params.rows || params.rows.length === 0) {
              return errorEnvelope(action, 'rows (non-empty array) are required for row action=bulk_create');
            }
            if (params.rows.length > 100) {
              return errorEnvelope(action, 'rows cannot exceed 100 for row action=bulk_create');
            }
            if (isPreview(params)) {
              return respond(
                action,
                { preview: true, database_id: params.database_id, rows: params.rows.length },
                returnMode,
                params.fields
              );
            }
            const properties = await requireProperties(params.database_id, context.session);
            const created = await bulkCreateRows({
              database_id: params.database_id,
              rows: params.rows,
              properties,
              access,
            });
            return respond(action, created, returnMode, params.fields);
          }

          case 'cleanup_expired': {
            if (isPreview(params)) {
              return respond(action, { preview: true, operation: 'cleanup_expired' }, returnMode, params.fields);
            }
            const result = await cleanupExpired(access);
            return respond(action, result, returnMode, params.fields);
          }
        }
      } catch (err) {
        return errorEnvelope('row', err instanceof Error ? err.message : String(err));
      }
    },
  });
}
