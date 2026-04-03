import { z } from 'zod';
import type { AppServer } from '../mcp.js';
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
} from '../db/queries/workspaces.js';
import {
  closeSession,
  createSession,
  getSession,
  getSessionResumeBundle,
  listSessions,
} from '../db/queries/sessions.js';
import { accessFromSession, errorEnvelope, successEnvelope } from './common.js';

const WorkspaceActionEnum = z.enum([
  'create',
  'create_session',
  'list',
  'get',
  'update',
  'delete',
  'start_session',
  'list_sessions',
  'get_session',
  'resume_session_context',
  'close_session',
]);
type WorkspaceAction = z.infer<typeof WorkspaceActionEnum>;

const WorkspaceSchema = z.object({
  action: WorkspaceActionEnum.describe('Workspace action to run'),
  id: z.string().uuid().optional().describe('Workspace ID for get/update/delete'),
  workspace_id: z.string().uuid().optional().describe('Workspace ID for session actions'),
  session_id: z.string().uuid().optional().describe('Session ID for get_session/resume_session_context/close_session'),
  name: z.string().min(1).max(500).optional().describe('Workspace name for create/update/create_session'),
  title: z.string().min(1).max(500).optional().describe('Session title for start_session/create_session'),
  description: z.string().optional().describe('Workspace description for create/update/create_session'),
  icon: z.string().max(100).optional().describe('Workspace icon for create/update/create_session'),
  summary: z.string().optional().describe('Session summary for start_session/create_session'),
  metadata: z.record(z.unknown()).optional().describe('Session metadata for start_session/create_session'),
  expected_updated_at: z.string().datetime().optional().describe('Optimistic concurrency precondition for update/delete'),
  expires_in_days: z.number().positive().optional().describe('Days until the workspace expires'),
  limit: z.number().int().positive().max(500).optional().describe('Limit for list/list_sessions'),
  offset: z.number().int().min(0).optional().describe('Offset for list/list_sessions'),
  max_items: z.number().int().positive().max(100).optional().describe('Per-section limit for resume_session_context'),
  max_bytes: z.number().int().positive().max(1_000_000).optional().describe('Maximum inline payload size for resume_session_context'),
}).strict();

export function registerWorkspaceTools(server: AppServer): void {
  server.addTool({
    name: 'workspace',
    description: 'Workspace and workspace-scoped session actions',
    parameters: WorkspaceSchema,
    execute: async (params, context) => {
      const access = accessFromSession(context.session);
      const action: WorkspaceAction = params.action;

      switch (action) {
        case 'create': {
          if (!params.name) return errorEnvelope(action, 'name is required for workspace action=create');
          const workspace = await createWorkspace(
            params.name,
            params.description,
            params.icon,
            params.expires_in_days,
            access
          );
          return successEnvelope({ action, result: workspace });
        }

        case 'create_session': {
          const workspaceName = params.name ?? `workspace-${new Date().toISOString()}`;
          const workspace = await createWorkspace(
            workspaceName,
            params.description,
            params.icon,
            params.expires_in_days,
            access
          );
          const session = await createSession({
            workspace_id: workspace.id,
            title: params.title ?? 'Initial session',
            summary: params.summary,
            metadata: params.metadata,
            access,
          });
          return successEnvelope({
            action,
            result: {
              workspace,
              session,
            },
          });
        }

        case 'list': {
          const limit = params.limit ?? 50;
          const offset = params.offset ?? 0;
          const workspaces = await listWorkspaces(access);
          return successEnvelope({
            action,
            result: workspaces.slice(offset, offset + limit),
            meta: { limit, offset, total: workspaces.length },
          });
        }

        case 'get': {
          if (!params.id) return errorEnvelope(action, 'id is required for workspace action=get');
          const workspace = await getWorkspace(params.id, access);
          if (!workspace) return errorEnvelope(action, `Workspace ${params.id} not found`);
          return successEnvelope({ action, result: workspace });
        }

        case 'update': {
          if (!params.id) return errorEnvelope(action, 'id is required for workspace action=update');
          const workspace = await updateWorkspace(
            params.id,
            {
              name: params.name,
              description: params.description,
              icon: params.icon,
              expected_updated_at: params.expected_updated_at,
              expires_in_days: params.expires_in_days,
            },
            access
          );
          if (!workspace) return errorEnvelope(action, `Workspace ${params.id} not found`);
          return successEnvelope({ action, result: workspace });
        }

        case 'delete': {
          if (!params.id) return errorEnvelope(action, 'id is required for workspace action=delete');
          const deleted = await deleteWorkspace(params.id, access, params.expected_updated_at);
          if (!deleted) return errorEnvelope(action, `Workspace ${params.id} not found`);
          return successEnvelope({
            action,
            result: { success: true, id: params.id },
          });
        }

        case 'start_session': {
          if (!params.workspace_id) {
            return errorEnvelope(action, 'workspace_id is required for workspace action=start_session');
          }
          const session = await createSession({
            workspace_id: params.workspace_id,
            title: params.title,
            summary: params.summary,
            metadata: params.metadata,
            access,
          });
          return successEnvelope({ action, result: session });
        }

        case 'list_sessions': {
          if (!params.workspace_id) {
            return errorEnvelope(action, 'workspace_id is required for workspace action=list_sessions');
          }
          const limit = params.limit ?? 50;
          const offset = params.offset ?? 0;
          const sessions = await listSessions({
            workspace_id: params.workspace_id,
            limit,
            offset,
            access,
          });
          return successEnvelope({
            action,
            result: sessions,
            meta: { limit, offset },
          });
        }

        case 'get_session': {
          if (!params.session_id) {
            return errorEnvelope(action, 'session_id is required for workspace action=get_session');
          }
          const session = await getSession(params.session_id, {
            workspace_id: params.workspace_id,
            access,
          });
          if (!session) {
            return errorEnvelope(action, `Session ${params.session_id} not found`);
          }
          return successEnvelope({ action, result: session });
        }

        case 'resume_session_context': {
          if (!params.session_id) {
            return errorEnvelope(action, 'session_id is required for workspace action=resume_session_context');
          }
          const bundle = await getSessionResumeBundle({
            session_id: params.session_id,
            workspace_id: params.workspace_id,
            max_items: params.max_items,
            max_bytes: params.max_bytes,
            access,
          });
          if (!bundle) {
            return errorEnvelope(action, `Session ${params.session_id} not found`);
          }
          return successEnvelope({ action, result: bundle });
        }

        case 'close_session': {
          if (!params.session_id) {
            return errorEnvelope(action, 'session_id is required for workspace action=close_session');
          }
          const session = await closeSession(params.session_id, access);
          if (!session) {
            return errorEnvelope(action, `Session ${params.session_id} not found`);
          }
          return successEnvelope({ action, result: session });
        }
      }
    },
  });
}
