import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { createWorkspace, getWorkspace, listWorkspaces } from './db/queries/workspaces.js';
import {
  closeSession,
  createSession,
  getSessionResumeBundle,
  listSessions,
} from './db/queries/sessions.js';
import {
  appendPageBlocks,
  createPage,
  listPages,
} from './db/queries/pages.js';
import { search } from './db/queries/search.js';
import {
  claimTask,
  completeTask,
  createTask,
  failTask,
  handoffTask,
  heartbeatTask,
  listTasks,
} from './db/queries/tasks.js';
import {
  checkpointRun,
  completeRun,
  failRun,
  listRuns,
  startRun,
} from './db/queries/runs.js';

type JsonObject = Record<string, unknown>;

export interface DashboardApiRequest {
  body?: unknown;
  method: string;
  pathname: string;
  query: URLSearchParams;
}

export interface DashboardApiResponse {
  body: unknown;
  status: number;
}

export interface DashboardApiServer {
  close: () => Promise<void>;
  url: string;
}

const SystemAccess = { kind: 'system' as const };
const IdSchema = z.string().min(1);

const WorkspaceCreateSchema = z.object({
  description: z.string().optional(),
  icon: z.string().optional(),
  name: z.string().min(1),
});

const SessionCreateSchema = z.object({
  metadata: z.record(z.unknown()).optional(),
  summary: z.string().optional(),
  title: z.string().min(1).optional(),
  workspace_id: IdSchema,
});

const MemoryCreateSchema = z.object({
  content: z.string().min(1),
  page_id: IdSchema.optional(),
  session_id: IdSchema.optional(),
  tags: z.array(z.string()).optional(),
  title: z.string().min(1).optional(),
  workspace_id: IdSchema.optional(),
});

const TaskCreateSchema = z.object({
  created_by_agent_name: z.string().min(1).optional(),
  description: z.string().optional(),
  max_attempts: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
  owner_agent_name: z.string().min(1).optional(),
  priority: z.number().int().nonnegative().optional(),
  session_id: IdSchema.optional(),
  title: z.string().min(1),
  workspace_id: IdSchema,
});

const TaskAgentSchema = z.object({
  agent_name: z.string().min(1),
  lease_seconds: z.number().int().positive().max(86400).optional(),
  payload: z.record(z.unknown()).optional(),
});

const TaskFailSchema = TaskAgentSchema.extend({
  blocker_reason: z.string().optional(),
});

const TaskHandoffSchema = z.object({
  actor_agent_name: z.string().min(1).optional(),
  target_agent_name: z.string().min(1),
});

const RunCreateSchema = z.object({
  agent_name: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  parent_run_id: IdSchema.optional(),
  session_id: IdSchema.optional(),
  task_id: IdSchema.optional(),
  title: z.string().min(1).optional(),
  workspace_id: IdSchema,
});

const RunCheckpointSchema = z.object({
  agent_name: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  state: z.record(z.unknown()).optional(),
  summary: z.string().optional(),
});

const RunFinishSchema = z.object({
  agent_name: z.string().min(1),
  error_message: z.string().optional(),
  result: z.record(z.unknown()).optional(),
});

function ok(result: unknown, status = 200): DashboardApiResponse {
  return {
    body: {
      ok: true,
      result,
    },
    status,
  };
}

function fail(status: number, message: string): DashboardApiResponse {
  return {
    body: {
      error: { message },
      ok: false,
    },
    status,
  };
}

function parseBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
  return schema.parse(body ?? {});
}

function getRequiredQuery(query: URLSearchParams, name: string): string | DashboardApiResponse {
  const value = query.get(name);
  return value ? value : fail(400, `${name} is required`);
}

function queryNumber(query: URLSearchParams, name: string, fallback: number): number {
  const value = query.get(name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function taskStatuses(query: URLSearchParams): Array<'pending' | 'ready' | 'claimed' | 'blocked' | 'handoff_pending' | 'done' | 'failed' | 'cancelled'> | undefined {
  const raw = query.get('status');
  if (!raw) return undefined;
  return raw.split(',').map((status) => status.trim()).filter(Boolean) as ReturnType<typeof taskStatuses>;
}

function runStatuses(query: URLSearchParams): Array<'running' | 'completed' | 'failed' | 'cancelled'> | undefined {
  const raw = query.get('status');
  if (!raw) return undefined;
  return raw.split(',').map((status) => status.trim()).filter(Boolean) as ReturnType<typeof runStatuses>;
}

async function routeGet(request: DashboardApiRequest): Promise<DashboardApiResponse> {
  if (request.pathname === '/api/health') {
    return {
      body: {
        ok: true,
        service: 'horizonlayer-dashboard-api',
      },
      status: 200,
    };
  }

  if (request.pathname === '/api/workspaces') {
    return ok(await listWorkspaces(SystemAccess));
  }

  if (request.pathname === '/api/dashboard') {
    const workspaceId = getRequiredQuery(request.query, 'workspace_id');
    if (typeof workspaceId !== 'string') return workspaceId;
    const [workspace, sessions, pages, tasks, runs] = await Promise.all([
      getWorkspace(workspaceId, SystemAccess),
      listSessions({ workspace_id: workspaceId, limit: 20 }),
      listPages({ workspace_id: workspaceId, limit: 20 }),
      listTasks({ workspace_id: workspaceId, limit: 100 }),
      listRuns({ workspace_id: workspaceId, limit: 50 }),
    ]);
    return ok({ pages, runs, sessions, tasks, workspace });
  }

  if (request.pathname === '/api/sessions') {
    const workspaceId = getRequiredQuery(request.query, 'workspace_id');
    if (typeof workspaceId !== 'string') return workspaceId;
    return ok(await listSessions({
      limit: queryNumber(request.query, 'limit', 50),
      workspace_id: workspaceId,
    }));
  }

  if (request.pathname === '/api/memory') {
    const workspaceId = request.query.get('workspace_id') ?? undefined;
    const sessionId = request.query.get('session_id') ?? undefined;
    const query = request.query.get('query') ?? undefined;
    const limit = queryNumber(request.query, 'limit', 50);
    if (query) {
      return ok(await search({
        access: SystemAccess,
        content_types: ['pages'],
        limit,
        mode: 'hybrid',
        query,
        session_id: sessionId,
        workspace_id: workspaceId,
      }));
    }
    return ok(await listPages({ limit, session_id: sessionId, workspace_id: workspaceId }));
  }

  if (request.pathname === '/api/tasks') {
    const workspaceId = getRequiredQuery(request.query, 'workspace_id');
    if (typeof workspaceId !== 'string') return workspaceId;
    return ok(await listTasks({
      limit: queryNumber(request.query, 'limit', 100),
      session_id: request.query.get('session_id') ?? undefined,
      status: taskStatuses(request.query),
      workspace_id: workspaceId,
    }));
  }

  if (request.pathname === '/api/runs') {
    const workspaceId = getRequiredQuery(request.query, 'workspace_id');
    if (typeof workspaceId !== 'string') return workspaceId;
    return ok(await listRuns({
      limit: queryNumber(request.query, 'limit', 50),
      session_id: request.query.get('session_id') ?? undefined,
      status: runStatuses(request.query),
      workspace_id: workspaceId,
    }));
  }

  const resumeMatch = request.pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/);
  if (resumeMatch) {
    const bundle = await getSessionResumeBundle({
      access: SystemAccess,
      max_items: queryNumber(request.query, 'max_items', 20),
      session_id: resumeMatch[1],
      workspace_id: request.query.get('workspace_id') ?? undefined,
    });
    return bundle ? ok(bundle) : fail(404, `Session ${resumeMatch[1]} not found`);
  }

  return fail(404, 'Not found');
}

async function routePost(request: DashboardApiRequest): Promise<DashboardApiResponse> {
  if (request.pathname === '/api/workspaces') {
    const body = parseBody(WorkspaceCreateSchema, request.body);
    return ok(await createWorkspace(body.name, body.description, body.icon, undefined, SystemAccess), 201);
  }

  if (request.pathname === '/api/sessions') {
    const body = parseBody(SessionCreateSchema, request.body);
    return ok(await createSession({ ...body, access: SystemAccess }), 201);
  }

  if (request.pathname === '/api/memory') {
    const body = parseBody(MemoryCreateSchema, request.body);
    if (body.page_id) {
      const blocks = await appendPageBlocks(
        body.page_id,
        [{ block_type: 'text', content: body.content }],
        SystemAccess,
        undefined,
        body.session_id
      );
      return ok(blocks, 201);
    }
    if (!body.workspace_id) {
      return fail(400, 'workspace_id is required when page_id is not provided');
    }
    return ok(await createPage({
      access: SystemAccess,
      blocks: [{ block_type: 'text', content: body.content }],
      session_id: body.session_id,
      tags: body.tags,
      title: body.title ?? `Journal ${new Date().toISOString()}`,
      workspace_id: body.workspace_id,
    }), 201);
  }

  if (request.pathname === '/api/tasks') {
    const body = parseBody(TaskCreateSchema, request.body);
    return ok(await createTask({ ...body, access: SystemAccess }), 201);
  }

  if (request.pathname === '/api/runs') {
    const body = parseBody(RunCreateSchema, request.body);
    return ok(await startRun({ ...body, access: SystemAccess }), 201);
  }

  const sessionCloseMatch = request.pathname.match(/^\/api\/sessions\/([^/]+)\/close$/);
  if (sessionCloseMatch) {
    const session = await closeSession(sessionCloseMatch[1], SystemAccess);
    return session ? ok(session) : fail(404, `Session ${sessionCloseMatch[1]} not found`);
  }

  const taskActionMatch = request.pathname.match(/^\/api\/tasks\/([^/]+)\/(claim|heartbeat|complete|fail|handoff)$/);
  if (taskActionMatch) {
    const [, taskId, action] = taskActionMatch;
    if (action === 'claim') {
      const body = parseBody(TaskAgentSchema.extend({
        session_id: IdSchema.optional(),
        workspace_id: IdSchema,
      }), request.body);
      return ok(await claimTask({ ...body, access: SystemAccess, task_id: taskId }));
    }
    if (action === 'heartbeat') {
      const body = parseBody(TaskAgentSchema, request.body);
      return ok(await heartbeatTask({ ...body, access: SystemAccess, task_id: taskId }));
    }
    if (action === 'complete') {
      const body = parseBody(TaskAgentSchema, request.body);
      return ok(await completeTask({
        access: SystemAccess,
        agent_name: body.agent_name,
        payload: body.payload,
        task_id: taskId,
      }));
    }
    if (action === 'fail') {
      const body = parseBody(TaskFailSchema, request.body);
      return ok(await failTask({
        access: SystemAccess,
        agent_name: body.agent_name,
        blocker_reason: body.blocker_reason,
        payload: body.payload,
        task_id: taskId,
      }));
    }
    const body = parseBody(TaskHandoffSchema, request.body);
    return ok(await handoffTask({
      access: SystemAccess,
      actor_agent_name: body.actor_agent_name,
      target_agent_name: body.target_agent_name,
      task_id: taskId,
    }));
  }

  const runActionMatch = request.pathname.match(/^\/api\/runs\/([^/]+)\/(checkpoints|complete|fail)$/);
  if (runActionMatch) {
    const [, runId, action] = runActionMatch;
    if (action === 'checkpoints') {
      const body = parseBody(RunCheckpointSchema, request.body);
      return ok(await checkpointRun({ ...body, access: SystemAccess, run_id: runId }), 201);
    }
    const body = parseBody(RunFinishSchema, request.body);
    if (action === 'complete') {
      return ok(await completeRun({ ...body, access: SystemAccess, run_id: runId }));
    }
    return ok(await failRun({
      access: SystemAccess,
      agent_name: body.agent_name,
      error_message: body.error_message,
      result: body.result,
      run_id: runId,
    }));
  }

  return fail(404, 'Not found');
}

export async function executeDashboardApiRequest(request: DashboardApiRequest): Promise<DashboardApiResponse> {
  try {
    if (request.method === 'GET') {
      return await routeGet(request);
    }
    if (request.method === 'POST') {
      return await routePost(request);
    }
    return fail(405, 'Method not allowed');
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(400, error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    }
    const message = error instanceof Error ? error.message : 'Unknown dashboard API error';
    return fail(500, message);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) as JsonObject : undefined;
}

function writeJson(response: ServerResponse, payload: DashboardApiResponse): void {
  response.writeHead(payload.status, {
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Origin': 'http://localhost',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload.body));
}

export async function startDashboardApiServer(params: {
  host: string;
  port: number;
}): Promise<DashboardApiServer> {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        writeJson(response, { body: { ok: true }, status: 204 });
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${params.host}:${params.port}`}`);
      const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
      const payload = await executeDashboardApiRequest({
        body,
        method: request.method ?? 'GET',
        pathname: url.pathname,
        query: url.searchParams,
      });
      writeJson(response, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Dashboard API request failed';
      writeJson(response, fail(500, message));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(params.port, params.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    url: `http://${params.host}:${params.port}`,
  };
}
