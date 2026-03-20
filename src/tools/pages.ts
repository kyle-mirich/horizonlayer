import { z } from 'zod';
import type { AppServer } from '../mcp.js';
import {
  appendPageBlocks,
  createPage,
  deletePage,
  deletePageBlock,
  getPage,
  listPages,
  updatePage,
  updatePageBlock,
} from '../db/queries/pages.js';
import { accessFromSession, errorEnvelope, successEnvelope } from './common.js';

const BlockInputSchema = z.object({
  block_type: z
    .enum([
      'paragraph',
      'text',
      'heading1',
      'heading2',
      'heading3',
      'code',
      'bulleted_list',
      'numbered_list',
      'quote',
      'callout',
      'divider',
      'image',
      'bookmark',
      'embed',
    ])
    .describe('Block type'),
  content: z.string().optional().describe('Text content of the block'),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe(
      'Block metadata: {language} for code, {url,caption} for image, {url,title,description} for bookmark, {icon,color} for callout, {url} for embed'
    ),
});

function normalizeBlocks(blocks: Array<z.infer<typeof BlockInputSchema>> | undefined) {
  if (!blocks) return undefined;
  return blocks.map((block) => ({
    ...block,
    block_type: block.block_type === 'paragraph' ? 'text' : block.block_type,
  }));
}

const PageActionEnum = z.enum([
  'create',
  'get',
  'update',
  'append_blocks',
  'append_text',
  'delete',
  'list',
  'block_update',
  'block_delete',
]);
type PageAction = z.infer<typeof PageActionEnum>;

const PageSchema = z.object({
  action: PageActionEnum.describe('Page action to run'),
  id: z.string().uuid().optional().describe('Page ID for get/update/delete'),
  page_id: z.string().uuid().optional().describe('Page ID for append_blocks/append_text'),
  block_id: z.string().uuid().optional().describe('Block ID for block_update/block_delete'),
  title: z.string().min(1).max(500).optional().describe('Page title for create/update/append_text journal pages'),
  workspace_id: z.string().uuid().optional().describe('Workspace ID'),
  session_id: z.string().uuid().optional().describe('Optional session scope for create/get/list/append actions'),
  parent_page_id: z.string().uuid().optional().describe('Parent page ID for nesting/filtering'),
  icon: z.string().max(100).optional().describe('Emoji or icon name'),
  cover_url: z.string().url().optional().describe('Cover image URL'),
  tags: z.array(z.string()).optional().describe('Tags for categorization/filtering'),
  source: z.string().max(500).optional().describe('Agent/session that created this page'),
  importance: z.number().min(0).max(1).optional().describe('Importance score 0-1'),
  min_importance: z.number().min(0).max(1).optional().describe('Minimum importance for list'),
  expires_in_days: z.number().positive().optional().describe('Days until this page expires'),
  blocks: z.array(BlockInputSchema).optional().describe('Blocks for create/append_blocks'),
  content: z.string().optional().describe('Text content for create shorthand, append_text, or block_update'),
  metadata: z.record(z.unknown()).optional().describe('Block metadata for block_update'),
  limit: z.number().int().positive().max(500).optional().describe('Max results for list'),
  offset: z.number().int().min(0).optional().describe('Pagination offset for list'),
}).strict();

type PageParams = z.infer<typeof PageSchema>;

function textBlocks(content: string) {
  return [{ block_type: 'text' as const, content }];
}

function buildPageCreateParams(
  params: PageParams,
  access: ReturnType<typeof accessFromSession>,
  title: string,
  blocks?: ReturnType<typeof normalizeBlocks>
) {
  return {
    title,
    workspace_id: params.workspace_id,
    session_id: params.session_id,
    parent_page_id: params.parent_page_id,
    icon: params.icon,
    cover_url: params.cover_url,
    tags: params.tags,
    source: params.source,
    importance: params.importance,
    expires_in_days: params.expires_in_days,
    blocks,
    access,
  };
}

export function registerPageTools(server: AppServer): void {
  server.addTool({
    name: 'page',
    description: 'Page actions with session-aware create/list/get/append flows',
    parameters: PageSchema,
    execute: async (params, context) => {
      const access = accessFromSession(context.session);
      const action: PageAction = params.action;

      switch (action) {
        case 'create': {
          const blocks = normalizeBlocks(params.blocks)
            ?? (params.content != null
              ? textBlocks(params.content)
              : undefined);
          const page = await createPage(buildPageCreateParams(params, access, params.title ?? 'Untitled', blocks));
          return successEnvelope({ action, result: page });
        }

        case 'get': {
          if (!params.id) return errorEnvelope(action, 'id is required for page action=get');
          const page = await getPage(params.id, access, params.session_id);
          if (!page) return errorEnvelope(action, `Page ${params.id} not found`);
          return successEnvelope({ action, result: page });
        }

        case 'update': {
          if (!params.id) return errorEnvelope(action, 'id is required for page action=update');
          const page = await updatePage(
            params.id,
            {
              title: params.title,
              icon: params.icon,
              cover_url: params.cover_url,
              tags: params.tags,
              importance: params.importance,
            },
            access
          );
          if (!page) return errorEnvelope(action, `Page ${params.id} not found`);
          return successEnvelope({ action, result: page });
        }

        case 'append_blocks': {
          if (!params.page_id) return errorEnvelope(action, 'page_id is required for page action=append_blocks');
          if (!params.blocks || params.blocks.length === 0) {
            return errorEnvelope(action, 'blocks (non-empty array) are required for page action=append_blocks');
          }
          const inserted = await appendPageBlocks(
            params.page_id,
            normalizeBlocks(params.blocks) ?? [],
            access,
            undefined,
            params.session_id
          );
          return successEnvelope({ action, result: inserted });
        }

        case 'append_text': {
          if (params.content == null || params.content.length === 0) {
            return errorEnvelope(action, 'content is required for page action=append_text');
          }

          if (params.page_id) {
            const inserted = await appendPageBlocks(
              params.page_id,
              textBlocks(params.content),
              access,
              undefined,
              params.session_id
            );
            return successEnvelope({ action, result: inserted });
          }

          if (!params.workspace_id) {
            return errorEnvelope(action, 'workspace_id is required when append_text does not target an existing page');
          }

          const page = await createPage(
            buildPageCreateParams(
              params,
              access,
              params.title ?? `Journal ${new Date().toISOString()}`,
              textBlocks(params.content)
            )
          );
          return successEnvelope({ action, result: page });
        }

        case 'delete': {
          if (!params.id) return errorEnvelope(action, 'id is required for page action=delete');
          const deleted = await deletePage(params.id, access);
          if (!deleted) return errorEnvelope(action, `Page ${params.id} not found`);
          return successEnvelope({
            action,
            result: { success: true, id: params.id },
          });
        }

        case 'list': {
          const limit = params.limit ?? 50;
          const offset = params.offset ?? 0;
          const pages = await listPages({
            workspace_id: params.workspace_id,
            session_id: params.session_id,
            parent_page_id: params.parent_page_id,
            tags: params.tags,
            min_importance: params.min_importance,
            limit,
            offset,
            access,
          });
          return successEnvelope({
            action,
            result: pages,
            meta: { limit, offset },
          });
        }

        case 'block_update': {
          if (!params.block_id) return errorEnvelope(action, 'block_id is required for page action=block_update');
          if (params.content == null && params.metadata == null) {
            return errorEnvelope(action, 'content or metadata is required for page action=block_update');
          }
          const block = await updatePageBlock(
            params.block_id,
            {
              content: params.content,
              metadata: params.metadata,
            },
            access
          );
          if (!block) return errorEnvelope(action, `Block ${params.block_id} not found`);
          return successEnvelope({ action, result: block });
        }

        case 'block_delete': {
          if (!params.block_id) return errorEnvelope(action, 'block_id is required for page action=block_delete');
          const deleted = await deletePageBlock(params.block_id, access);
          if (!deleted) return errorEnvelope(action, `Block ${params.block_id} not found`);
          return successEnvelope({
            action,
            result: { success: true, id: params.block_id },
          });
        }
      }
    },
  });
}
