import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { lstat, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import pg from 'pg';

import {
  createBackupArtifact,
  inspectBackupArtifact,
  type BackupManifestInput,
} from '../backupArtifact.js';
import {
  asArray,
  asRecord,
  assert,
  callTool,
  callToolEnvelope,
  closeClient,
  getRevision,
  getString,
  type JsonObject,
} from './mcpClient.js';
import type { LocalRuntimeConfig } from '../localRuntime.js';

const { Client: PostgresClient } = pg;
function requiredEnvironment(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}

const home = requiredEnvironment('HORIZONLAYER_HOME');
const launcher = requiredEnvironment('PACKED_LAUNCHER');
const smokeRoot = requiredEnvironment('RECOVERY_SMOKE_WORKSPACE');

const configPath = join(home, 'runtime.json');
const projectConfigPath = join(smokeRoot, '.horizonlayer.json');
const explicitBackup = join(smokeRoot, 'state-a.hlbackup');
const corruptedBackup = join(smokeRoot, 'corrupted.hlbackup');
const restoreFailureBackup = join(smokeRoot, 'restore-failure.hlbackup');
const restoreFailurePayload = join(smokeRoot, 'restore-failure.dump');
const collisionProbe = join(smokeRoot, 'lock-probe.hlbackup');
const tokenA = `cedarharbor${process.pid}a`;
const tokenB = `violetforge${process.pid}b`;

interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface StateIds {
  archivedPageId: string;
  bOnlyPageId: string | null;
  databaseId: string;
  linkId: string;
  pageId: string;
  rowId: string;
  runId: string;
  sessionId: string;
  workspaceId: string;
  issueProjectId: string;
  issueProjectKey: string;
  issueId: string;
  childIssueId: string;
  blockerIssueId: string;
  dependencyId: string;
  issueLinkId: string;
  bOnlyIssueId: string | null;
}

function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...extra, HORIZONLAYER_HOME: home };
  delete environment.DATABASE_URL;
  delete environment.QDRANT_URL;
  delete environment.RAG_ENABLED;
  return environment;
}

function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve('');
  return (async () => {
    let value = '';
    for await (const chunk of stream) value += Buffer.from(chunk).toString('utf8');
    return value;
  })();
}

async function runCli(args: string[], expectedCode = 0): Promise<CommandResult> {
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd: smokeRoot,
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (value) => resolve(value ?? 1));
  });
  const result = { code, stderr: await stderr, stdout: await stdout };
  assert(
    code === expectedCode,
    `horizonlayer ${args.join(' ')} exited ${code}, expected ${expectedCode}\n${result.stderr}`
  );
  return result;
}

async function runExecutable(command: string, args: string[]): Promise<CommandResult> {
  const child = spawn(command, args, {
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (value) => resolve(value ?? 1));
  });
  const result = { code, stderr: await stderr, stdout: await stdout };
  assert(code === 0, `${command} ${args.join(' ')} failed\n${result.stderr}`);
  return result;
}

async function runtimeConfig(): Promise<LocalRuntimeConfig> {
  return JSON.parse(await readFile(configPath, 'utf8')) as LocalRuntimeConfig;
}

function databaseUrl(config: LocalRuntimeConfig): string {
  return `postgres://${encodeURIComponent(config.database_user)}:${encodeURIComponent(config.database_password)}`
    + `@127.0.0.1:${config.database_port}/${encodeURIComponent(config.database_name)}`;
}

async function withMcp<T>(operation: (client: McpClient) => Promise<T>): Promise<T> {
  const client = new McpClient({ name: 'horizonlayer-recovery-smoke', version: '0.0.1' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    args: [launcher, 'legacy-mcp'],
    command: process.execPath,
    cwd: smokeRoot,
    env: cleanEnvironment() as Record<string, string>,
  });
  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await closeClient(client);
  }
}

async function withModuleMcp<T>(
  operation: (client: McpClient) => Promise<T>,
  expectedTools: Array<'issues' | 'knowledge'> = ['issues', 'knowledge']
): Promise<T> {
  const client = new McpClient({ name: 'horizonlayer-v3-recovery-smoke', version: '0.0.1' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    args: [launcher],
    command: process.execPath,
    cwd: smokeRoot,
    env: cleanEnvironment() as Record<string, string>,
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert(JSON.stringify(tools) === JSON.stringify([...expectedTools].sort()),
      `default selected-module MCP exposed an unexpected tool catalog: ${tools.join(', ')}`);
    return await operation(client);
  } finally {
    await closeClient(client);
  }
}

async function callModule<Result = JsonObject>(
  client: McpClient,
  name: 'issues' | 'knowledge',
  args: JsonObject
): Promise<Result> {
  const response = await client.callTool({ name, arguments: args });
  const envelope = record(response.structuredContent, `${name} module envelope`);
  assert(envelope.ok === true, `${name} module call failed: ${JSON.stringify(envelope.error)}`);
  return envelope.result as Result;
}

function record(value: unknown, label: string): JsonObject {
  return asRecord(value, `${label} did not return an object`);
}

async function createStateA(): Promise<StateIds> {
  const knowledgeIds = await withMcp(async (client) => {
    const workspaceRecord = record((await callTool(client, 'workspace', {
      action: 'create',
      description: 'Packed CLI Runtime Recovery smoke state',
      name: 'Recovery smoke workspace',
    })).result, 'workspace/create');
    const workspaceId = getString(workspaceRecord, 'id');
    const session = record((await callTool(client, 'session', {
      action: 'start',
      summary: 'State A resumable session',
      title: 'Recovery smoke session',
      workspace_id: workspaceId,
    })).result, 'session/start');
    const sessionId = getString(session, 'id');
    const page = record((await callTool(client, 'page', {
      action: 'create',
      blocks: [{ block_type: 'heading', content: `Canonical marker ${tokenA}` }],
      importance: 0.91,
      session_id: sessionId,
      tags: ['recovery-smoke', 'state-a'],
      title: `State A ${tokenA}`,
      workspace_id: workspaceId,
    })).result, 'page/create');
    const pageId = getString(page, 'id');
    let pageRevision = getRevision(page, 'page/create');
    let block = record(asArray(page.blocks, 'page blocks')[0], 'page block');
    const blockId = getString(block, 'id');
    block = record(record((await callTool(client, 'page', {
      action: 'block_archive', block_id: blockId, revision: getRevision(block, 'block'),
    })).result, 'block_archive').block, 'archived block');
    pageRevision += 1;
    const restored = record((await callTool(client, 'page', {
      action: 'block_restore', block_id: blockId, revision: getRevision(block, 'archived block'),
    })).result, 'block_restore');
    pageRevision = Number(restored.page_revision);

    const archivedPage = record((await callTool(client, 'page', {
      action: 'create',
      blocks: [{ block_type: 'text', content: 'Intentionally archived recovery evidence' }],
      title: 'Archived recovery evidence',
      workspace_id: workspaceId,
    })).result, 'archived page create');
    const archivedPageId = getString(archivedPage, 'id');
    await callTool(client, 'page', {
      action: 'archive', page_id: archivedPageId, revision: getRevision(archivedPage, 'archived page'),
    });

    const database = record((await callTool(client, 'database', {
      action: 'create',
      description: 'Typed recovery decisions',
      name: 'Recovery decisions',
      parent_page_id: pageId,
      properties: [
        { name: 'Name', property_type: 'title' },
        { name: 'Status', property_type: 'select', options: { choices: ['accepted', 'changed'] } },
      ],
      tags: ['recovery-smoke'],
      workspace_id: workspaceId,
    })).result, 'database/create');
    const databaseId = getString(database, 'id');
    const row = record((await callTool(client, 'row', {
      action: 'create',
      database_id: databaseId,
      importance: 0.93,
      tags: ['recovery-smoke', 'state-a'],
      values: { Name: `Decision ${tokenA}`, Status: 'accepted' },
    })).result, 'row/create');
    const rowId = getString(row, 'id');
    const link = record((await callTool(client, 'link', {
      action: 'create',
      from_id: pageId,
      from_type: 'page',
      link_type: 'supports',
      to_id: rowId,
      to_type: 'row',
      workspace_id: workspaceId,
    })).result, 'link/create');
    const linkId = getString(link, 'id');
    let run = record((await callTool(client, 'run', {
      action: 'start',
      agent_name: 'recovery-smoke',
      metadata: { phase: 'A' },
      session_id: sessionId,
      title: 'State A checkpoint',
      workspace_id: workspaceId,
    })).result, 'run/start');
    const runId = getString(run, 'id');
    await callTool(client, 'run', {
      action: 'checkpoint',
      run_id: runId,
      state: { database_id: databaseId, page_id: pageId, row_id: rowId },
      summary: 'State A is recoverable',
    });
    run = record(record((await callTool(client, 'run', {
      action: 'finish', outcome: 'completed', result: { phase: 'A' }, run_id: runId,
    })).result, 'run/finish').run, 'finished run');
    assert(run.status === 'completed', 'run did not finish');
    assert(Number.isInteger(pageRevision), 'page mutation revision was not retained');

    await assertSemanticState(client, workspaceId, tokenA, tokenB);
    return {
      archivedPageId,
      bOnlyPageId: null,
      databaseId,
      linkId,
      pageId,
      rowId,
      runId,
      sessionId,
      workspaceId,
    };
  });
  return withModuleMcp(async (client) => {
    const workspace = await callModule(client, 'knowledge', {
      operation: 'workspace',
      input: { action: 'get', workspace_id: knowledgeIds.workspaceId },
    });
    assert(workspace.id === knowledgeIds.workspaceId,
      'compact Knowledge module could not read the recovery workspace');
    const project = await callModule(client, 'issues', {
      action: 'project.create',
      input: { name: `Recovery smoke ${process.pid}`, project_key: `RSM${process.pid}` },
    });
    const issueProjectId = getString(project, 'id');
    const issueProjectKey = getString(project, 'project_key');
    const issue = await callModule(client, 'issues', {
      action: 'issue.create',
      input: {
        created_by: 'recovery-smoke',
        project_id: issueProjectId,
        tags: ['recovery-smoke', 'state-a'],
        title: `Issue state A ${tokenA}`,
      },
    });
    const issueId = getString(issue, 'id');
    const blocker = await callModule(client, 'issues', {
      action: 'issue.create',
      input: { created_by: 'recovery-smoke', project_id: issueProjectId, title: 'Recovery blocker' },
    });
    const blockerIssueId = getString(blocker, 'id');
    const child = await callModule(client, 'issues', {
      action: 'issue.create',
      input: {
        created_by: 'recovery-smoke',
        parent_issue: getString(issue, 'issue_key'),
        project_id: issueProjectId,
        title: 'Recovery child',
      },
    });
    const childIssueId = getString(child, 'id');
    const dependency = await callModule(client, 'issues', {
      action: 'dependency.create',
      input: {
        blocked_issue: getString(child, 'issue_key'),
        blocking_issue: getString(blocker, 'issue_key'),
      },
    });
    const dependencyId = getString(dependency, 'id');
    await callModule(client, 'issues', {
      action: 'comment.add',
      input: { author: 'recovery-smoke', body: `Issue comment A ${tokenA}`, issue: getString(issue, 'issue_key') },
    });
    const issueLink = await callModule(client, 'issues', {
      action: 'link.create',
      input: {
        from_id: knowledgeIds.pageId,
        from_type: 'page',
        link_type: 'implements',
        to_id: issueId,
        to_type: 'issue',
        workspace_id: knowledgeIds.workspaceId,
      },
    });
    return {
      ...knowledgeIds,
      bOnlyIssueId: null,
      blockerIssueId,
      childIssueId,
      dependencyId,
      issueId,
      issueLinkId: getString(issueLink, 'id'),
      issueProjectId,
      issueProjectKey,
    };
  });
}

async function mutateToStateB(ids: StateIds): Promise<void> {
  await withMcp(async (client) => {
    let page = record((await callTool(client, 'page', {
      action: 'get', page_id: ids.pageId,
    })).result, 'page/get');
    const block = record(asArray(page.blocks, 'page blocks')[0], 'page block');
    const blockMutation = record((await callTool(client, 'page', {
      action: 'block_update',
      block_id: getString(block, 'id'),
      content: `Canonical marker ${tokenB}`,
      revision: getRevision(block, 'page block'),
    })).result, 'block_update');
    page = record((await callTool(client, 'page', {
      action: 'update',
      importance: 0.72,
      page_id: ids.pageId,
      revision: Number(blockMutation.page_revision),
      tags: ['recovery-smoke', 'state-b'],
      title: `State B ${tokenB}`,
    })).result, 'page/update');
    assert(getRevision(page, 'page/update') > 1, 'page revision did not advance');

    const row = record((await callTool(client, 'row', {
      action: 'get', row_id: ids.rowId,
    })).result, 'row/get');
    await callTool(client, 'row', {
      action: 'update',
      importance: 0.74,
      revision: getRevision(row, 'row/get'),
      row_id: ids.rowId,
      tags: ['recovery-smoke', 'state-b'],
      values: { Name: `Decision ${tokenB}`, Status: 'changed' },
    });

    const links = record((await callTool(client, 'link', {
      action: 'list',
      direction: 'both',
      include_archived: false,
      item_id: ids.pageId,
      item_type: 'page',
      workspace_id: ids.workspaceId,
    })).result, 'link/list before archive');
    const activeLink = asArray(links.items, 'active links')
      .map((value) => record(value, 'active link'))
      .find((value) => value.id === ids.linkId);
    assert(activeLink, 'state A link was not active before B mutation');
    await callTool(client, 'link', {
      action: 'archive',
      link_id: ids.linkId,
      revision: getRevision(activeLink, 'active link'),
    });

    const bOnlyPage = record((await callTool(client, 'page', {
      action: 'create',
      blocks: [{ block_type: 'text', content: `B-only content ${tokenB}` }],
      importance: 0.66,
      tags: ['recovery-smoke', 'b-only'],
      title: `B-only page ${tokenB}`,
      workspace_id: ids.workspaceId,
    })).result, 'B-only page/create');
    ids.bOnlyPageId = getString(bOnlyPage, 'id');
    await assertSemanticState(client, ids.workspaceId, tokenB, tokenA);
  });
  await withModuleMcp(async (client) => {
    const loaded = await callModule(client, 'issues', {
      action: 'issue.get', input: { include_comments: true, include_links: true, issue: ids.issueId },
    });
    const issue = record(loaded.issue, 'Issue state before B');
    await callModule(client, 'issues', {
      action: 'issue.update',
      input: {
        issue: ids.issueId,
        revision: getRevision(issue, 'Issue state before B'),
        status: 'done',
        tags: ['recovery-smoke', 'state-b'],
        title: `Issue state B ${tokenB}`,
      },
    });
    await callModule(client, 'issues', {
      action: 'comment.add',
      input: { author: 'recovery-smoke', body: `Issue comment B ${tokenB}`, issue: ids.issueId },
    });
    const links = await callModule<unknown[]>(client, 'issues', {
      action: 'link.list', input: { include_archived: true, item_id: ids.issueId, item_type: 'issue' },
    });
    const issueLink = asArray(links, 'Issue links').map((value) => record(value, 'Issue link'))
      .find((value) => value.id === ids.issueLinkId);
    assert(issueLink, 'Page-Issue link disappeared before state B');
    await callModule(client, 'issues', {
      action: 'link.archive',
      input: { link_id: ids.issueLinkId, revision: getRevision(issueLink, 'Page-Issue link') },
    });
    const bOnly = await callModule(client, 'issues', {
      action: 'issue.create',
      input: {
        created_by: 'recovery-smoke',
        project_id: ids.issueProjectId,
        title: `B-only Issue ${tokenB}`,
      },
    });
    ids.bOnlyIssueId = getString(bOnly, 'id');
  });
}

async function assertSemanticState(
  client: McpClient,
  workspaceId: string,
  present: string,
  absent: string
): Promise<void> {
  const result = record((await callTool(client, 'search', {
    limit: 8,
    mode: 'rag',
    query: present,
    scope: { kind: 'workspace', types: ['page', 'row'], workspace_id: workspaceId },
  })).result, 'search/rag');
  const text = JSON.stringify(asArray(result.chunks, 'rag chunks'));
  assert(text.includes(present), `semantic search did not return ${present}`);
  assert(!text.includes(absent), `semantic search still returned ${absent}`);
  const absentResult = record((await callTool(client, 'search', {
    limit: 8,
    mode: 'rag',
    query: absent,
    scope: { kind: 'workspace', types: ['page', 'row'], workspace_id: workspaceId },
  })).result, 'search/rag absent token');
  const absentText = JSON.stringify(asArray(absentResult.chunks, 'absent rag chunks'));
  assert(!absentText.includes(absent), `B-only semantic content still exists for ${absent}`);
}

async function verifyMcpState(ids: StateIds, phase: 'A' | 'B'): Promise<void> {
  const present = phase === 'A' ? tokenA : tokenB;
  const absent = phase === 'A' ? tokenB : tokenA;
  await withMcp(async (client) => {
    const workspaceRecord = record((await callTool(client, 'workspace', {
      action: 'get', workspace_id: ids.workspaceId,
    })).result, 'workspace/get');
    assert(workspaceRecord.name === 'Recovery smoke workspace', 'workspace was not recovered');
    const page = record((await callTool(client, 'page', {
      action: 'get', page_id: ids.pageId,
    })).result, 'page/get');
    assert(String(page.title).includes(present), `page does not contain state ${phase}`);
    assert(!JSON.stringify(page).includes(absent), `page still contains the other state after ${phase}`);
    assert(getRevision(page, 'page/get') === (phase === 'A' ? 3 : 5),
      `page revision does not match restored state ${phase}`);
    assert(page.importance === (phase === 'A' ? 0.91 : 0.72),
      `page importance does not match restored state ${phase}`);
    assert(asArray(page.tags, 'page tags').includes(phase === 'A' ? 'state-a' : 'state-b'),
      `page tags do not match restored state ${phase}`);
    const database = record((await callTool(client, 'database', {
      action: 'get', database_id: ids.databaseId,
    })).result, 'database/get');
    assert(asArray(database.properties, 'database properties').length >= 2, 'typed properties were not recovered');
    const row = record((await callTool(client, 'row', {
      action: 'get', row_id: ids.rowId,
    })).result, 'row/get');
    assert(JSON.stringify(row).includes(present), `row does not contain state ${phase}`);
    assert(getRevision(row, 'row/get') === (phase === 'A' ? 1 : 2),
      `row revision does not match restored state ${phase}`);
    assert(row.importance === (phase === 'A' ? 0.93 : 0.74),
      `row importance does not match restored state ${phase}`);
    assert(asArray(row.tags, 'row tags').includes(phase === 'A' ? 'state-a' : 'state-b'),
      `row tags do not match restored state ${phase}`);
    const links = record((await callTool(client, 'link', {
      action: 'list', direction: 'both', include_archived: true,
      item_id: ids.pageId, item_type: 'page', workspace_id: ids.workspaceId,
    })).result, 'link/list');
    const restoredLink = asArray(links.items, 'restored links')
      .map((value) => record(value, 'restored link'))
      .find((value) => value.id === ids.linkId);
    assert(restoredLink, 'link was not recovered');
    assert((restoredLink.archived_at == null) === (phase === 'A'),
      `link archive state does not match restored state ${phase}`);
    const run = record((await callTool(client, 'run', {
      action: 'get', checkpoint_limit: 20, run_id: ids.runId,
    })).result, 'run/get');
    assert(run.status === 'completed', 'completed run was not recovered');
    assert(asArray(run.checkpoints, 'run checkpoints').length === 1, 'run checkpoint was not recovered');
    const archived = record((await callTool(client, 'page', {
      action: 'get', include_archived: true, page_id: ids.archivedPageId,
    })).result, 'archived page/get');
    assert(archived.archived_at != null, 'archived entity semantics were not recovered');
    assert(ids.bOnlyPageId, 'B-only page identifier was not retained for recovery checks');
    if (phase === 'A') {
      const bOnlyMissing = await callToolEnvelope(client, 'page', {
        action: 'get', include_archived: true, page_id: ids.bOnlyPageId,
      });
      assert(!bOnlyMissing.ok && bOnlyMissing.error?.code === 'NOT_FOUND',
        'A recovery did not remove the B-only page');
    } else {
      const bOnlyPage = record((await callTool(client, 'page', {
        action: 'get', page_id: ids.bOnlyPageId,
      })).result, 'B-only page/get');
      assert(JSON.stringify(bOnlyPage).includes(tokenB), 'B recovery did not restore the B-only page');
    }
    const resume = record((await callTool(client, 'session', {
      action: 'resume', max_items: 20, session_id: ids.sessionId, workspace_id: ids.workspaceId,
    })).result, 'session/resume');
    assert(asArray(resume.recent_runs, 'recent runs').length > 0, 'resumable session lost its run');
    await assertSemanticState(client, ids.workspaceId, present, absent);
  });
  await verifyIssueState(ids, phase);
}

async function verifyIssueState(ids: StateIds, phase: 'A' | 'B'): Promise<void> {
  const present = phase === 'A' ? tokenA : tokenB;
  const absent = phase === 'A' ? tokenB : tokenA;
  await withModuleMcp(async (client) => {
    const project = await callModule(client, 'issues', {
      action: 'project.get', input: { project_id: ids.issueProjectId },
    });
    assert(project.project_key === ids.issueProjectKey, 'Issue Project was not recovered');
    const details = await callModule(client, 'issues', {
      action: 'issue.get',
      input: { include_comments: true, include_links: true, issue: ids.issueId },
    });
    const issue = record(details.issue, 'recovered Issue');
    assert(String(issue.title).includes(present), `Issue does not contain state ${phase}`);
    assert(!String(issue.title).includes(absent), `Issue retained the other state after ${phase}`);
    assert(issue.status === (phase === 'A' ? 'open' : 'done'), `Issue status does not match ${phase}`);
    const comments = asArray(details.comments, 'Issue comments');
    const commentText = JSON.stringify(comments);
    assert(commentText.includes(present), `Issue comments do not contain state ${phase}`);
    if (phase === 'A') {
      assert(!commentText.includes(tokenB), 'State A recovery retained the later Issue comment');
    } else {
      assert(commentText.includes(tokenA), 'State B recovery lost the original Issue comment history');
    }
    const subtasks = asArray(details.subtasks, 'Issue subtasks').map((value) => record(value, 'Issue subtask'));
    assert(subtasks.some((subtask) => subtask.id === ids.childIssueId), 'Issue subtask was not recovered');
    const dependencies = await callModule<unknown[]>(client, 'issues', {
      action: 'dependency.list', input: { issue: ids.childIssueId },
    });
    assert(dependencies.map((value) => record(value, 'Issue dependency'))
      .some((dependency) => dependency.id === ids.dependencyId), 'Issue dependency was not recovered');
    const links = await callModule<unknown[]>(client, 'issues', {
      action: 'link.list',
      input: { include_archived: true, item_id: ids.issueId, item_type: 'issue' },
    });
    const issueLink = links.map((value) => record(value, 'Page-Issue link'))
      .find((link) => link.id === ids.issueLinkId);
    assert(issueLink, 'Page-Issue link was not recovered');
    assert((issueLink.archived_at == null) === (phase === 'A'),
      `Page-Issue link archive state does not match ${phase}`);
    const queried = await callModule<unknown[]>(client, 'issues', {
      action: 'issue.query',
      input: { query: `project = ${ids.issueProjectKey} AND text ~ "${present}"` },
    });
    assert(queried.map((value) => record(value, 'queried Issue')).some((candidate) => candidate.id === ids.issueId),
      `Issue query did not find state ${phase}`);
    assert(ids.bOnlyIssueId, 'B-only Issue identifier was not retained');
    if (phase === 'A') {
      const missing = await client.callTool({
        name: 'issues', arguments: { action: 'issue.get', input: { issue: ids.bOnlyIssueId } },
      });
      const envelope = record(missing.structuredContent, 'missing B-only Issue envelope');
      assert(envelope.ok === false, 'A recovery did not remove the B-only Issue');
    } else {
      const bOnly = await callModule(client, 'issues', {
        action: 'issue.get', input: { issue: ids.bOnlyIssueId },
      });
      assert(JSON.stringify(bOnly).includes(tokenB), 'B recovery did not restore the B-only Issue');
    }
  });
}

async function verifySqlState(
  ids: StateIds,
  phase: 'A' | 'B',
  ownershipNormalized = false
): Promise<void> {
  const config = await runtimeConfig();
  const client = new PostgresClient({ connectionString: databaseUrl(config) });
  await client.connect();
  try {
    const result = await client.query<{
      block_content: string;
      page_title: string;
      row_name: string;
    }>(`
      SELECT p.title AS page_title, b.content AS block_content, rv.value_text AS row_name
      FROM pages p
      JOIN blocks b ON b.page_id = p.id AND b.archived_at IS NULL
      JOIN database_rows r ON r.id = $2
      JOIN database_row_values rv ON rv.row_id = r.id
      JOIN database_properties dp ON dp.id = rv.property_id AND dp.name = 'Name'
      WHERE p.id = $1
    `, [ids.pageId, ids.rowId]);
    const row = result.rows[0];
    const present = phase === 'A' ? tokenA : tokenB;
    const absent = phase === 'A' ? tokenB : tokenA;
    assert(row != null && JSON.stringify(row).includes(present), `SQL did not expose state ${phase}`);
    const issueState = await client.query<{
      dependency_id: string;
      issue_link_archived_at: string | null;
      issue_title: string;
      parent_issue_id: string;
    }>(`
      SELECT issue.title AS issue_title,
             child.parent_issue_id::text,
             dependency.id::text AS dependency_id,
             issue_link.archived_at::text AS issue_link_archived_at
      FROM issues issue
      JOIN issues child ON child.id = $2
      JOIN issue_dependencies dependency ON dependency.id = $3
      JOIN record_links issue_link ON issue_link.id = $4
      WHERE issue.id = $1
    `, [ids.issueId, ids.childIssueId, ids.dependencyId, ids.issueLinkId]);
    const recoveredIssue = issueState.rows[0];
    assert(recoveredIssue?.issue_title.includes(present), `SQL Issue does not expose state ${phase}`);
    assert(recoveredIssue?.parent_issue_id === ids.issueId, 'SQL did not recover the subtask relationship');
    assert(recoveredIssue?.dependency_id === ids.dependencyId, 'SQL did not recover the Issue dependency');
    assert((recoveredIssue?.issue_link_archived_at == null) === (phase === 'A'),
      `SQL Page-Issue link archive state does not match ${phase}`);
    assert(!JSON.stringify(row).includes(absent), `SQL exposed stale ${absent}`);
    const invariant = await client.query<{ left_value: number; owner: string; right_value: number }>(
      `SELECT i.left_value, i.right_value, pg_catalog.pg_get_userbyid(c.relowner) AS owner
       FROM recovery_smoke_invariant i
       JOIN pg_catalog.pg_class c ON c.relname = 'recovery_smoke_invariant'`
    );
    assert(invariant.rows[0]?.left_value === invariant.rows[0]?.right_value, 'backup captured a torn transaction');
    if (ownershipNormalized) {
      assert(invariant.rows[0]?.owner === config.database_user, 'recovery did not normalize table ownership');
    }
  } finally {
    await client.end();
  }
}

async function prepareConcurrentInvariant(config: LocalRuntimeConfig): Promise<() => Promise<void>> {
  const admin = new PostgresClient({ connectionString: databaseUrl(config) });
  await admin.connect();
  await admin.query(`
    CREATE TABLE recovery_smoke_invariant (singleton boolean PRIMARY KEY DEFAULT true, left_value integer NOT NULL, right_value integer NOT NULL);
    INSERT INTO recovery_smoke_invariant (left_value, right_value) VALUES (0, 0);
    DO $body$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'recovery_smoke_owner') THEN
        CREATE ROLE recovery_smoke_owner;
      END IF;
    END $body$;
    ALTER TABLE recovery_smoke_invariant OWNER TO recovery_smoke_owner;
  `);
  await admin.end();

  const writer = new PostgresClient({ connectionString: databaseUrl(config) });
  await writer.connect();
  let stopping = false;
  const writing = (async () => {
    let value = 1;
    while (!stopping) {
      await writer.query(
        'UPDATE recovery_smoke_invariant SET left_value = $1, right_value = $1',
        [value]
      );
      value += 1;
      await sleep(5);
    }
  })();
  return async () => {
    stopping = true;
    await writing;
    await writer.end();
  };
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function waitForPortOpen(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await portOpen(port)) return true;
    await sleep(50);
  }
  return false;
}

async function observeRecovery(path: string): Promise<{
  result: CommandResult;
  sawUnavailable: boolean;
}> {
  const config = await runtimeConfig();
  assert(await portOpen(config.database_port), 'published PostgreSQL was not reachable before recovery');
  const child = spawn(process.execPath, [launcher, 'recover', path, '--yes'], {
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  let done = false;
  const exit = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      done = true;
      resolve(code ?? 1);
    });
  });
  let sawUnavailable = false;
  while (!done) {
    if (!await portOpen(config.database_port)) sawUnavailable = true;
    await sleep(50);
  }
  const result = { code: await exit, stderr: await stderr, stdout: await stdout };
  assert(
    await waitForPortOpen(config.database_port),
    `recovery did not restore published PostgreSQL\n${result.stderr}`
  );
  return { result, sawUnavailable };
}

async function recoverWithPortIsolation(path: string): Promise<CommandResult> {
  const { result, sawUnavailable } = await observeRecovery(path);
  assert(result.code === 0, `confirmed recovery failed\n${result.stderr}`);
  assert(sawUnavailable, 'normal PostgreSQL host port never closed during isolated recovery');
  return result;
}

async function recoverExpectingFailure(
  path: string,
  requireExclusiveWindow: boolean
): Promise<CommandResult> {
  const { result, sawUnavailable } = await observeRecovery(path);
  assert(result.code !== 0, 'invalid recovery unexpectedly succeeded');
  if (requireExclusiveWindow) {
    assert(sawUnavailable, `restore failure did not reach the exclusive recovery window\n${result.stderr}`);
  }
  return result;
}

async function interruptBackup(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  const signalProbe = join(smokeRoot, `${signal.toLowerCase()}-probe.hlbackup`);
  const child = spawn(process.execPath, [launcher, 'backup', signalProbe], {
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = collect(child.stderr);
  await sleep(150);
  child.kill(signal);
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (value) => resolve(value ?? 1));
  });
  const diagnostics = await stderr;
  assert(code !== 0, `${signal} backup unexpectedly succeeded`);
  assert(diagnostics.includes(`interrupted by ${signal}`),
    `backup did not defer ${signal} safely\n${diagnostics}`);
  await stat(signalProbe).then(
    () => { throw new Error('interrupted backup published a final artifact'); },
    (error: NodeJS.ErrnoException) => assert(error.code === 'ENOENT', 'cannot inspect interrupted destination')
  );
}

async function interruptRecoveryDuringExclusiveWindow(path: string): Promise<void> {
  const config = await runtimeConfig();
  const child = spawn(process.execPath, [launcher, 'recover', path, '--yes'], {
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = collect(child.stderr);
  let signaled = false;
  let done = false;
  const exit = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      done = true;
      resolve(code ?? 1);
    });
  });
  while (!done && !signaled) {
    if (!await portOpen(config.database_port)) {
      signaled = child.kill('SIGINT');
      break;
    }
    await sleep(25);
  }
  const code = await exit;
  const diagnostics = await stderr;
  assert(signaled, 'recovery never entered its exclusive window for SIGINT proof');
  assert(code !== 0, 'interrupted recovery unexpectedly succeeded');
  assert(diagnostics.includes('interrupted by SIGINT'), `recovery did not report SIGINT\n${diagnostics}`);
  assert(await portOpen(config.database_port), 'interrupted recovery did not restore published PostgreSQL');
  const containers = await runExecutable('docker', [
    'ps',
    '-a',
    '--filter',
    `label=com.docker.compose.project=${config.compose_project}`,
    '--format',
    '{{.Names}}',
  ]);
  assert(!containers.stdout.split(/\r?\n/u).some((name) => name.includes('recovery')),
    'interrupted recovery abandoned a one-off PostgreSQL container');
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  assert(address != null && typeof address === 'object', 'could not reserve dashboard port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function verifyDashboardState(ids: StateIds, phase: 'A' | 'B'): Promise<void> {
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [launcher, 'dashboard'], {
    env: cleanEnvironment({ DASHBOARD_PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = collect(child.stderr);
  try {
    let ready = false;
    for (let attempts = 0; attempts < 100; attempts += 1) {
      try {
        const response = await fetch(`${baseUrl}/api/status`);
        if (response.ok) {
          const status = await response.json() as JsonObject;
          ready = status.database === 'connected';
          if (ready) break;
        }
      } catch {
        // The dashboard may not be listening yet.
      }
      await sleep(100);
    }
    assert(ready, `packed dashboard did not become ready\n${await Promise.race([stderr, sleep(1).then(() => '')])}`);
    const call = async (tool: string, body: JsonObject) => {
      const response = await fetch(`${baseUrl}/api/tools/${tool}`, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', origin: baseUrl, 'sec-fetch-site': 'same-origin' },
        method: 'POST',
      });
      assert(response.ok, `dashboard ${tool} returned HTTP ${response.status}`);
      return asRecord(await response.json(), `dashboard ${tool} returned invalid JSON`);
    };
    const workspaceEnvelope = await call('workspace', { action: 'get', workspace_id: ids.workspaceId });
    assert(workspaceEnvelope.ok === true, 'dashboard could not read recovered workspace');
    const pageEnvelope = await call('page', { action: 'get', page_id: ids.pageId });
    const present = phase === 'A' ? tokenA : tokenB;
    assert(JSON.stringify(pageEnvelope).includes(present), `dashboard did not expose state ${phase}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
  }
}

function receiptPath(stderr: string, label: string): string {
  const match = stderr.match(new RegExp(`${label}: (.+\\.hlbackup)`));
  assert(match?.[1], `receipt did not include ${label}`);
  return match[1];
}

async function synthesizeRestoreFailureArtifact(): Promise<void> {
  const inspection = await inspectBackupArtifact(explicitBackup);
  const source = await readFile(explicitBackup);
  const payload = source.subarray(inspection.payloadOffset);
  assert(payload.length > 4096, 'PostgreSQL archive was unexpectedly small');
  await writeFile(restoreFailurePayload, payload.subarray(0, payload.length - 2048), { mode: 0o600 });
  const { payload: _payload, ...manifest } = inspection.manifest;
  await createBackupArtifact({
    destination: restoreFailureBackup,
    manifest: manifest as BackupManifestInput,
    payloadPath: restoreFailurePayload,
  });
}

async function assertPrivateArtifact(path: string): Promise<void> {
  const inspection = await inspectBackupArtifact(path);
  assert(inspection.manifest.contents.derived_search_index_included === false, 'artifact included Qdrant');
  if (process.platform !== 'win32') {
    assert(((await stat(path)).mode & 0o777) === 0o600, 'Backup artifact was not mode 0600');
  }
}

async function assertManagedDockerResourcesRemoved(composeProject: string): Promise<void> {
  const label = `label=com.docker.compose.project=${composeProject}`;
  const resources = await Promise.all([
    runExecutable('docker', ['ps', '-a', '--filter', label, '--format', '{{.ID}}']),
    runExecutable('docker', ['volume', 'ls', '--filter', label, '--format', '{{.Name}}']),
    runExecutable('docker', ['network', 'ls', '--filter', label, '--format', '{{.Name}}']),
  ]);
  assert(resources.every((result) => result.stdout.trim() === ''),
    `reset left Docker resources for ${composeProject}`);
  await readFile(configPath).then(
    () => { throw new Error('reset left runtime.json behind'); },
    (error: NodeJS.ErrnoException) => assert(error.code === 'ENOENT', 'cannot inspect reset config')
  );
}

async function main(): Promise<void> {
  assert((await lstat(launcher)).isFile(), 'packed launcher is missing');
  await runCli(['setup', '--non-interactive', '--modules', 'knowledge', '--skills', 'none']);
  await withModuleMcp(async () => undefined, ['knowledge']);
  await runCli(['setup', '--non-interactive', '--modules', 'issues', '--skills', 'none']);
  await withModuleMcp(async () => undefined, ['issues']);
  await runCli(['setup', '--non-interactive', '--modules', 'both', '--skills', 'none']);
  await withModuleMcp(async () => undefined);
  const projectConfigText = await readFile(projectConfigPath, 'utf8');
  const projectConfig = record(JSON.parse(projectConfigText), 'project configuration');
  assert(JSON.stringify(projectConfig.modules) === JSON.stringify(['knowledge', 'issues']),
    'non-interactive packaged setup did not select both modules');
  assert(!projectConfigText.includes('password') && !projectConfigText.includes('database_url'),
    'project configuration contains runtime credentials');
  let config = await runtimeConfig();
  const ids = await createStateA();
  const stopWriter = await prepareConcurrentInvariant(config);
  try {
    await runCli(['backup', explicitBackup]);
  } finally {
    await stopWriter();
  }
  await assertPrivateArtifact(explicitBackup);

  const defaultA = receiptPath((await runCli(['backup'])).stderr, 'Backup created');
  await assertPrivateArtifact(defaultA);
  const originalHash = (await inspectBackupArtifact(explicitBackup)).manifest.payload.sha256;
  const collision = await runCli(['backup', explicitBackup], 1);
  assert(collision.stderr.includes('already exists'), 'destination collision was not refused');
  assert((await inspectBackupArtifact(explicitBackup)).manifest.payload.sha256 === originalHash, 'collision changed artifact');

  await writeFile(`${configPath}.setup.lock`, JSON.stringify({ pid: process.pid, token: 'smoke-lock' }), { mode: 0o600 });
  try {
    const locked = await runCli(['backup', collisionProbe], 1);
    assert(locked.stderr.includes('lifecycle command is already running'),
      `overlapping lifecycle operation was not refused: ${locked.stderr}`);
  } finally {
    await unlink(`${configPath}.setup.lock`);
  }
  await interruptBackup('SIGINT');
  await interruptBackup('SIGTERM');

  const preview = await runCli(['recover', explicitBackup], 1);
  assert(preview.stderr.includes('no changes were made'), 'preview did not state that it is read-only');
  assert(preview.stderr.includes(`horizonlayer recover '${explicitBackup}' --yes`), 'preview omitted exact confirmation');
  assert(!preview.stderr.includes(config.database_password), 'preview leaked the runtime password');

  await mutateToStateB(ids);
  await verifySqlState(ids, 'B');

  const originalBytes = await readFile(explicitBackup);
  const corruptedBytes = Buffer.from(originalBytes);
  corruptedBytes[corruptedBytes.length - 1] ^= 0xff;
  await writeFile(corruptedBackup, corruptedBytes, { mode: 0o600 });
  const corruptResult = await runCli(['recover', corruptedBackup, '--yes'], 1);
  assert(corruptResult.stderr.includes('validation failed'), 'checksum corruption was not rejected before recovery');
  await verifySqlState(ids, 'B');
  await runCli(['doctor']);

  await synthesizeRestoreFailureArtifact();
  const restoreFailure = await recoverExpectingFailure(restoreFailureBackup, true);
  assert(
    restoreFailure.stderr.includes('Runtime Recovery') || restoreFailure.stderr.includes('pg_restore'),
    'truncated PostgreSQL archive did not fail recovery'
  );
  await verifySqlState(ids, 'B');
  await runCli(['doctor']);

  await interruptRecoveryDuringExclusiveWindow(explicitBackup);
  await verifySqlState(ids, 'B');
  await runCli(['doctor']);

  const configBeforeA = await readFile(configPath, 'utf8');
  const recoveredA = await recoverWithPortIsolation(explicitBackup);
  assert(await readFile(configPath, 'utf8') === configBeforeA, 'recovery changed runtime.json');
  const safetyBackup = receiptPath(recoveredA.stderr, 'Safety Backup retained');
  await assertPrivateArtifact(safetyBackup);
  await verifySqlState(ids, 'A', true);
  await verifyMcpState(ids, 'A');
  await verifyDashboardState(ids, 'A');
  await runCli(['doctor']);

  await runCli(['recover', safetyBackup], 1);
  const configBeforeB = await readFile(configPath, 'utf8');
  await recoverWithPortIsolation(safetyBackup);
  assert(await readFile(configPath, 'utf8') === configBeforeB, 'safety recovery changed runtime.json');
  await verifySqlState(ids, 'B', true);
  await verifyMcpState(ids, 'B');
  await verifyDashboardState(ids, 'B');

  const preResetBackup = receiptPath((await runCli(['backup'])).stderr, 'Backup created');
  await assertPrivateArtifact(preResetBackup);
  await runCli(['reset', '--yes']);
  await stat(preResetBackup);
  await runCli(['setup']);
  config = await runtimeConfig();
  const newConfigBeforeRecovery = await readFile(configPath, 'utf8');
  await recoverWithPortIsolation(preResetBackup);
  assert(await readFile(configPath, 'utf8') === newConfigBeforeRecovery, 'post-reset recovery changed new runtime.json');
  await verifySqlState(ids, 'B', true);
  await verifyMcpState(ids, 'B');
  await verifyDashboardState(ids, 'B');

  const currentConfig = await readFile(configPath, 'utf8');
  const currentBytes = await readFile(preResetBackup);
  const corruptAfterReset = Buffer.from(currentBytes);
  corruptAfterReset[corruptAfterReset.length - 1] ^= 0xff;
  const postResetCorruption = join(smokeRoot, 'post-reset-corrupt.hlbackup');
  await writeFile(postResetCorruption, corruptAfterReset, { mode: 0o600 });
  await runCli(['recover', postResetCorruption, '--yes'], 1);
  assert(await readFile(configPath, 'utf8') === currentConfig, 'corrupt recovery changed runtime.json');
  await verifySqlState(ids, 'B', true);
  await runCli(['doctor']);

  const finalComposeProject = (await runtimeConfig()).compose_project;
  await runCli(['reset', '--yes']);
  await assertManagedDockerResourcesRemoved(finalComposeProject);

  console.log(JSON.stringify({
    artifacts: { defaultA, explicitBackup, preResetBackup, safetyBackup },
    packedLauncher: launcher,
    proofs: {
      artifact_permissions_and_collision: true,
      canonical_sql_mcp_dashboard: true,
      checksum_refusal_preserves_runtime: true,
      concurrent_snapshot_invariant: true,
      derived_index_rebuilt_from_canonical: true,
      lifecycle_lock_refusal: true,
      packed_public_cli: true,
      packaged_selected_module_mcp: true,
      postgres_owner_normalization: true,
      recovery_port_isolation: true,
      reset_survival: true,
      safety_backup_round_trip: true,
      signal_safe_backup_and_recovery: true,
      issues_and_cross_domain_links: true,
      transactional_restore_failure_preserves_state: true,
      zero_leaked_docker_resources: true,
    },
    state: { tokenA, tokenB, ...ids },
  }, null, 2));
}

main().catch((error) => {
  console.error(`Recovery smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
