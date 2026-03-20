import { z } from 'zod';
import type { AppServer } from '../mcp.js';
import {
  cancelRun,
  checkpointRun,
  completeRun,
  failRun,
  getRun,
  listRuns,
  startRun,
} from '../db/queries/runs.js';
import { accessFromSession, errorEnvelope, successEnvelope } from './common.js';

const RunActionEnum = z.enum([
  'start',
  'get',
  'list',
  'checkpoint',
  'complete',
  'fail',
  'cancel',
]);
type RunAction = z.infer<typeof RunActionEnum>;

const RunSchema = z.object({
  action: RunActionEnum.describe('Run action to run'),
  id: z.string().uuid().optional().describe('Run ID for get/checkpoint/complete/fail/cancel'),
  workspace_id: z.string().uuid().optional().describe('Workspace ID for start/list'),
  session_id: z.string().uuid().optional().describe('Optional session scope for start/list/get'),
  task_id: z.string().uuid().optional().describe('Optional task ID for start/list filtering'),
  parent_run_id: z.string().uuid().optional().describe('Optional parent run ID for start'),
  agent_name: z.string().min(1).max(255).optional().describe('Agent name for start/list'),
  title: z.string().max(500).optional().describe('Run title for start'),
  summary: z.string().optional().describe('Checkpoint summary'),
  metadata: z.record(z.unknown()).optional().describe('Run or checkpoint metadata'),
  state: z.record(z.unknown()).optional().describe('Checkpoint state payload'),
  result: z.record(z.unknown()).optional().describe('Completion or failure result payload'),
  error_message: z.string().optional().describe('Failure message'),
  status: z.array(z.enum(['running', 'completed', 'failed', 'cancelled'])).optional().describe('Run status filters for list'),
  limit: z.number().int().positive().max(500).optional().describe('Limit for list'),
  offset: z.number().int().min(0).optional().describe('Offset for list'),
}).strict();

export function registerRunTools(server: AppServer): void {
  server.addTool({
    name: 'run',
    description: 'Run lifecycle actions with optional session scoping',
    parameters: RunSchema,
    execute: async (params, context) => {
      try {
        const access = accessFromSession(context.session);
        const action: RunAction = params.action;

        switch (action) {
          case 'start': {
            if (!params.workspace_id) return errorEnvelope(action, 'workspace_id is required for run action=start');
            if (!params.agent_name) return errorEnvelope(action, 'agent_name is required for run action=start');
            const run = await startRun({
              workspace_id: params.workspace_id,
              session_id: params.session_id,
              task_id: params.task_id,
              parent_run_id: params.parent_run_id,
              agent_name: params.agent_name,
              title: params.title,
              metadata: params.metadata,
              access,
            });
            return successEnvelope({ action, result: run });
          }

          case 'get': {
            if (!params.id) return errorEnvelope(action, 'id is required for run action=get');
            const run = await getRun(params.id, access, params.session_id);
            if (!run) return errorEnvelope(action, `Run ${params.id} not found`);
            return successEnvelope({ action, result: run });
          }

          case 'list': {
            if (!params.workspace_id) return errorEnvelope(action, 'workspace_id is required for run action=list');
            const limit = params.limit ?? 50;
            const offset = params.offset ?? 0;
            const runs = await listRuns({
              workspace_id: params.workspace_id,
              session_id: params.session_id,
              task_id: params.task_id,
              agent_name: params.agent_name,
              status: params.status,
              limit,
              offset,
              access,
            });
            return successEnvelope({
              action,
              result: runs,
              meta: { limit, offset },
            });
          }

          case 'checkpoint': {
            if (!params.id) return errorEnvelope(action, 'id is required for run action=checkpoint');
            const run = await checkpointRun({
              run_id: params.id,
              summary: params.summary,
              state: params.state,
              metadata: params.metadata,
              access,
            });
            if (!run) return errorEnvelope(action, `Run ${params.id} not found`);
            return successEnvelope({ action, result: run });
          }

          case 'complete': {
            if (!params.id) return errorEnvelope(action, 'id is required for run action=complete');
            const run = await completeRun({
              run_id: params.id,
              result: params.result,
              access,
            });
            if (!run) return errorEnvelope(action, `Run ${params.id} not found`);
            return successEnvelope({ action, result: run });
          }

          case 'fail': {
            if (!params.id) return errorEnvelope(action, 'id is required for run action=fail');
            const run = await failRun({
              run_id: params.id,
              result: params.result,
              error_message: params.error_message,
              access,
            });
            if (!run) return errorEnvelope(action, `Run ${params.id} not found`);
            return successEnvelope({ action, result: run });
          }

          case 'cancel': {
            if (!params.id) return errorEnvelope(action, 'id is required for run action=cancel');
            const run = await cancelRun({
              run_id: params.id,
              result: params.result,
              access,
            });
            if (!run) return errorEnvelope(action, `Run ${params.id} not found`);
            return successEnvelope({ action, result: run });
          }
        }
      } catch (err) {
        return errorEnvelope('run', err instanceof Error ? err.message : String(err));
      }
    },
  });
}
