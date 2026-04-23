import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type JsonObject = Record<string, unknown>;

type ToolEnvelope = {
  action: string;
  error: null | { message?: string };
  meta?: Record<string, unknown>;
  ok: boolean;
  result: unknown;
};

type ToolResponseLike = {
  content?: Array<{ text?: string; type?: string }>;
  isError?: boolean;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asRecord(value: unknown, message: string): JsonObject {
  assert(value != null && typeof value === 'object' && !Array.isArray(value), message);
  return value as JsonObject;
}

function asArray(value: unknown, message: string): unknown[] {
  assert(Array.isArray(value), message);
  return value;
}

function asString(value: unknown, message: string): string {
  assert(typeof value === 'string' && value.length > 0, message);
  return value;
}

function asNumber(value: unknown, message: string): number {
  assert(typeof value === 'number', message);
  return value;
}

function getString(record: JsonObject, key: string): string {
  return asString(record[key], `Expected ${key} to be a string`);
}

function parseToolEnvelope(name: string, result: unknown): ToolEnvelope {
  const response = result as ToolResponseLike;
  const text = response.content?.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error(`${name} result missing text content`);
  }

  let parsed: ToolEnvelope;
  try {
    parsed = JSON.parse(text) as ToolEnvelope;
  } catch {
    throw new Error(`${name} returned non-JSON text: ${text}`);
  }
  if (response.isError && parsed.ok) {
    parsed.ok = false;
  }
  return parsed;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolEnvelope> {
  const response = await client.callTool({
    name,
    arguments: args,
  });
  const envelope = parseToolEnvelope(name, response);
  if (!envelope.ok) {
    throw new Error(`${name}/${envelope.action} failed: ${envelope.error?.message ?? 'unknown error'}`);
  }
  return envelope;
}

async function safeDelete(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<void> {
  try {
    await client.callTool({ name, arguments: args });
  } catch {
    // ignore cleanup failures
  }
}

async function main(): Promise<void> {
  const mcpCommand = process.env.MCP_COMMAND ?? 'node';
  const mcpArgs = (process.env.MCP_ARGS ?? 'dist/launcher.js')
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
  const suffix = randomUUID().slice(0, 8);
  const client = new Client({ name: 'horizonlayer-agent-demo', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    args: mcpArgs,
    command: mcpCommand,
    cwd: process.cwd(),
    env: {
      ...process.env,
    } as Record<string, string>,
  });

  let workspaceId: string | null = null;
  let sessionId: string | null = null;
  let pageId: string | null = null;
  let taskId: string | null = null;
  let runId: string | null = null;

  try {
    await client.connect(transport);

    const workspaceCreate = await callTool(client, 'workspace', {
      action: 'create',
      name: `Agent Demo ${suffix}`,
      description: 'Canonical Horizon Layer MCP demo',
    });
    const workspaceRecord = asRecord(workspaceCreate.result, 'workspace/create result was not an object');
    workspaceId = getString(workspaceRecord, 'id');

    const sessionStart = await callTool(client, 'workspace', {
      action: 'start_session',
      workspace_id: workspaceId,
      title: 'Triage session',
      summary: 'Agent investigates a queue backlog and stores resumable state',
    });
    const sessionRecord = asRecord(sessionStart.result, 'workspace/start_session result was not an object');
    sessionId = getString(sessionRecord, 'id');

    const pageAppend = await callTool(client, 'page', {
      action: 'append_text',
      workspace_id: workspaceId,
      session_id: sessionId,
      title: 'Incident journal',
      content: 'Queue lag spiked after a deploy. One worker pool is stuck and retries are not draining the backlog.',
    });
    const pageRecord = asRecord(pageAppend.result, 'page/append_text result was not an object');
    pageId = getString(pageRecord, 'id');

    await callTool(client, 'page', {
      action: 'append_text',
      page_id: pageId,
      session_id: sessionId,
      content: 'Confirmed the backlog is localized to ingestion-worker-b. Restart is low risk if we verify queue drain after recovery.',
    });

    const taskCreate = await callTool(client, 'task', {
      action: 'create',
      workspace_id: workspaceId,
      session_id: sessionId,
      title: 'Restart ingestion-worker-b and verify queue drain',
      priority: 0,
      created_by_agent_name: 'planner',
      owner_agent_name: 'ops-agent',
    });
    const taskRecord = asRecord(taskCreate.result, 'task/create result was not an object');
    taskId = getString(taskRecord, 'id');

    const taskClaim = await callTool(client, 'task', {
      action: 'claim',
      workspace_id: workspaceId,
      session_id: sessionId,
      id: taskId,
      agent_name: 'ops-agent',
      lease_seconds: 300,
    });

    const runStart = await callTool(client, 'run', {
      action: 'start',
      workspace_id: workspaceId,
      session_id: sessionId,
      task_id: taskId,
      agent_name: 'ops-agent',
    });
    const runRecord = asRecord(runStart.result, 'run/start result was not an object');
    runId = getString(runRecord, 'id');

    await callTool(client, 'run', {
      action: 'checkpoint',
      id: runId,
      summary: 'Prepared restart plan and confirmed the target worker is isolated.',
      state: {
        next_step: 'restart worker and watch queue depth for recovery',
        worker: 'ingestion-worker-b',
      },
    });

    const searchResult = await callTool(client, 'search', {
      query: 'stuck ingestion worker backlog restart plan',
      workspace_id: workspaceId,
      session_id: sessionId,
      mode: 'hybrid',
      limit: 3,
    });
    const searchItems = asArray(searchResult.result, 'search result was not an array');
    const topHit = searchItems[0] ? asRecord(searchItems[0], 'top search hit was invalid') : null;

    await callTool(client, 'task', {
      action: 'complete',
      id: taskId,
      agent_name: 'ops-agent',
      payload: {
        outcome: 'restart completed and queue depth began to fall',
      },
    });

    await callTool(client, 'run', {
      action: 'complete',
      id: runId,
      result: {
        task_id: taskId,
        status: 'done',
        summary: 'Recovered the stuck worker and confirmed queue drain.',
      },
    });

    const resumeResult = await callTool(client, 'workspace', {
      action: 'resume_session_context',
      workspace_id: workspaceId,
      session_id: sessionId,
      max_items: 10,
      max_bytes: 32768,
    });
    const resumeBundle = asRecord(resumeResult.result, 'resume_session_context result was not an object');

    const summary = {
      workspace_id: workspaceId,
      session_id: sessionId,
      page_id: pageId,
      task_id: taskId,
      run_id: runId,
      claimed_task_status: getString(asRecord(taskClaim.result, 'task/claim result invalid'), 'status'),
      top_search_hit: topHit
        ? {
            id: getString(topHit, 'id'),
            title: getString(topHit, 'title'),
            score: asNumber(topHit.score, 'Expected top search hit score to be a number'),
            type: getString(topHit, 'type'),
          }
        : null,
      resume_bundle_sections: Object.keys(resumeBundle),
    };

    console.log('# Horizon Layer MCP Agent Demo');
    console.log('');
    console.log('This run exercised the core agent loop against the live MCP server:');
    console.log('1. create workspace');
    console.log('2. start session');
    console.log('3. write incident notes');
    console.log('4. create and claim a task');
    console.log('5. start and checkpoint a run');
    console.log('6. search prior context');
    console.log('7. complete task and run');
    console.log('8. resume the session context');
    console.log('');
    console.log('```json');
    console.log(JSON.stringify(summary, null, 2));
    console.log('```');
  } finally {
    if (runId) {
      await safeDelete(client, 'run', {
        action: 'cancel',
        id: runId,
      });
    }
    if (workspaceId) {
      await safeDelete(client, 'workspace', {
        action: 'delete',
        id: workspaceId,
      });
    }

    try {
      await client.close();
    } catch {
      // ignore close failures
    }
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Agent demo failed: ${message}`);
  process.exit(1);
});
