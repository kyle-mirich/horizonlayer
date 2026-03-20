import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

function parseToolEnvelope(result: unknown): ToolEnvelope {
  const response = result as ToolResponseLike;
  const text = response.content?.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error('Tool result missing text content');
  }

  const parsed = JSON.parse(text) as ToolEnvelope;
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
  const envelope = parseToolEnvelope(response);
  if (!envelope.ok) {
    throw new Error(`${name}/${envelope.action} failed: ${envelope.error?.message ?? 'unknown error'}`);
  }
  return envelope;
}

async function safeCallTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<void> {
  try {
    await client.callTool({
      name,
      arguments: args,
    });
  } catch {
    return;
  }
}

async function main(): Promise<void> {
  const mcpUrl = process.env.MCP_URL ?? 'http://127.0.0.1:3000/mcp';
  const suffix = randomUUID().slice(0, 8);
  const client = new Client({ name: 'horizon-layer-live-smoke', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

  let workspaceId: string | null = null;
  let sessionId: string | null = null;
  let compatibilityWorkspaceId: string | null = null;
  let pageId: string | null = null;
  let initialBlockId: string | null = null;
  let appendedBlockId: string | null = null;
  let databaseId: string | null = null;
  let rowId: string | null = null;
  let linkId: string | null = null;
  let taskPrimaryId: string | null = null;
  let taskFailId: string | null = null;
  let runCompleteId: string | null = null;
  let runFailId: string | null = null;
  let runCancelId: string | null = null;

  const summary: JsonObject = {
    mcp_url: mcpUrl,
    suffix,
  };

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    summary.tools = tools.tools.map((tool) => tool.name).sort();

    const workspaceCreate = await callTool(client, 'workspace', {
      action: 'create',
      description: 'Live smoke test workspace',
      name: `Smoke Workspace ${suffix}`,
    });
    const workspaceRecord = asRecord(workspaceCreate.result, 'workspace/create result was not an object');
    workspaceId = getString(workspaceRecord, 'id');

    const compatibilityCreate = await callTool(client, 'workspace', {
      action: 'create_session',
      name: `Smoke Compatibility ${suffix}`,
      title: 'Compatibility Session',
    });
    const compatibilityResult = asRecord(compatibilityCreate.result, 'workspace/create_session result was not an object');
    compatibilityWorkspaceId = getString(asRecord(compatibilityResult.workspace, 'workspace/create_session missing workspace'), 'id');

    const sessionStart = await callTool(client, 'workspace', {
      action: 'start_session',
      title: `Smoke Session ${suffix}`,
      workspace_id: workspaceId,
    });
    const sessionRecord = asRecord(sessionStart.result, 'workspace/start_session result was not an object');
    sessionId = getString(sessionRecord, 'id');

    const workspaceList = await callTool(client, 'workspace', {
      action: 'list',
      limit: 10,
      offset: 0,
    });
    const workspaceItems = asArray(workspaceList.result, 'workspace/list result was not an array');
    assert(
      workspaceItems.some((item) => getString(asRecord(item, 'workspace/list item invalid'), 'id') === workspaceId),
      'workspace/list did not include the created workspace'
    );

    const workspaceGet = await callTool(client, 'workspace', {
      action: 'get',
      id: workspaceId,
    });

    const workspaceUpdate = await callTool(client, 'workspace', {
      action: 'update',
      id: workspaceId,
      description: 'Updated by live smoke test',
      icon: 'local',
      name: `Smoke Workspace Updated ${suffix}`,
    });

    const sessionList = await callTool(client, 'workspace', {
      action: 'list_sessions',
      limit: 10,
      offset: 0,
      workspace_id: workspaceId,
    });

    const pageAppendText = await callTool(client, 'page', {
      action: 'append_text',
      content: 'Initial smoke test journal entry.',
      session_id: sessionId,
      workspace_id: workspaceId,
    });
    const pageRecord = asRecord(pageAppendText.result, 'page/append_text result was not an object');
    pageId = getString(pageRecord, 'id');
    const initialBlocks = asArray(pageRecord.blocks, 'page/append_text did not return blocks');
    initialBlockId = getString(asRecord(initialBlocks[0], 'page/append_text first block invalid'), 'id');

    const pageGet = await callTool(client, 'page', {
      action: 'get',
      id: pageId,
      session_id: sessionId,
    });

    const pageList = await callTool(client, 'page', {
      action: 'list',
      limit: 10,
      offset: 0,
      session_id: sessionId,
      workspace_id: workspaceId,
    });

    const pageUpdate = await callTool(client, 'page', {
      action: 'update',
      id: pageId,
      importance: 0.9,
      title: `Smoke Page Updated ${suffix}`,
    });

    const pageAppend = await callTool(client, 'page', {
      action: 'append_blocks',
      blocks: [
        {
          block_type: 'code',
          content: 'console.log("smoke");',
          metadata: {
            language: 'ts',
          },
        },
      ],
      page_id: pageId,
      session_id: sessionId,
    });
    const appendedBlocks = asArray(pageAppend.result, 'page/append_blocks result was not an array');
    appendedBlockId = getString(asRecord(appendedBlocks[0], 'page/append_blocks block invalid'), 'id');

    const blockUpdate = await callTool(client, 'page', {
      action: 'block_update',
      block_id: initialBlockId,
      content: 'Updated smoke test journal entry.',
    });

    const blockDelete = await callTool(client, 'page', {
      action: 'block_delete',
      block_id: appendedBlockId,
    });
    appendedBlockId = null;

    const searchResult = await callTool(client, 'search', {
      limit: 10,
      query: `Smoke Page Updated ${suffix}`,
      session_id: sessionId,
      workspace_id: workspaceId,
    });

    const taskCreate = await callTool(client, 'task', {
      action: 'create',
      created_by_agent_name: 'smoke-suite',
      description: 'Primary live smoke test task',
      owner_agent_name: 'agent-a',
      session_id: sessionId,
      title: `Smoke Task ${suffix}`,
      workspace_id: workspaceId,
    });
    const taskCreateRecord = asRecord(taskCreate.result, 'task/create result was not an object');
    taskPrimaryId = getString(taskCreateRecord, 'id');

    const taskGet = await callTool(client, 'task', {
      action: 'get',
      id: taskPrimaryId,
    });

    const taskList = await callTool(client, 'task', {
      action: 'list',
      limit: 20,
      offset: 0,
      session_id: sessionId,
      workspace_id: workspaceId,
    });

    const taskClaim = await callTool(client, 'task', {
      action: 'claim',
      agent_name: 'agent-a',
      id: taskPrimaryId,
      lease_seconds: 300,
      session_id: sessionId,
      workspace_id: workspaceId,
    });

    const taskHeartbeat = await callTool(client, 'task', {
      action: 'heartbeat',
      agent_name: 'agent-a',
      id: taskPrimaryId,
      lease_seconds: 300,
    });

    const taskAppendEvent = await callTool(client, 'task', {
      action: 'append_event',
      agent_name: 'agent-a',
      event_type: 'task.note',
      id: taskPrimaryId,
      payload: {
        note: 'smoke event',
      },
    });

    const taskHandoff = await callTool(client, 'task', {
      action: 'handoff',
      agent_name: 'agent-a',
      id: taskPrimaryId,
      payload: {
        handoff: 'ready for review',
      },
      require_ack: true,
      target_agent_name: 'agent-b',
    });

    const inboxList = await callTool(client, 'task', {
      action: 'inbox_list',
      agent_name: 'agent-b',
      limit: 20,
      offset: 0,
      unread_only: true,
      workspace_id: workspaceId,
    });
    const inboxItems = asArray(inboxList.result, 'task/inbox_list result was not an array');
    const handoffInbox = inboxItems
      .map((item) => asRecord(item, 'task/inbox_list item invalid'))
      .find((item) => getString(item, 'task_id') === taskPrimaryId);
    assert(handoffInbox, 'task/inbox_list did not include the handoff inbox item');
    const inboxId = getString(handoffInbox, 'id');

    const inboxAck = await callTool(client, 'task', {
      action: 'inbox_ack',
      agent_name: 'agent-b',
      inbox_id: inboxId,
    });

    const taskAck = await callTool(client, 'task', {
      action: 'ack',
      agent_name: 'agent-b',
      id: taskPrimaryId,
      payload: {
        acknowledged: true,
      },
    });

    const runStart = await callTool(client, 'run', {
      action: 'start',
      agent_name: 'agent-b',
      session_id: sessionId,
      task_id: taskPrimaryId,
      title: 'Smoke Run Complete',
      workspace_id: workspaceId,
    });
    const runCompleteRecord = asRecord(runStart.result, 'run/start result was not an object');
    runCompleteId = getString(runCompleteRecord, 'id');

    const runGet = await callTool(client, 'run', {
      action: 'get',
      id: runCompleteId,
      session_id: sessionId,
    });

    const runList = await callTool(client, 'run', {
      action: 'list',
      limit: 20,
      offset: 0,
      session_id: sessionId,
      workspace_id: workspaceId,
    });

    const runCheckpoint = await callTool(client, 'run', {
      action: 'checkpoint',
      id: runCompleteId,
      state: {
        stage: 'checkpoint',
      },
      summary: 'checkpointed by smoke test',
    });

    const runComplete = await callTool(client, 'run', {
      action: 'complete',
      id: runCompleteId,
      result: {
        status: 'ok',
      },
    });
    runCompleteId = null;

    const taskComplete = await callTool(client, 'task', {
      action: 'complete',
      agent_name: 'agent-b',
      id: taskPrimaryId,
      payload: {
        result: 'complete',
      },
    });
    taskPrimaryId = null;

    const taskFailCreate = await callTool(client, 'task', {
      action: 'create',
      created_by_agent_name: 'smoke-suite',
      session_id: sessionId,
      title: `Smoke Task Fail ${suffix}`,
      workspace_id: workspaceId,
    });
    const taskFailRecord = asRecord(taskFailCreate.result, 'task/create fail result was not an object');
    taskFailId = getString(taskFailRecord, 'id');

    const taskFail = await callTool(client, 'task', {
      action: 'fail',
      agent_name: 'agent-c',
      blocker_reason: 'smoke-fail',
      id: taskFailId,
      payload: {
        status: 'failed',
      },
    });
    taskFailId = null;

    const runFailStart = await callTool(client, 'run', {
      action: 'start',
      agent_name: 'agent-c',
      session_id: sessionId,
      title: 'Smoke Run Fail',
      workspace_id: workspaceId,
    });
    const runFailRecord = asRecord(runFailStart.result, 'run/fail start result was not an object');
    runFailId = getString(runFailRecord, 'id');

    const runFail = await callTool(client, 'run', {
      action: 'fail',
      error_message: 'smoke failure',
      id: runFailId,
      result: {
        status: 'failed',
      },
    });
    runFailId = null;

    const runCancelStart = await callTool(client, 'run', {
      action: 'start',
      agent_name: 'agent-d',
      session_id: sessionId,
      title: 'Smoke Run Cancel',
      workspace_id: workspaceId,
    });
    const runCancelRecord = asRecord(runCancelStart.result, 'run/cancel start result was not an object');
    runCancelId = getString(runCancelRecord, 'id');

    const runCancel = await callTool(client, 'run', {
      action: 'cancel',
      id: runCancelId,
      result: {
        status: 'cancelled',
      },
    });
    runCancelId = null;

    const sessionGet = await callTool(client, 'workspace', {
      action: 'get_session',
      session_id: sessionId,
      workspace_id: workspaceId,
    });

    const sessionResume = await callTool(client, 'workspace', {
      action: 'resume_session_context',
      max_bytes: 32768,
      max_items: 10,
      session_id: sessionId,
      workspace_id: workspaceId,
    });

    const databaseCreate = await callTool(client, 'database', {
      action: 'create',
      description: 'Live smoke test database',
      name: `Smoke Database ${suffix}`,
      parent_page_id: pageId,
      properties: [
        {
          is_required: true,
          name: 'Title',
          type: 'title',
        },
        {
          name: 'Status',
          type: 'text',
        },
        {
          name: 'Score',
          options: {
            format: 'plain',
          },
          type: 'number',
        },
      ],
      workspace_id: workspaceId,
    });
    const databaseRecord = asRecord(databaseCreate.result, 'database/create result was not an object');
    databaseId = getString(databaseRecord, 'id');

    const databaseGet = await callTool(client, 'database', {
      action: 'get',
      id: databaseId,
    });

    const databaseList = await callTool(client, 'database', {
      action: 'list',
      limit: 10,
      workspace_id: workspaceId,
    });

    const databaseAddProperty = await callTool(client, 'database', {
      action: 'add_property',
      database_id: databaseId,
      name: 'Category',
      options: {
        choices: ['alpha', 'beta'],
      },
      type: 'select',
    });

    const databaseUpdate = await callTool(client, 'database', {
      action: 'update',
      description: 'Updated database description',
      id: databaseId,
      tags: ['smoke', 'live'],
    });

    const rowCreate = await callTool(client, 'row', {
      action: 'create',
      database_id: databaseId,
      importance: 0.7,
      tags: ['smoke'],
      values: {
        Category: 'alpha',
        Score: 7,
        Status: 'open',
        Title: `Smoke Row ${suffix}`,
      },
    });
    const rowRecord = asRecord(rowCreate.result, 'row/create result was not an object');
    rowId = getString(rowRecord, 'id');

    const rowGet = await callTool(client, 'row', {
      action: 'get',
      database_id: databaseId,
      id: rowId,
    });

    const rowUpdate = await callTool(client, 'row', {
      action: 'update',
      database_id: databaseId,
      id: rowId,
      importance: 0.95,
      values: {
        Category: 'beta',
        Score: 9,
        Status: 'closed',
        Title: `Smoke Row Updated ${suffix}`,
      },
    });

    const rowQuery = await callTool(client, 'row', {
      action: 'query',
      database_id: databaseId,
      filters: [
        {
          operator: 'contains',
          property: 'Title',
          value: suffix,
        },
      ],
      limit: 10,
    });

    const rowCount = await callTool(client, 'row', {
      action: 'count',
      database_id: databaseId,
      filters: [
        {
          operator: 'eq',
          property: 'Status',
          value: 'closed',
        },
      ],
    });

    const rowBulkCreate = await callTool(client, 'row', {
      action: 'bulk_create',
      database_id: databaseId,
      rows: [
        {
          values: {
            Category: 'alpha',
            Score: 1,
            Status: 'queued',
            Title: `Bulk Row A ${suffix}`,
          },
        },
        {
          values: {
            Category: 'beta',
            Score: 2,
            Status: 'queued',
            Title: `Bulk Row B ${suffix}`,
          },
        },
      ],
    });

    const rowCleanup = await callTool(client, 'row', {
      action: 'cleanup_expired',
    });

    const linkCreate = await callTool(client, 'link', {
      action: 'create',
      from_id: pageId,
      from_type: 'page',
      link_type: 'references',
      to_id: databaseId,
      to_type: 'database',
    });
    const linkRecord = asRecord(linkCreate.result, 'link/create result was not an object');
    linkId = getString(linkRecord, 'id');

    const linkList = await callTool(client, 'link', {
      action: 'list',
      direction: 'both',
      item_id: pageId,
      item_type: 'page',
    });

    const rowDelete = await callTool(client, 'row', {
      action: 'delete',
      id: rowId,
    });
    rowId = null;

    const linkDelete = await callTool(client, 'link', {
      action: 'delete',
      link_id: linkId,
    });
    linkId = null;

    const databaseDelete = await callTool(client, 'database', {
      action: 'delete',
      id: databaseId,
    });
    databaseId = null;

    const sessionClose = await callTool(client, 'workspace', {
      action: 'close_session',
      session_id: sessionId,
    });
    sessionId = null;

    const pageDelete = await callTool(client, 'page', {
      action: 'delete',
      id: pageId,
    });
    pageId = null;
    initialBlockId = null;

    const compatibilityDelete = await callTool(client, 'workspace', {
      action: 'delete',
      id: compatibilityWorkspaceId,
    });
    compatibilityWorkspaceId = null;

    const workspaceDelete = await callTool(client, 'workspace', {
      action: 'delete',
      id: workspaceId,
    });
    workspaceId = null;

    summary.workspace = {
      create: workspaceRecord,
      create_session: compatibilityResult,
      delete: workspaceDelete.result,
      get: workspaceGet.result,
      get_session: sessionGet.result,
      list_count: workspaceItems.length,
      list_sessions_count: asArray(sessionList.result, 'workspace/list_sessions result was not an array').length,
      resume_session_context: sessionResume.result,
      session_close: sessionClose.result,
      session_delete_compat: compatibilityDelete.result,
      start_session: sessionRecord,
      update: workspaceUpdate.result,
    };
    summary.page = {
      append_blocks: pageAppend.result,
      append_text: pageRecord,
      block_delete: blockDelete.result,
      block_update: blockUpdate.result,
      delete: pageDelete.result,
      get: pageGet.result,
      list_count: asArray(pageList.result, 'page/list result was not an array').length,
      update: pageUpdate.result,
    };
    summary.search = searchResult.result;
    summary.task = {
      ack: taskAck.result,
      append_event: taskAppendEvent.result,
      claim: taskClaim.result,
      complete: taskComplete.result,
      create: taskCreateRecord,
      fail: taskFail.result,
      get: taskGet.result,
      handoff: taskHandoff.result,
      heartbeat: taskHeartbeat.result,
      inbox_ack: inboxAck.result,
      inbox_list_count: inboxItems.length,
      list_count: asArray(taskList.result, 'task/list result was not an array').length,
    };
    summary.run = {
      cancel: runCancel.result,
      checkpoint: runCheckpoint.result,
      complete: runComplete.result,
      fail: runFail.result,
      get: runGet.result,
      list_count: asArray(runList.result, 'run/list result was not an array').length,
      start: runCompleteRecord,
    };
    summary.database = {
      add_property: databaseAddProperty.result,
      create: databaseRecord,
      delete: databaseDelete.result,
      get: databaseGet.result,
      list_count: asArray(databaseList.result, 'database/list result was not an array').length,
      update: databaseUpdate.result,
    };
    summary.row = {
      bulk_create_count: asArray(rowBulkCreate.result, 'row/bulk_create result was not an array').length,
      cleanup_expired: rowCleanup.result,
      count: rowCount.result,
      create: rowRecord,
      delete: rowDelete.result,
      get: rowGet.result,
      query: rowQuery.result,
      update: rowUpdate.result,
    };
    summary.link = {
      create: linkRecord,
      delete: linkDelete.result,
      list: linkList.result,
    };

    console.log(JSON.stringify({ ok: true, summary }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      summary,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (runCompleteId) {
      await safeCallTool(client, 'run', { action: 'cancel', id: runCompleteId, result: { cleanup: true } });
    }
    if (runFailId) {
      await safeCallTool(client, 'run', { action: 'cancel', id: runFailId, result: { cleanup: true } });
    }
    if (runCancelId) {
      await safeCallTool(client, 'run', { action: 'cancel', id: runCancelId, result: { cleanup: true } });
    }
    if (taskPrimaryId) {
      await safeCallTool(client, 'task', { action: 'fail', agent_name: 'cleanup', blocker_reason: 'cleanup', id: taskPrimaryId });
    }
    if (taskFailId) {
      await safeCallTool(client, 'task', { action: 'fail', agent_name: 'cleanup', blocker_reason: 'cleanup', id: taskFailId });
    }
    if (linkId) {
      await safeCallTool(client, 'link', { action: 'delete', link_id: linkId });
    }
    if (rowId) {
      await safeCallTool(client, 'row', { action: 'delete', id: rowId });
    }
    if (databaseId) {
      await safeCallTool(client, 'database', { action: 'delete', id: databaseId });
    }
    if (pageId) {
      await safeCallTool(client, 'page', { action: 'delete', id: pageId });
    }
    if (sessionId) {
      await safeCallTool(client, 'workspace', { action: 'close_session', session_id: sessionId });
    }
    if (compatibilityWorkspaceId) {
      await safeCallTool(client, 'workspace', { action: 'delete', id: compatibilityWorkspaceId });
    }
    if (workspaceId) {
      await safeCallTool(client, 'workspace', { action: 'delete', id: workspaceId });
    }
    await client.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
