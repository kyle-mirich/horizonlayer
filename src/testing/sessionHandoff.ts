import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { asArray, asRecord, assert, closeClient, createStdioClient, getRevision, getString } from './mcpClient.js';

async function invoke(client: Client, name: 'knowledge' | 'issues', selector: string, input: Record<string, unknown>) {
  const response = await client.callTool({
    name,
    arguments: { [name === 'knowledge' ? 'operation' : 'action']: selector, input },
  });
  const envelope = asRecord(response.structuredContent, 'Missing structured MCP response');
  assert(envelope.ok === true, `${name}/${selector}: ${JSON.stringify(envelope.error)}`);
  return envelope.result;
}

async function session(name: string, work: (client: Client) => Promise<void>) {
  const { client, transport } = createStdioClient(name, ['mcp']);
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert(catalog.tools.some((tool) => tool.name === 'knowledge'), 'Knowledge module missing');
    assert(catalog.tools.some((tool) => tool.name === 'issues'), 'Issues module missing');
    await work(client);
  } finally {
    await closeClient(client);
  }
}

async function main() {
  assert(process.env.HORIZONLAYER_DEMO_DATABASE_URL, 'Run npm run demo:handoff to provision a disposable database');
  process.env.DATABASE_URL = process.env.HORIZONLAYER_DEMO_DATABASE_URL;
  process.env.RAG_ENABLED = 'false';
  process.env.HORIZONLAYER_MODULES = 'both';
  process.env.MCP_COMMAND = 'node';
  process.env.MCP_ARGS = 'dist/launcher.js';

  console.log('HorizonLayer / recorded MCP session handoff');
  console.log('Scripted clients | PostgreSQL 17 | no LLM or embeddings');
  console.log('');
  console.log('SESSION A / capture a decision');
  await session('handoff-session-a', async (client) => {
    const workspace = asRecord(await invoke(client, 'knowledge', 'workspace', {
      action: 'create', name: 'Session handoff demo',
    }), 'Missing workspace');
    const page = asRecord(await invoke(client, 'knowledge', 'page', {
      action: 'create', workspace_id: getString(workspace, 'id'),
      title: 'Use PostgreSQL as the source of truth',
      blocks: [{ content: 'Keep canonical records in PostgreSQL. Rebuild the search index from those records.' }],
    }), 'Missing page');
    console.log(`Saved decision: ${getString(page, 'title')}`);
    const project = asRecord(await invoke(client, 'issues', 'project.create', {
      project_key: 'DEMO', name: 'Session handoff demo',
    }), 'Missing project');
    const issue = asRecord(await invoke(client, 'issues', 'issue.create', {
      project_id: getString(project, 'id'), title: 'Document the search rebuild procedure',
      created_by: 'session-a',
    }), 'Missing issue');
    await invoke(client, 'issues', 'link.create', {
      workspace_id: getString(workspace, 'id'), from_type: 'page', from_id: getString(page, 'id'),
      to_type: 'issue', to_id: getString(issue, 'id'), link_type: 'informs',
    });
    console.log(`Linked task: ${getString(issue, 'issue_key')} / ${getString(issue, 'title')}`);
  });
  console.log('Session A disconnected; its MCP process stopped.');
  console.log('');
  console.log('SESSION B / retrieve context in a fresh MCP process');
  await session('handoff-session-b', async (client) => {
    const listed = asRecord(await invoke(client, 'knowledge', 'workspace', { action: 'list' }), 'Missing workspace list');
    const workspace = asArray(listed.items, 'Missing workspace items')
      .map((item) => asRecord(item, 'Invalid workspace')).find((item) => item.name === 'Session handoff demo');
    assert(workspace, 'Fresh session could not find the workspace');
    const search = asRecord(await invoke(client, 'knowledge', 'search', {
      mode: 'records', query: 'PostgreSQL',
      scope: { kind: 'workspace', workspace_id: getString(workspace, 'id'), types: ['page'] },
    }), 'Missing search result');
    const records = asArray(search.records, 'Missing search records');
    assert(records.length === 1, 'Expected exactly one saved decision');
    const match = asRecord(records[0], 'Invalid search record');
    const page = asRecord(await invoke(client, 'knowledge', 'page', {
      action: 'get', page_id: getString(match, 'ref'),
    }), 'Missing retrieved page');
    assert(page.title === 'Use PostgreSQL as the source of truth', 'Decision title did not persist');
    const blocks = asArray(page.blocks, 'Missing decision blocks');
    const rationale = getString(asRecord(blocks[0], 'Missing rationale'), 'content');
    assert(rationale === 'Keep canonical records in PostgreSQL. Rebuild the search index from those records.', 'Decision rationale did not persist');
    console.log(`Found decision: ${getString(page, 'title')}`);
    console.log(`Read rationale: ${rationale}`);
    const ready = asArray(await invoke(client, 'issues', 'issue.query', {
      query: 'project = DEMO AND ready = true',
    }), 'Missing ready queue');
    assert(ready.length === 1, 'Expected one ready task');
    const issue = asRecord(ready[0], 'Invalid ready task');
    const links = asArray(await invoke(client, 'issues', 'link.list', {
      workspace_id: getString(workspace, 'id'), item_type: 'page', item_id: getString(page, 'id'),
    }), 'Missing links');
    assert(links.some((value) => asRecord(value, 'Invalid link').to_id === issue.id), 'Decision-task link did not persist');
    const claimed = asRecord(await invoke(client, 'issues', 'issue.claim', {
      issue: getString(issue, 'issue_key'), assignee: 'session-b', revision: getRevision(issue, 'ready task'),
    }), 'Missing claimed task');
    assert(claimed.status === 'in_progress' && claimed.assignee === 'session-b', 'Claim was not applied');
    console.log(`Claimed ${getString(claimed, 'issue_key')}: ${getString(claimed, 'status')} / ${getString(claimed, 'assignee')}`);
    const remaining = asArray(await invoke(client, 'issues', 'issue.query', {
      query: 'project = DEMO AND ready = true',
    }), 'Missing ready queue after claim');
    assert(remaining.length === 0, 'Claimed task remained available');
    console.log(`Ready queue after claim: ${remaining.length} tasks`);
  });
  console.log('');
  console.log('PASS / decision, rationale, and task link survived the process restart.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
