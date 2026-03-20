import { z } from 'zod';
import type { AppServer } from '../mcp.js';
import {
  createDatabase,
  getDatabase,
  listDatabases,
  updateDatabase,
  deleteDatabase,
  addDatabaseProperty,
} from '../db/queries/databases.js';
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

const PropertyTypeEnum = z.enum([
  'title',
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'multi_select',
  'url',
  'email',
  'phone',
  'relation',
  'files',
]);

const PropertyInputSchema = z.object({
  name: z.string().min(1).max(255).describe('Property name'),
  type: PropertyTypeEnum.describe('Property type'),
  options: z
    .record(z.unknown())
    .optional()
    .describe(
      'Options: {choices:[...]} for select/multi_select, {format:"dollar"|"percent"|"plain"} for number, {target_database_id:"uuid"} for relation'
    ),
  is_required: z.boolean().optional().describe('Whether this property is required'),
});

const DatabaseActionEnum = z.enum([
  'create',
  'get',
  'list',
  'add_property',
  'update',
  'delete',
]);
type DatabaseAction = z.infer<typeof DatabaseActionEnum>;

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

export function registerDatabaseTools(server: AppServer): void {
  server.addTool({
    name: 'database',
    description: 'Consolidated database tool: create/get/list/add_property/update/delete',
    parameters: z.object({
      action: DatabaseActionEnum.optional().describe('Database action to run'),
      op: DatabaseActionEnum.optional().describe('Alias for action'),

      id: z.string().uuid().optional().describe('Database ID for get/update/delete'),
      database_id: z.string().uuid().optional().describe('Database ID for add_property'),

      name: z.string().min(1).max(500).optional().describe('Database name for create/update'),
      properties: z
        .array(PropertyInputSchema)
        .optional()
        .describe('Property schema for create'),
      workspace_id: z.string().uuid().optional().describe('Workspace ID for create/list filter'),
      parent_page_id: z.string().uuid().optional().describe('Parent page ID for create'),
      description: z.string().optional().describe('Database description for create/update'),
      icon: z.string().max(100).optional().describe('Emoji or icon name for create/update'),
      tags: z.array(z.string()).optional().describe('Tags for create/update/list filter'),
      source: z.string().max(500).optional().describe('Agent/session source for create'),

      type: PropertyTypeEnum.optional().describe('Property type for add_property'),
      options: z.record(z.unknown()).optional().describe('Property options for add_property'),
      is_required: z.boolean().optional().describe('Property required flag for add_property'),
      expected_updated_at: z.string().datetime().optional().describe('Optimistic concurrency precondition for update/delete/schema changes'),
      limit: z.number().int().positive().max(500).optional().describe('Limit for list'),
      cursor: z.string().optional().describe('Cursor for list pagination'),
      return: z.enum(['minimal', 'full']).optional().describe('Response shape'),
      fields: z.array(z.string()).optional().describe('Optional projected fields'),
      dry_run: z.boolean().optional().describe('Preview mutation without writing'),
      validate_only: z.boolean().optional().describe('Validate request without writing'),
    }),
    execute: async (params, context) => {
      const access = accessFromSession(context.session);
      const returnMode = params.return ?? 'full';
      const action: DatabaseAction =
        params.action ??
        params.op ??
        (params.database_id && params.type && params.name
          ? 'add_property'
          : params.id
            ? params.name != null || params.description != null || params.icon != null || params.tags != null
              ? 'update'
              : 'get'
            : params.name && params.properties?.length
              ? 'create'
              : 'list');

      switch (action) {
        case 'create': {
          if (!params.name) return errorEnvelope(action, 'name is required for database action=create');
          if (!params.properties || params.properties.length === 0) {
            return errorEnvelope(action, 'properties (non-empty array) are required for database action=create');
          }
          if (isPreview(params)) {
            return respond(
              action,
              { preview: true, values: params },
              returnMode,
              params.fields
            );
          }
          const db = await createDatabase({
            name: params.name,
            properties: params.properties,
            workspace_id: params.workspace_id,
            parent_page_id: params.parent_page_id,
            description: params.description,
            icon: params.icon,
            tags: params.tags,
            source: params.source,
            access,
          });
          return respond(action, db, returnMode, params.fields);
        }

        case 'get': {
          if (!params.id) return errorEnvelope(action, 'id is required for database action=get');
          const db = await getDatabase(params.id, access);
          if (!db) return errorEnvelope(action, `Database ${params.id} not found`);
          return respond(action, db, returnMode, params.fields);
        }

        case 'list': {
          const offset = decodeCursor(params.cursor);
          const limit = params.limit ?? 50;
          const databases = await listDatabases({
            workspace_id: params.workspace_id,
            tags: params.tags,
            access,
          });
          const items = databases.slice(offset, offset + limit);
          const next = offset + limit < databases.length ? encodeCursor(offset + limit) : null;
          return respond(action, items, returnMode, params.fields, {
            limit,
            next_cursor: next,
            total: databases.length,
          });
        }

        case 'add_property': {
          if (!params.database_id) {
            return errorEnvelope(action, 'database_id is required for database action=add_property');
          }
          if (!params.name) return errorEnvelope(action, 'name is required for database action=add_property');
          if (!params.type) return errorEnvelope(action, 'type is required for database action=add_property');
          if (isPreview(params)) {
            return respond(
              action,
              { preview: true, values: params },
              returnMode,
              params.fields
            );
          }

          const prop = await addDatabaseProperty(
            params.database_id,
            {
              name: params.name,
              type: params.type,
              options: params.options,
              is_required: params.is_required,
              expected_updated_at: params.expected_updated_at,
            },
            access
          );
          return respond(action, prop, returnMode, params.fields);
        }

        case 'update': {
          if (!params.id) return errorEnvelope(action, 'id is required for database action=update');
          if (isPreview(params)) {
            return respond(
              action,
              { preview: true, id: params.id, updates: params },
              returnMode,
              params.fields
            );
          }
          const db = await updateDatabase(
            params.id,
            {
              name: params.name,
              description: params.description,
              icon: params.icon,
              tags: params.tags,
              expected_updated_at: params.expected_updated_at,
            },
            access
          );
          if (!db) return errorEnvelope(action, `Database ${params.id} not found`);
          return respond(action, db, returnMode, params.fields);
        }

        case 'delete': {
          if (!params.id) return errorEnvelope(action, 'id is required for database action=delete');
          if (isPreview(params)) {
            return respond(
              action,
              { preview: true, id: params.id, success: true },
              returnMode,
              params.fields
            );
          }
          const deleted = await deleteDatabase(params.id, access, params.expected_updated_at);
          if (!deleted) return errorEnvelope(action, `Database ${params.id} not found`);
          return respond(action, { success: true, id: params.id }, returnMode, params.fields);
        }
      }
    },
  });
}
