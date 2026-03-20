import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServer } from '../mcp.js';

const createTaskMock = vi.fn();
const getTaskMock = vi.fn();
const listTasksMock = vi.fn();
const claimTaskMock = vi.fn();
const heartbeatTaskMock = vi.fn();
const completeTaskMock = vi.fn();
const failTaskMock = vi.fn();
const handoffTaskMock = vi.fn();
const acknowledgeTaskMock = vi.fn();
const appendTaskEventMock = vi.fn();
const listInboxMock = vi.fn();
const acknowledgeInboxItemMock = vi.fn();

vi.mock('../db/queries/tasks.js', () => ({
  acknowledgeInboxItem: acknowledgeInboxItemMock,
  acknowledgeTask: acknowledgeTaskMock,
  appendTaskEvent: appendTaskEventMock,
  claimTask: claimTaskMock,
  completeTask: completeTaskMock,
  createTask: createTaskMock,
  failTask: failTaskMock,
  getTask: getTaskMock,
  handoffTask: handoffTaskMock,
  heartbeatTask: heartbeatTaskMock,
  listInbox: listInboxMock,
  listTasks: listTasksMock,
}));

function buildTool() {
  let definition:
    | {
        execute: (params: Record<string, unknown>, context: { session?: unknown }) => Promise<{ content: Array<{ text: string }> }>;
        parameters: { safeParse: (value: unknown) => { success: boolean } };
      }
    | null = null;

  const server = {
    addTool(toolDefinition: typeof definition) {
      definition = toolDefinition;
    },
  } as unknown as AppServer;

  return import('./tasks.js').then(({ registerTaskTools }) => {
    registerTaskTools(server);
    if (!definition) {
      throw new Error('Task tool was not registered');
    }
    return definition;
  });
}

describe('task tool', () => {
  beforeEach(() => {
    createTaskMock.mockReset();
    getTaskMock.mockReset();
    listTasksMock.mockReset();
    claimTaskMock.mockReset();
    heartbeatTaskMock.mockReset();
    completeTaskMock.mockReset();
    failTaskMock.mockReset();
    handoffTaskMock.mockReset();
    acknowledgeTaskMock.mockReset();
    appendTaskEventMock.mockReset();
    listInboxMock.mockReset();
    acknowledgeInboxItemMock.mockReset();
  });

  it('creates tasks through the create action', async () => {
    createTaskMock.mockResolvedValue({
      id: 'task-1',
      title: 'Task',
    });

    const tool = await buildTool();
    const response = await tool.execute(
      {
        action: 'create',
        session_id: '00000000-0000-0000-0000-0000000000aa',
        title: 'Task',
        workspace_id: '00000000-0000-0000-0000-000000000001',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { result: { id: string } };
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      session_id: '00000000-0000-0000-0000-0000000000aa',
      title: 'Task',
      workspace_id: '00000000-0000-0000-0000-000000000001',
    }));
    expect(payload.result.id).toBe('task-1');
  });

  it('claims tasks through the claim action', async () => {
    claimTaskMock.mockResolvedValue({
      id: 'task-2',
      status: 'claimed',
    });

    const tool = await buildTool();
    const response = await tool.execute(
      {
        action: 'claim',
        agent_name: 'planner',
        lease_seconds: 600,
        session_id: '00000000-0000-0000-0000-0000000000ab',
        workspace_id: '00000000-0000-0000-0000-000000000002',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { result: { status: string } };
    expect(claimTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      agent_name: 'planner',
      lease_seconds: 600,
      session_id: '00000000-0000-0000-0000-0000000000ab',
    }));
    expect(payload.result.status).toBe('claimed');
  });

  it('lists inbox items with offset pagination metadata', async () => {
    listInboxMock.mockResolvedValue([
      {
        id: 'inbox-1',
        agent_name: 'reviewer',
      },
    ]);

    const tool = await buildTool();
    const response = await tool.execute(
      {
        action: 'inbox_list',
        agent_name: 'reviewer',
        limit: 1,
        offset: 0,
        workspace_id: '00000000-0000-0000-0000-000000000003',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { meta: { limit: number; offset: number }; result: Array<{ id: string }> };
    expect(listInboxMock).toHaveBeenCalledWith(expect.objectContaining({
      agent_name: 'reviewer',
      limit: 1,
      offset: 0,
    }));
    expect(payload.result[0]?.id).toBe('inbox-1');
    expect(payload.meta).toEqual({ limit: 1, offset: 0 });
  });

  it('rejects removed keys and requires explicit action', async () => {
    const tool = await buildTool();
    expect(tool.parameters.safeParse({ workspace_id: '00000000-0000-0000-0000-000000000001' }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'list', cursor: 'abc', workspace_id: '00000000-0000-0000-0000-000000000001' }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'create', dry_run: true, workspace_id: '00000000-0000-0000-0000-000000000001' }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'list', op: 'list', workspace_id: '00000000-0000-0000-0000-000000000001' }).success).toBe(false);
  });
});
