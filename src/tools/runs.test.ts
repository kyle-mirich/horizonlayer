import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServer } from '../mcp.js';

const startRunMock = vi.fn();
const getRunMock = vi.fn();
const listRunsMock = vi.fn();
const checkpointRunMock = vi.fn();
const completeRunMock = vi.fn();
const failRunMock = vi.fn();
const cancelRunMock = vi.fn();

vi.mock('../db/queries/runs.js', () => ({
  cancelRun: cancelRunMock,
  checkpointRun: checkpointRunMock,
  completeRun: completeRunMock,
  failRun: failRunMock,
  getRun: getRunMock,
  listRuns: listRunsMock,
  startRun: startRunMock,
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

  return import('./runs.js').then(({ registerRunTools }) => {
    registerRunTools(server);
    if (!definition) {
      throw new Error('Run tool was not registered');
    }
    return definition;
  });
}

describe('run tool', () => {
  beforeEach(() => {
    startRunMock.mockReset();
    getRunMock.mockReset();
    listRunsMock.mockReset();
    checkpointRunMock.mockReset();
    completeRunMock.mockReset();
    failRunMock.mockReset();
    cancelRunMock.mockReset();
  });

  it('starts runs through the start action', async () => {
    startRunMock.mockResolvedValue({
      id: 'run-1',
      status: 'running',
    });

    const tool = await buildTool();
    const response = await tool.execute(
      {
        action: 'start',
        agent_name: 'planner',
        session_id: '00000000-0000-0000-0000-0000000000ac',
        workspace_id: '00000000-0000-0000-0000-000000000010',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { result: { id: string } };
    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({
      agent_name: 'planner',
      session_id: '00000000-0000-0000-0000-0000000000ac',
      workspace_id: '00000000-0000-0000-0000-000000000010',
    }));
    expect(payload.result.id).toBe('run-1');
  });

  it('creates checkpoints through the checkpoint action', async () => {
    checkpointRunMock.mockResolvedValue({
      id: 'run-2',
      latest_checkpoint_sequence: 1,
    });

    const tool = await buildTool();
    const response = await tool.execute(
      {
        action: 'checkpoint',
        id: '00000000-0000-0000-0000-000000000020',
        state: { step: 'done' },
        summary: 'checkpoint',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { result: { latest_checkpoint_sequence: number } };
    expect(checkpointRunMock).toHaveBeenCalledWith(expect.objectContaining({
      run_id: '00000000-0000-0000-0000-000000000020',
      summary: 'checkpoint',
    }));
    expect(payload.result.latest_checkpoint_sequence).toBe(1);
  });

  it('lists runs with offset pagination metadata', async () => {
    listRunsMock.mockResolvedValue([
      {
        id: 'run-3',
      },
    ]);

    const tool = await buildTool();
    const response = await tool.execute(
      {
        action: 'list',
        limit: 1,
        offset: 0,
        workspace_id: '00000000-0000-0000-0000-000000000030',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { meta: { limit: number; offset: number }; result: Array<{ id: string }> };
    expect(listRunsMock).toHaveBeenCalledWith(expect.objectContaining({
      limit: 1,
      offset: 0,
      workspace_id: '00000000-0000-0000-0000-000000000030',
    }));
    expect(payload.result[0]?.id).toBe('run-3');
    expect(payload.meta).toEqual({ limit: 1, offset: 0 });
  });

  it('rejects removed keys and requires explicit action', async () => {
    const tool = await buildTool();
    expect(tool.parameters.safeParse({ workspace_id: '00000000-0000-0000-0000-000000000030' }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'list', cursor: 'abc', workspace_id: '00000000-0000-0000-0000-000000000030' }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'start', dry_run: true, workspace_id: '00000000-0000-0000-0000-000000000030' }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'list', op: 'list', workspace_id: '00000000-0000-0000-0000-000000000030' }).success).toBe(false);
  });
});
