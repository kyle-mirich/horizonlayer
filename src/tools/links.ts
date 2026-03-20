import { z } from 'zod';
import type { AppServer } from '../mcp.js';
import { createLink, listLinks, deleteLink } from '../db/queries/links.js';
import { accessFromSession, errorEnvelope, successEnvelope } from './common.js';
import { isPreview, projectResult, type ReturnMode } from './utils.js';

const ItemTypeEnum = z.enum(['workspace', 'page', 'row', 'database', 'block', 'database_row']);
const LinkActionEnum = z.enum(['create', 'list', 'delete']);
type LinkAction = z.infer<typeof LinkActionEnum>;

function respond(action: string, result: unknown, returnMode: ReturnMode, fields?: string[]) {
  return successEnvelope({
    action,
    result: projectResult(result, returnMode, fields),
  });
}

export function registerLinkTools(server: AppServer): void {
  server.addTool({
    name: 'link',
    description: 'Consolidated link tool: create/list/delete',
    parameters: z.object({
      action: LinkActionEnum.optional().describe('Link action to run'),
      op: LinkActionEnum.optional().describe('Alias for action'),

      from_type: ItemTypeEnum.optional().describe('Type of the source item for create'),
      from_id: z.string().uuid().optional().describe('ID of the source item for create'),
      to_type: ItemTypeEnum.optional().describe('Type of the target item for create'),
      to_id: z.string().uuid().optional().describe('ID of the target item for create'),
      link_type: z.string().max(100).optional().describe('Relationship type for create'),

      item_type: ItemTypeEnum.optional().describe('Type of item for list'),
      item_id: z.string().uuid().optional().describe('Item ID for list'),
      direction: z
        .enum(['from', 'to', 'both'])
        .optional()
        .describe('Direction filter for list'),

      link_id: z.string().uuid().optional().describe('Link ID for delete'),
      return: z.enum(['minimal', 'full']).optional().describe('Response shape'),
      fields: z.array(z.string()).optional().describe('Optional projected fields'),
      dry_run: z.boolean().optional().describe('Preview mutation without writing'),
      validate_only: z.boolean().optional().describe('Validate request without writing'),
    }),
    execute: async (params, context) => {
      const access = accessFromSession(context.session);
      const returnMode = params.return ?? 'full';
      const action: LinkAction =
        params.action ??
        params.op ??
        (params.from_type && params.from_id && params.to_type && params.to_id ? 'create' : 'list');

      switch (action) {
        case 'create': {
          if (!params.from_type || !params.from_id || !params.to_type || !params.to_id) {
            return errorEnvelope(action, 'from_type, from_id, to_type, and to_id are required for link action=create');
          }
          if (isPreview(params)) {
            return respond(action, { preview: true, values: params }, returnMode, params.fields);
          }
          const link = await createLink({
            from_type: params.from_type,
            from_id: params.from_id,
            to_type: params.to_type,
            to_id: params.to_id,
            link_type: params.link_type,
            access,
          });
          return respond(action, link, returnMode, params.fields);
        }

        case 'list': {
          if (!params.item_type || !params.item_id) {
            return errorEnvelope(action, 'item_type and item_id are required for link action=list');
          }
          const links = await listLinks({
            item_type: params.item_type,
            item_id: params.item_id,
            direction: params.direction,
            access,
          });
          return respond(action, links, returnMode, params.fields);
        }

        case 'delete': {
          if (!params.link_id) return errorEnvelope(action, 'link_id is required for link action=delete');
          if (isPreview(params)) {
            return respond(action, { preview: true, id: params.link_id, success: true }, returnMode, params.fields);
          }
          const deleted = await deleteLink(params.link_id, access);
          if (!deleted) return errorEnvelope(action, `Link ${params.link_id} not found`);
          return respond(action, { success: true, id: params.link_id }, returnMode, params.fields);
        }
      }
    },
  });
}
