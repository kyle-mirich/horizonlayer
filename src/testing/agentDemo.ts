import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  asArray,
  asRecord,
  callTool,
  closeClient,
  createStdioClient,
  getRevision,
  getString,
} from './mcpClient.js';

async function cleanup(
  client: Client,
  sessionId: string | null,
  workspaceId: string | null,
  workspaceRevision: number | null
): Promise<void> {
  if (sessionId) {
    try {
      await callTool(client, 'session', { action: 'close', session_id: sessionId });
    } catch {
      // Preserve the original demo failure.
    }
  }
  if (workspaceId && workspaceRevision) {
    try {
      await callTool(client, 'workspace', {
        action: 'archive',
        revision: workspaceRevision,
        workspace_id: workspaceId,
      });
    } catch {
      // Preserve the original demo failure.
    }
  }
}

async function main(): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  const { client, transport } = createStdioClient('horizonlayer-agent-demo', ['legacy-mcp']);
  let sessionId: string | null = null;
  let workspaceId: string | null = null;
  let workspaceRevision: number | null = null;
  let cleanedUp = false;

  try {
    await client.connect(transport);

    const workspace = asRecord((await callTool(client, 'workspace', {
      action: 'create',
      description: 'Canonical agent knowledge flow',
      name: `Agent Demo ${suffix}`,
    })).result, 'workspace/create result was not an object');
    workspaceId = getString(workspace, 'id');
    workspaceRevision = getRevision(workspace, 'workspace/create');

    const session = asRecord((await callTool(client, 'session', {
      action: 'start',
      summary: 'Capture a durable decision and execution journal',
      title: 'Architecture pass',
      workspace_id: workspaceId,
    })).result, 'session/start result was not an object');
    sessionId = getString(session, 'id');

    const page = asRecord((await callTool(client, 'page', {
      action: 'create',
      blocks: [{ content: 'HorizonLayer is a Postgres-backed knowledge layer for agents.' }],
      session_id: sessionId,
      tags: ['architecture'],
      title: 'Architecture note',
      workspace_id: workspaceId,
    })).result, 'page/create result was not an object');
    const pageId = getString(page, 'id');

    const database = asRecord((await callTool(client, 'database', {
      action: 'create',
      name: 'Decisions',
      parent_page_id: pageId,
      properties: [
        { name: 'Name', property_type: 'title' },
        {
          name: 'Status',
          property_type: 'select',
          options: { choices: ['accepted'] },
        },
      ],
      workspace_id: workspaceId,
    })).result, 'database/create result was not an object');
    const databaseId = getString(database, 'id');

    const row = asRecord((await callTool(client, 'row', {
      action: 'create',
      database_id: databaseId,
      values: {
        Name: 'Use PostgreSQL as the durable source of truth',
        Status: 'accepted',
      },
    })).result, 'row/create result was not an object');
    const rowId = getString(row, 'id');

    const link = asRecord((await callTool(client, 'link', {
      action: 'create',
      from_id: pageId,
      from_type: 'page',
      link_type: 'supports',
      to_id: rowId,
      to_type: 'row',
      workspace_id: workspaceId,
    })).result, 'link/create result was not an object');

    const search = asRecord((await callTool(client, 'search', {
      mode: 'records',
      query: 'Postgres durable source truth',
      scope: {
        kind: 'workspace',
        types: ['page', 'row'],
        workspace_id: workspaceId,
      },
    })).result, 'search result was not an object');

    let run = asRecord((await callTool(client, 'run', {
      action: 'start',
      agent_name: 'codex-demo',
      session_id: sessionId,
      title: 'Capture architecture decision',
      workspace_id: workspaceId,
    })).result, 'run/start result was not an object');
    const runId = getString(run, 'id');
    const checkpointMutation = asRecord((await callTool(client, 'run', {
      action: 'checkpoint',
      run_id: runId,
      state: { database_id: databaseId, page_id: pageId, row_id: rowId },
      summary: 'Stored the note, decision row, and relationship',
    })).result, 'run/checkpoint result was not an object');
    const checkpoint = asRecord(
      checkpointMutation.checkpoint,
      'run/checkpoint result missing checkpoint'
    );
    run = asRecord(checkpointMutation.run, 'run/checkpoint result missing run');

    const finishMutation = asRecord((await callTool(client, 'run', {
      action: 'finish',
      outcome: 'completed',
      result: { captured: true },
      run_id: runId,
    })).result, 'run/finish result was not an object');
    run = asRecord(finishMutation.run, 'run/finish result missing run');

    const resume = asRecord((await callTool(client, 'session', {
      action: 'resume',
      session_id: sessionId,
      workspace_id: workspaceId,
    })).result, 'session/resume result was not an object');

    await callTool(client, 'session', { action: 'close', session_id: sessionId });
    sessionId = null;
    await callTool(client, 'workspace', {
      action: 'archive',
      revision: workspaceRevision,
      workspace_id: workspaceId,
    });
    cleanedUp = true;

    console.log('# HorizonLayer canonical agent flow');
    console.log('');
    console.log('```json');
    console.log(JSON.stringify({
      database_id: databaseId,
      link_id: getString(link, 'id'),
      link_revision: getRevision(link, 'link/create'),
      page_id: pageId,
      row_id: rowId,
      run_id: runId,
      run_checkpoint_sequence: checkpoint.sequence,
      run_status: run.status,
      search_hits: asArray(search.records, 'search result missing records').length,
      resume_sections: Object.keys(resume),
      workspace_archived: true,
    }, null, 2));
    console.log('```');
  } finally {
    if (!cleanedUp) await cleanup(client, sessionId, workspaceId, workspaceRevision);
    await closeClient(client);
  }
}

main().catch((error) => {
  console.error(`Agent demo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
