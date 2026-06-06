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
    return;
  }
}

async function main(): Promise<void> {
  const mcpCommand = process.env.MCP_COMMAND ?? 'node';
  const mcpArgs = (process.env.MCP_ARGS ?? 'dist/launcher.js')
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
  const suffix = randomUUID().slice(0, 8);
  const client = new Client({ name: 'horizonlayer-live-smoke', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    args: mcpArgs,
    command: mcpCommand,
    cwd: process.cwd(),
    env: {
      ...process.env,
    } as Record<string, string>,
  });

  let sessionId: string | null = null;

  const summary: JsonObject = {
    transport: {
      args: mcpArgs,
      command: mcpCommand,
    },
    suffix,
  };

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assert(
      JSON.stringify(toolNames) === JSON.stringify(['coordination', 'memory', 'session']),
      `Expected only core tools, got ${toolNames.join(', ')}`
    );
    summary.tools = toolNames;

    const sessionStart = await callTool(client, 'session', {
      action: 'start',
      workspace_name: `Smoke Workspace ${suffix}`,
      title: `Smoke Session ${suffix}`,
      summary: 'Live smoke test for the compact core MCP surface',
    });
    const sessionStartRecord = asRecord(sessionStart.result, 'session/start result was not an object');
    const workspaceRecord = asRecord(sessionStartRecord.workspace, 'session/start missing workspace');
    const sessionRecord = asRecord(sessionStartRecord.session, 'session/start missing session');
    const workspaceId = getString(workspaceRecord, 'id');
    sessionId = getString(sessionRecord, 'id');

    const memoryCreate = await callTool(client, 'memory', {
      action: 'append',
      workspace_id: workspaceId,
      session_id: sessionId,
      title: `Smoke Journal ${suffix}`,
      content: `Initial smoke test journal entry ${suffix}.`,
      tags: ['smoke'],
    });
    const memoryRecord = asRecord(memoryCreate.result, 'memory/append result was not an object');
    const pageId = getString(memoryRecord, 'id');

    const memoryAppend = await callTool(client, 'memory', {
      action: 'append',
      page_id: pageId,
      session_id: sessionId,
      content: `Follow-up smoke note ${suffix}.`,
    });

    const memorySearch = await callTool(client, 'memory', {
      action: 'search',
      workspace_id: workspaceId,
      session_id: sessionId,
      query: `smoke journal ${suffix}`,
      limit: 10,
    });
    const searchItems = asArray(memorySearch.result, 'memory/search result was not an array');
    assert(searchItems.length > 0, 'memory/search did not return the smoke note');

    const taskCreate = await callTool(client, 'coordination', {
      action: 'task_create',
      workspace_id: workspaceId,
      session_id: sessionId,
      title: `Smoke Task ${suffix}`,
      description: 'Primary live smoke task',
      owner_agent_name: 'agent-a',
      created_by_agent_name: 'smoke-suite',
      priority: 1,
    });
    const taskRecord = asRecord(taskCreate.result, 'coordination/task_create result was not an object');
    const taskId = getString(taskRecord, 'id');

    const taskList = await callTool(client, 'coordination', {
      action: 'task_list',
      workspace_id: workspaceId,
      session_id: sessionId,
      limit: 20,
    });
    const taskItems = asArray(taskList.result, 'coordination/task_list result was not an array');
    assert(
      taskItems.some((item) => getString(asRecord(item, 'coordination/task_list item invalid'), 'id') === taskId),
      'coordination/task_list did not include the created task'
    );

    const taskClaim = await callTool(client, 'coordination', {
      action: 'task_claim',
      workspace_id: workspaceId,
      session_id: sessionId,
      task_id: taskId,
      agent_name: 'agent-a',
      lease_seconds: 300,
    });

    const taskHeartbeat = await callTool(client, 'coordination', {
      action: 'task_heartbeat',
      task_id: taskId,
      agent_name: 'agent-a',
      lease_seconds: 300,
    });

    const runStart = await callTool(client, 'coordination', {
      action: 'run_start',
      workspace_id: workspaceId,
      session_id: sessionId,
      task_id: taskId,
      agent_name: 'agent-a',
      title: 'Smoke Run Complete',
    });
    const runRecord = asRecord(runStart.result, 'coordination/run_start result was not an object');
    const runId = getString(runRecord, 'id');

    const runCheckpoint = await callTool(client, 'coordination', {
      action: 'run_checkpoint',
      run_id: runId,
      agent_name: 'agent-a',
      summary: 'Checkpointed by smoke test',
      state: {
        phase: 'checkpoint',
      },
    });

    const runComplete = await callTool(client, 'coordination', {
      action: 'run_complete',
      run_id: runId,
      agent_name: 'agent-a',
      result: {
        status: 'ok',
      },
    });

    const taskComplete = await callTool(client, 'coordination', {
      action: 'task_complete',
      task_id: taskId,
      agent_name: 'agent-a',
      payload: {
        result: 'complete',
      },
    });

    const failTaskCreate = await callTool(client, 'coordination', {
      action: 'task_create',
      workspace_id: workspaceId,
      session_id: sessionId,
      title: `Smoke Fail Task ${suffix}`,
      created_by_agent_name: 'smoke-suite',
    });
    const failTaskId = getString(asRecord(failTaskCreate.result, 'coordination/task_create fail result invalid'), 'id');
    await callTool(client, 'coordination', {
      action: 'task_claim',
      workspace_id: workspaceId,
      session_id: sessionId,
      task_id: failTaskId,
      agent_name: 'agent-b',
      lease_seconds: 300,
    });
    const taskFail = await callTool(client, 'coordination', {
      action: 'task_fail',
      task_id: failTaskId,
      agent_name: 'agent-b',
      blocker_reason: 'smoke-fail',
    });

    const handoffTaskCreate = await callTool(client, 'coordination', {
      action: 'task_create',
      workspace_id: workspaceId,
      session_id: sessionId,
      title: `Smoke Handoff Task ${suffix}`,
      owner_agent_name: 'agent-c',
    });
    const handoffTaskId = getString(asRecord(handoffTaskCreate.result, 'coordination/task_create handoff result invalid'), 'id');
    const taskHandoff = await callTool(client, 'coordination', {
      action: 'task_handoff',
      task_id: handoffTaskId,
      agent_name: 'agent-c',
      target_agent_name: 'agent-d',
      payload: {
        handoff: 'ready for review',
      },
    });

    const failRunStart = await callTool(client, 'coordination', {
      action: 'run_start',
      workspace_id: workspaceId,
      session_id: sessionId,
      agent_name: 'agent-b',
      title: 'Smoke Run Fail',
    });
    const failRunId = getString(asRecord(failRunStart.result, 'coordination/run_start fail result invalid'), 'id');
    const runFail = await callTool(client, 'coordination', {
      action: 'run_fail',
      run_id: failRunId,
      agent_name: 'agent-b',
      error_message: 'smoke failure',
      result: {
        status: 'failed',
      },
    });

    const sessionResume = await callTool(client, 'session', {
      action: 'resume',
      workspace_id: workspaceId,
      session_id: sessionId,
      max_items: 10,
    });

    const sessionClose = await callTool(client, 'session', {
      action: 'close',
      session_id: sessionId,
    });
    sessionId = null;

    summary.session = {
      close: sessionClose.result,
      resume_sections: Object.keys(asRecord(sessionResume.result, 'session/resume result invalid')),
      start: sessionStart.result,
    };
    summary.memory = {
      append: memoryAppend.result,
      create: memoryRecord,
      search_count: searchItems.length,
    };
    summary.coordination = {
      run_checkpoint: runCheckpoint.result,
      run_complete: runComplete.result,
      run_fail: runFail.result,
      run_start: runRecord,
      task_claim: taskClaim.result,
      task_complete: taskComplete.result,
      task_fail: taskFail.result,
      task_handoff: taskHandoff.result,
      task_heartbeat: taskHeartbeat.result,
      task_list_count: taskItems.length,
    };

    console.log(JSON.stringify(summary, null, 2));
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
  console.error(`Live smoke failed: ${message}`);
  process.exit(1);
});
