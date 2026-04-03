import { z } from 'zod';
import type { AppServer } from '../mcp.js';
import {
  acknowledgeInboxItem,
  acknowledgeTask,
  appendTaskEvent,
  claimTask,
  completeTask,
  createTask,
  failTask,
  getTask,
  handoffTask,
  heartbeatTask,
  listInbox,
  listTasks,
} from '../db/queries/tasks.js';
import { accessFromSession, errorEnvelope, successEnvelope } from './common.js';

const TaskActionEnum = z.enum([
  'create',
  'get',
  'list',
  'claim',
  'heartbeat',
  'complete',
  'fail',
  'handoff',
  'ack',
  'append_event',
  'inbox_list',
  'inbox_ack',
]);
type TaskAction = z.infer<typeof TaskActionEnum>;

const TaskSchema = z.object({
  action: TaskActionEnum.describe('Task action to run'),
  id: z.string().uuid().optional().describe('Task ID for get/claim/heartbeat/complete/fail/handoff/ack/append_event'),
  workspace_id: z.string().uuid().optional().describe('Workspace ID for create/list/claim/inbox_list'),
  session_id: z.string().uuid().optional().describe('Optional session scope for create/list/claim'),
  inbox_id: z.string().uuid().optional().describe('Inbox item ID for inbox_ack'),
  title: z.string().min(1).max(500).optional().describe('Task title for create'),
  description: z.string().optional().describe('Task description for create'),
  priority: z.number().int().min(0).optional().describe('Task priority for create'),
  owner_agent_name: z.string().min(1).max(255).optional().describe('Initial task owner for create'),
  agent_name: z.string().min(1).max(255).optional().describe('Agent performing claim/heartbeat/ack/inbox actions'),
  created_by_agent_name: z.string().min(1).max(255).optional().describe('Agent creating the task'),
  target_agent_name: z.string().min(1).max(255).optional().describe('Target agent for handoff or append_event'),
  lease_seconds: z.number().int().positive().max(86400).optional().describe('Lease duration for claim/heartbeat'),
  max_attempts: z.number().int().min(0).optional().describe('Maximum task attempts for create'),
  unread_only: z.boolean().optional().describe('Inbox filter for unread items'),
  depends_on_task_ids: z.array(z.string().uuid()).optional().describe('Task IDs that must finish before this task is ready'),
  required_ack_agent_names: z.array(z.string().min(1).max(255)).optional().describe('Agents that must acknowledge before the task becomes ready'),
  require_ack: z.boolean().optional().describe('Whether handoff requires the target agent to acknowledge before the task becomes ready'),
  status: z.array(z.enum(['pending', 'ready', 'claimed', 'blocked', 'handoff_pending', 'done', 'failed', 'cancelled'])).optional().describe('Task status filters for list'),
  handoff_target_agent_name: z.string().min(1).max(255).optional().describe('Handoff target filter for list'),
  lease_owner_agent_name: z.string().min(1).max(255).optional().describe('Lease owner filter for list'),
  event_type: z.string().min(1).max(64).optional().describe('Event type for append_event'),
  blocker_reason: z.string().optional().describe('Failure reason for fail'),
  metadata: z.record(z.unknown()).optional().describe('Task metadata for create'),
  payload: z.record(z.unknown()).optional().describe('Structured payload for fail/handoff/ack/append_event'),
  limit: z.number().int().positive().max(500).optional().describe('Limit for list and inbox_list'),
  offset: z.number().int().min(0).optional().describe('Offset for list and inbox_list'),
}).strict();

export function registerTaskTools(server: AppServer): void {
  server.addTool({
    name: 'task',
    description: 'Task coordination actions with optional session scoping',
    parameters: TaskSchema,
    execute: async (params, context) => {
      try {
        const access = accessFromSession(context.session);
        const action: TaskAction = params.action;

        switch (action) {
          case 'create': {
            if (!params.workspace_id) return errorEnvelope(action, 'workspace_id is required for task action=create');
            if (!params.title) return errorEnvelope(action, 'title is required for task action=create');
            const task = await createTask({
              workspace_id: params.workspace_id,
              session_id: params.session_id,
              title: params.title,
              description: params.description,
              priority: params.priority,
              owner_agent_name: params.owner_agent_name,
              max_attempts: params.max_attempts,
              metadata: params.metadata,
              created_by_agent_name: params.created_by_agent_name,
              depends_on_task_ids: params.depends_on_task_ids,
              required_ack_agent_names: params.required_ack_agent_names,
              access,
            });
            return successEnvelope({ action, result: task });
          }

          case 'get': {
            if (!params.id) return errorEnvelope(action, 'id is required for task action=get');
            const task = await getTask(params.id, access);
            if (!task) return errorEnvelope(action, `Task ${params.id} not found`);
            return successEnvelope({ action, result: task });
          }

          case 'list': {
            if (!params.workspace_id) return errorEnvelope(action, 'workspace_id is required for task action=list');
            const limit = params.limit ?? 50;
            const offset = params.offset ?? 0;
            const tasks = await listTasks({
              workspace_id: params.workspace_id,
              session_id: params.session_id,
              status: params.status,
              owner_agent_name: params.owner_agent_name,
              handoff_target_agent_name: params.handoff_target_agent_name,
              lease_owner_agent_name: params.lease_owner_agent_name,
              limit,
              offset,
              access,
            });
            return successEnvelope({
              action,
              result: tasks,
              meta: { limit, offset },
            });
          }

          case 'claim': {
            if (!params.workspace_id) return errorEnvelope(action, 'workspace_id is required for task action=claim');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for task action=claim');
            const task = await claimTask({
              workspace_id: params.workspace_id,
              session_id: params.session_id,
              agent_name: params.agent_name,
              task_id: params.id,
              lease_seconds: params.lease_seconds,
              access,
            });
            if (!task) return errorEnvelope(action, 'No claimable task found');
            return successEnvelope({ action, result: task });
          }

          case 'heartbeat': {
            if (!params.id) return errorEnvelope(action, 'id is required for task action=heartbeat');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for task action=heartbeat');
            const task = await heartbeatTask({
              task_id: params.id,
              agent_name: params.agent_name,
              lease_seconds: params.lease_seconds,
              access,
            });
            if (!task) return errorEnvelope(action, `Task ${params.id} is not actively leased by ${params.agent_name}`);
            return successEnvelope({ action, result: task });
          }

          case 'complete': {
            if (!params.id) return errorEnvelope(action, 'id is required for task action=complete');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for task action=complete');
            const task = await completeTask({
              task_id: params.id,
              agent_name: params.agent_name,
              payload: params.payload,
              access,
            });
            if (!task) return errorEnvelope(action, `Task ${params.id} not found`);
            return successEnvelope({ action, result: task });
          }

          case 'fail': {
            if (!params.id) return errorEnvelope(action, 'id is required for task action=fail');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for task action=fail');
            const task = await failTask({
              task_id: params.id,
              agent_name: params.agent_name,
              blocker_reason: params.blocker_reason,
              payload: params.payload,
              access,
            });
            if (!task) return errorEnvelope(action, `Task ${params.id} not found`);
            return successEnvelope({ action, result: task });
          }

          case 'handoff': {
            if (!params.id) return errorEnvelope(action, 'id is required for task action=handoff');
            if (!params.target_agent_name) return errorEnvelope(action, 'target_agent_name is required for task action=handoff');
            const task = await handoffTask({
              task_id: params.id,
              actor_agent_name: params.agent_name,
              target_agent_name: params.target_agent_name,
              require_ack: params.require_ack,
              payload: params.payload,
              access,
            });
            if (!task) return errorEnvelope(action, `Task ${params.id} not found`);
            return successEnvelope({ action, result: task });
          }

          case 'ack': {
            if (!params.id) return errorEnvelope(action, 'id is required for task action=ack');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for task action=ack');
            const task = await acknowledgeTask({
              task_id: params.id,
              agent_name: params.agent_name,
              payload: params.payload,
              access,
            });
            if (!task) return errorEnvelope(action, `Task ${params.id} not found`);
            return successEnvelope({ action, result: task });
          }

          case 'append_event': {
            if (!params.id) return errorEnvelope(action, 'id is required for task action=append_event');
            if (!params.event_type) return errorEnvelope(action, 'event_type is required for task action=append_event');
            const event = await appendTaskEvent({
              task_id: params.id,
              event_type: params.event_type,
              actor_agent_name: params.agent_name,
              target_agent_name: params.target_agent_name,
              payload: params.payload,
              access,
            });
            return successEnvelope({ action, result: event });
          }

          case 'inbox_list': {
            if (!params.workspace_id) return errorEnvelope(action, 'workspace_id is required for task action=inbox_list');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for task action=inbox_list');
            const limit = params.limit ?? 50;
            const offset = params.offset ?? 0;
            const items = await listInbox({
              workspace_id: params.workspace_id,
              agent_name: params.agent_name,
              unread_only: params.unread_only,
              limit,
              offset,
              access,
            });
            return successEnvelope({
              action,
              result: items,
              meta: { limit, offset },
            });
          }

          case 'inbox_ack': {
            if (!params.inbox_id) return errorEnvelope(action, 'inbox_id is required for task action=inbox_ack');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for task action=inbox_ack');
            const item = await acknowledgeInboxItem({
              id: params.inbox_id,
              agent_name: params.agent_name,
              access,
            });
            if (!item) return errorEnvelope(action, `Inbox item ${params.inbox_id} not found`);
            return successEnvelope({ action, result: item });
          }
        }
      } catch (err) {
        return errorEnvelope('task', err instanceof Error ? err.message : String(err));
      }
    },
  });
}
