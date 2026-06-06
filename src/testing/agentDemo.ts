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

async function safeCloseSession(client: Client, sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  try {
    await client.callTool({ name: 'session', arguments: { action: 'close', session_id: sessionId } });
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

  let sessionId: string | null = null;

  try {
    await client.connect(transport);

    const sessionStart = await callTool(client, 'session', {
      action: 'start',
      workspace_name: `Agent Demo ${suffix}`,
      title: 'Triage session',
      summary: 'Agent investigates a queue backlog and stores resumable state',
    });
    const sessionStartRecord = asRecord(sessionStart.result, 'session/start result was not an object');
    const workspaceRecord = asRecord(sessionStartRecord.workspace, 'session/start missing workspace');
    const sessionRecord = asRecord(sessionStartRecord.session, 'session/start missing session');
    const workspaceId = getString(workspaceRecord, 'id');
    sessionId = getString(sessionRecord, 'id');

    const firstMemory = await callTool(client, 'memory', {
      action: 'append',
      workspace_id: workspaceId,
      session_id: sessionId,
      title: 'Incident journal',
      content: 'Queue lag spiked after a deploy. One worker pool is stuck and retries are not draining the backlog.',
    });
    const pageRecord = asRecord(firstMemory.result, 'memory/append result was not an object');
    const pageId = getString(pageRecord, 'id');

    await callTool(client, 'memory', {
      action: 'append',
      page_id: pageId,
      session_id: sessionId,
      content: 'Confirmed the backlog is localized to ingestion-worker-b. Restart is low risk if queue drain is verified after recovery.',
    });

    const taskCreate = await callTool(client, 'coordination', {
      action: 'task_create',
      workspace_id: workspaceId,
      session_id: sessionId,
      title: 'Restart ingestion-worker-b and verify queue drain',
      priority: 0,
      created_by_agent_name: 'planner',
      owner_agent_name: 'ops-agent',
    });
    const taskRecord = asRecord(taskCreate.result, 'coordination/task_create result was not an object');
    const taskId = getString(taskRecord, 'id');

    const taskClaim = await callTool(client, 'coordination', {
      action: 'task_claim',
      workspace_id: workspaceId,
      session_id: sessionId,
      task_id: taskId,
      agent_name: 'ops-agent',
      lease_seconds: 300,
    });

    const runStart = await callTool(client, 'coordination', {
      action: 'run_start',
      workspace_id: workspaceId,
      session_id: sessionId,
      task_id: taskId,
      agent_name: 'ops-agent',
    });
    const runRecord = asRecord(runStart.result, 'coordination/run_start result was not an object');
    const runId = getString(runRecord, 'id');

    await callTool(client, 'coordination', {
      action: 'run_checkpoint',
      run_id: runId,
      agent_name: 'ops-agent',
      summary: 'Prepared restart plan and confirmed the target worker is isolated.',
      state: {
        next_step: 'restart worker and watch queue depth for recovery',
        worker: 'ingestion-worker-b',
      },
    });

    const searchResult = await callTool(client, 'memory', {
      action: 'search',
      query: 'stuck ingestion worker backlog restart plan',
      workspace_id: workspaceId,
      session_id: sessionId,
      limit: 3,
    });
    const searchItems = asArray(searchResult.result, 'memory/search result was not an array');
    const topHit = searchItems[0] ? asRecord(searchItems[0], 'top search hit was invalid') : null;

    await callTool(client, 'coordination', {
      action: 'task_complete',
      task_id: taskId,
      agent_name: 'ops-agent',
      payload: {
        outcome: 'restart completed and queue depth began to fall',
      },
    });

    await callTool(client, 'coordination', {
      action: 'run_complete',
      run_id: runId,
      agent_name: 'ops-agent',
      result: {
        task_id: taskId,
        status: 'done',
        summary: 'Recovered the stuck worker and confirmed queue drain.',
      },
    });

    const resumeResult = await callTool(client, 'session', {
      action: 'resume',
      workspace_id: workspaceId,
      session_id: sessionId,
      max_items: 10,
    });
    const resumeBundle = asRecord(resumeResult.result, 'session/resume result was not an object');

    const summary = {
      workspace_id: workspaceId,
      session_id: sessionId,
      page_id: pageId,
      task_id: taskId,
      run_id: runId,
      claimed_task_status: getString(asRecord(taskClaim.result, 'coordination/task_claim result invalid'), 'status'),
      top_search_hit: topHit
        ? {
            id: getString(topHit, 'id'),
            title: getString(topHit, 'title'),
            type: getString(topHit, 'type'),
          }
        : null,
      resume_bundle_sections: Object.keys(resumeBundle),
    };

    console.log('# Horizon Layer MCP Agent Demo');
    console.log('');
    console.log('This run exercised the compact core MCP surface:');
    console.log('1. start a session');
    console.log('2. write memory');
    console.log('3. create and claim a task');
    console.log('4. start and checkpoint a run');
    console.log('5. search prior context');
    console.log('6. complete task and run');
    console.log('7. resume the session context');
    console.log('');
    console.log('```json');
    console.log(JSON.stringify(summary, null, 2));
    console.log('```');
  } finally {
    await safeCloseSession(client, sessionId);

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
