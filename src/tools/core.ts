import { z } from 'zod';
import type { AppServer } from '../mcp.js';
import { createWorkspace } from '../db/queries/workspaces.js';
import {
  closeSession,
  createSession,
  getSessionResumeBundle,
} from '../db/queries/sessions.js';
import {
  appendPageBlocks,
  createPage,
} from '../db/queries/pages.js';
import { search } from '../db/queries/search.js';
import {
  claimTask,
  completeTask,
  createTask,
  failTask,
  handoffTask,
  heartbeatTask,
  listTasks,
} from '../db/queries/tasks.js';
import {
  checkpointRun,
  completeRun,
  failRun,
  startRun,
} from '../db/queries/runs.js';
import { accessFromSession, errorEnvelope, errorEnvelopeFromUnknown, successEnvelope } from './common.js';

const SessionActionEnum = z.enum(['start', 'resume', 'close']);

const SessionSchema = z.object({
  action: SessionActionEnum.describe('Session action to run'),
  workspace_id: z.string().uuid().optional().describe('Existing workspace ID for action=start/resume'),
  workspace_name: z.string().min(1).max(500).optional().describe('Workspace name to create when workspace_id is omitted'),
  session_id: z.string().uuid().optional().describe('Session ID for action=resume/close'),
  title: z.string().min(1).max(500).optional().describe('Session title for action=start'),
  summary: z.string().optional().describe('Session summary for action=start'),
  max_items: z.number().int().positive().max(100).optional().describe('Per-section limit for action=resume'),
}).strict();

const MemoryActionEnum = z.enum(['append', 'search']);

const MemorySchema = z.object({
  action: MemoryActionEnum.describe('Memory action to run'),
  workspace_id: z.string().uuid().optional().describe('Workspace scope'),
  session_id: z.string().uuid().optional().describe('Optional session scope'),
  page_id: z.string().uuid().optional().describe('Existing page to append to'),
  title: z.string().min(1).max(500).optional().describe('Page title when appending without page_id'),
  content: z.string().optional().describe('Text to store for action=append'),
  query: z.string().min(1).optional().describe('Search query for action=search'),
  tags: z.array(z.string()).optional().describe('Tags for append or search filtering'),
  limit: z.number().int().positive().max(100).optional().describe('Result limit for search'),
}).strict();

const CoordinationActionEnum = z.enum([
  'task_create',
  'task_list',
  'task_claim',
  'task_heartbeat',
  'task_complete',
  'task_fail',
  'task_handoff',
  'run_start',
  'run_checkpoint',
  'run_complete',
  'run_fail',
]);

const CoordinationSchema = z.object({
  action: CoordinationActionEnum.describe('Coordination action to run'),
  workspace_id: z.string().uuid().optional().describe('Workspace scope'),
  session_id: z.string().uuid().optional().describe('Optional session scope'),
  task_id: z.string().uuid().optional().describe('Task ID for task/run actions'),
  run_id: z.string().uuid().optional().describe('Run ID for run actions'),
  title: z.string().min(1).max(500).optional().describe('Task or run title'),
  description: z.string().optional().describe('Task description'),
  priority: z.number().int().min(0).optional().describe('Task priority'),
  owner_agent_name: z.string().min(1).max(255).optional().describe('Initial task owner'),
  created_by_agent_name: z.string().min(1).max(255).optional().describe('Agent creating a task'),
  agent_name: z.string().min(1).max(255).optional().describe('Agent performing the action'),
  target_agent_name: z.string().min(1).max(255).optional().describe('Handoff target agent'),
  lease_seconds: z.number().int().positive().max(86400).optional().describe('Lease duration for task claims/heartbeats'),
  status: z.array(z.enum(['pending', 'ready', 'claimed', 'blocked', 'handoff_pending', 'done', 'failed', 'cancelled'])).optional().describe('Task status filters'),
  payload: z.record(z.unknown()).optional().describe('Structured task payload'),
  blocker_reason: z.string().optional().describe('Failure or blocker reason'),
  summary: z.string().optional().describe('Checkpoint summary'),
  state: z.record(z.unknown()).optional().describe('Checkpoint state'),
  result: z.record(z.unknown()).optional().describe('Run completion/failure result'),
  error_message: z.string().optional().describe('Run failure message'),
  limit: z.number().int().positive().max(500).optional().describe('List limit'),
}).strict();

function textBlocks(content: string) {
  return [{ block_type: 'text' as const, content }];
}

export function registerCoreTools(server: AppServer): void {
  server.addTool({
    name: 'session',
    description: 'Core session lifecycle: start, resume, and close agent work',
    parameters: SessionSchema,
    execute: async (params, context) => {
      const action = params.action;
      try {
        const access = accessFromSession(context.session);

        switch (action) {
          case 'start': {
            if (params.workspace_id) {
              const session = await createSession({
                workspace_id: params.workspace_id,
                title: params.title,
                summary: params.summary,
                access,
              });
              return successEnvelope({ action, result: { session } });
            }

            const workspace = await createWorkspace(
              params.workspace_name ?? `workspace-${new Date().toISOString()}`,
              undefined,
              undefined,
              undefined,
              access
            );
            const session = await createSession({
              workspace_id: workspace.id,
              title: params.title,
              summary: params.summary,
              access,
            });
            return successEnvelope({ action, result: { workspace, session } });
          }

          case 'resume': {
            if (!params.session_id) return errorEnvelope(action, 'session_id is required for session action=resume');
            const bundle = await getSessionResumeBundle({
              session_id: params.session_id,
              workspace_id: params.workspace_id,
              max_items: params.max_items,
              access,
            });
            if (!bundle) return errorEnvelope(action, `Session ${params.session_id} not found`);
            return successEnvelope({ action, result: bundle });
          }

          case 'close': {
            if (!params.session_id) return errorEnvelope(action, 'session_id is required for session action=close');
            const session = await closeSession(params.session_id, access);
            if (!session) return errorEnvelope(action, `Session ${params.session_id} not found`);
            return successEnvelope({ action, result: session });
          }
        }
      } catch (error) {
        return errorEnvelopeFromUnknown(action, error);
      }
    },
  });

  server.addTool({
    name: 'memory',
    description: 'Core memory actions: append concise notes and search stored context',
    parameters: MemorySchema,
    execute: async (params, context) => {
      const action = params.action;
      try {
        const access = accessFromSession(context.session);

        switch (action) {
          case 'append': {
            if (!params.content) return errorEnvelope(action, 'content is required for memory action=append');
            if (params.page_id) {
              const blocks = await appendPageBlocks(
                params.page_id,
                textBlocks(params.content),
                access,
                undefined,
                params.session_id
              );
              return successEnvelope({ action, result: blocks });
            }
            if (!params.workspace_id) {
              return errorEnvelope(action, 'workspace_id is required when memory action=append does not target page_id');
            }
            const page = await createPage({
              title: params.title ?? `Journal ${new Date().toISOString()}`,
              workspace_id: params.workspace_id,
              session_id: params.session_id,
              tags: params.tags,
              blocks: textBlocks(params.content),
              access,
            });
            return successEnvelope({ action, result: page });
          }

          case 'search': {
            const query = params.query;
            if (!query) return errorEnvelope(action, 'query is required for memory action=search');
            const limit = params.limit ?? 20;
            const results = await search({
              query,
              mode: 'hybrid',
              content_types: ['pages'],
              workspace_id: params.workspace_id,
              session_id: params.session_id,
              tags: params.tags,
              limit,
              access,
            });
            return successEnvelope({
              action,
              result: results,
              meta: { limit, total_available: results.length },
            });
          }
        }
      } catch (error) {
        return errorEnvelopeFromUnknown(action, error);
      }
    },
  });

  server.addTool({
    name: 'coordination',
    description: 'Core task and run coordination with leases, handoffs, and checkpoints',
    parameters: CoordinationSchema,
    execute: async (params, context) => {
      const action = params.action;
      try {
        const access = accessFromSession(context.session);

        switch (action) {
          case 'task_create': {
            if (!params.workspace_id) return errorEnvelope(action, 'workspace_id is required for coordination action=task_create');
            if (!params.title) return errorEnvelope(action, 'title is required for coordination action=task_create');
            const task = await createTask({
              workspace_id: params.workspace_id,
              session_id: params.session_id,
              title: params.title,
              description: params.description,
              priority: params.priority,
              owner_agent_name: params.owner_agent_name,
              created_by_agent_name: params.created_by_agent_name,
              access,
            });
            return successEnvelope({ action, result: task });
          }

          case 'task_list': {
            if (!params.workspace_id) return errorEnvelope(action, 'workspace_id is required for coordination action=task_list');
            const limit = params.limit ?? 50;
            const tasks = await listTasks({
              workspace_id: params.workspace_id,
              session_id: params.session_id,
              status: params.status,
              owner_agent_name: params.owner_agent_name,
              limit,
              offset: 0,
              access,
            });
            return successEnvelope({ action, result: tasks, meta: { limit } });
          }

          case 'task_claim': {
            if (!params.workspace_id) return errorEnvelope(action, 'workspace_id is required for coordination action=task_claim');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for coordination action=task_claim');
            const task = await claimTask({
              workspace_id: params.workspace_id,
              session_id: params.session_id,
              agent_name: params.agent_name,
              task_id: params.task_id,
              lease_seconds: params.lease_seconds,
              access,
            });
            if (!task) return errorEnvelope(action, 'No claimable task found');
            return successEnvelope({ action, result: task });
          }

          case 'task_heartbeat': {
            if (!params.task_id) return errorEnvelope(action, 'task_id is required for coordination action=task_heartbeat');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for coordination action=task_heartbeat');
            const task = await heartbeatTask({
              task_id: params.task_id,
              agent_name: params.agent_name,
              lease_seconds: params.lease_seconds,
              access,
            });
            if (!task) return errorEnvelope(action, `Task ${params.task_id} is not actively leased by ${params.agent_name}`);
            return successEnvelope({ action, result: task });
          }

          case 'task_complete': {
            if (!params.task_id) return errorEnvelope(action, 'task_id is required for coordination action=task_complete');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for coordination action=task_complete');
            const task = await completeTask({
              task_id: params.task_id,
              agent_name: params.agent_name,
              payload: params.payload,
              access,
            });
            if (!task) return errorEnvelope(action, `Task ${params.task_id} not found`);
            return successEnvelope({ action, result: task });
          }

          case 'task_fail': {
            if (!params.task_id) return errorEnvelope(action, 'task_id is required for coordination action=task_fail');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for coordination action=task_fail');
            const task = await failTask({
              task_id: params.task_id,
              agent_name: params.agent_name,
              blocker_reason: params.blocker_reason,
              payload: params.payload,
              access,
            });
            if (!task) return errorEnvelope(action, `Task ${params.task_id} not found`);
            return successEnvelope({ action, result: task });
          }

          case 'task_handoff': {
            if (!params.task_id) return errorEnvelope(action, 'task_id is required for coordination action=task_handoff');
            if (!params.target_agent_name) return errorEnvelope(action, 'target_agent_name is required for coordination action=task_handoff');
            const task = await handoffTask({
              task_id: params.task_id,
              actor_agent_name: params.agent_name,
              target_agent_name: params.target_agent_name,
              payload: params.payload,
              access,
            });
            if (!task) return errorEnvelope(action, `Task ${params.task_id} not found`);
            return successEnvelope({ action, result: task });
          }

          case 'run_start': {
            if (!params.workspace_id) return errorEnvelope(action, 'workspace_id is required for coordination action=run_start');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for coordination action=run_start');
            const run = await startRun({
              workspace_id: params.workspace_id,
              session_id: params.session_id,
              task_id: params.task_id,
              agent_name: params.agent_name,
              title: params.title,
              access,
            });
            return successEnvelope({ action, result: run });
          }

          case 'run_checkpoint': {
            if (!params.run_id) return errorEnvelope(action, 'run_id is required for coordination action=run_checkpoint');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for coordination action=run_checkpoint');
            const run = await checkpointRun({
              run_id: params.run_id,
              agent_name: params.agent_name,
              summary: params.summary,
              state: params.state,
              access,
            });
            if (!run) return errorEnvelope(action, `Run ${params.run_id} not found`);
            return successEnvelope({ action, result: run });
          }

          case 'run_complete': {
            if (!params.run_id) return errorEnvelope(action, 'run_id is required for coordination action=run_complete');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for coordination action=run_complete');
            const run = await completeRun({
              run_id: params.run_id,
              agent_name: params.agent_name,
              result: params.result,
              access,
            });
            if (!run) return errorEnvelope(action, `Run ${params.run_id} not found`);
            return successEnvelope({ action, result: run });
          }

          case 'run_fail': {
            if (!params.run_id) return errorEnvelope(action, 'run_id is required for coordination action=run_fail');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for coordination action=run_fail');
            const run = await failRun({
              run_id: params.run_id,
              agent_name: params.agent_name,
              result: params.result,
              error_message: params.error_message,
              access,
            });
            if (!run) return errorEnvelope(action, `Run ${params.run_id} not found`);
            return successEnvelope({ action, result: run });
          }
        }
      } catch (error) {
        return errorEnvelopeFromUnknown(action, error);
      }
    },
  });
}
