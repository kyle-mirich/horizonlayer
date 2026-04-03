import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppServer } from '../mcp.js';

const createWorkspaceMock = vi.fn();
const listWorkspacesMock = vi.fn();
const getWorkspaceMock = vi.fn();
const updateWorkspaceMock = vi.fn();
const deleteWorkspaceMock = vi.fn();
const createSessionMock = vi.fn();
const listSessionsMock = vi.fn();
const getSessionMock = vi.fn();
const getSessionResumeBundleMock = vi.fn();
const closeSessionMock = vi.fn();

vi.mock('../db/queries/workspaces.js', () => ({
  createWorkspace: createWorkspaceMock,
  deleteWorkspace: deleteWorkspaceMock,
  getWorkspace: getWorkspaceMock,
  listWorkspaces: listWorkspacesMock,
  updateWorkspace: updateWorkspaceMock,
}));

vi.mock('../db/queries/sessions.js', () => ({
  closeSession: closeSessionMock,
  createSession: createSessionMock,
  getSession: getSessionMock,
  getSessionResumeBundle: getSessionResumeBundleMock,
  listSessions: listSessionsMock,
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

  return import('./workspaces.js').then(({ registerWorkspaceTools }) => {
    registerWorkspaceTools(server);
    if (!definition) {
      throw new Error('Workspace tool was not registered');
    }
    return definition;
  });
}

describe('workspace tool', () => {
  beforeEach(() => {
    createWorkspaceMock.mockReset();
    listWorkspacesMock.mockReset();
    getWorkspaceMock.mockReset();
    updateWorkspaceMock.mockReset();
    deleteWorkspaceMock.mockReset();
    createSessionMock.mockReset();
    listSessionsMock.mockReset();
    getSessionMock.mockReset();
    getSessionResumeBundleMock.mockReset();
    closeSessionMock.mockReset();
  });

  it('starts sessions inside an existing workspace', async () => {
    createSessionMock.mockResolvedValue({ id: 'session-1', workspace_id: 'ws-1' });
    const tool = await buildTool();

    const response = await tool.execute(
      {
        action: 'start_session',
        title: 'Focus',
        workspace_id: '00000000-0000-0000-0000-000000000001',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { result: { id: string } };
    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Focus',
      workspace_id: '00000000-0000-0000-0000-000000000001',
    }));
    expect(payload.result.id).toBe('session-1');
  });

  it('creates a workspace plus initial session through the compatibility helper', async () => {
    createWorkspaceMock.mockResolvedValue({ id: 'ws-compat', name: 'Compat Workspace' });
    createSessionMock.mockResolvedValue({ id: 'session-compat', workspace_id: 'ws-compat' });
    const tool = await buildTool();

    const response = await tool.execute(
      {
        action: 'create_session',
        name: 'Compat Workspace',
        title: 'Initial session',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { result: { workspace: { id: string }; session: { id: string } } };
    expect(createWorkspaceMock).toHaveBeenCalled();
    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: 'ws-compat' }));
    expect(payload.result.workspace.id).toBe('ws-compat');
    expect(payload.result.session.id).toBe('session-compat');
  });

  it('resumes session context through the session bundle query', async () => {
    getSessionResumeBundleMock.mockResolvedValue({ truncated: false, bytes: 10, max_bytes: 100, bundle: { session: { id: 'session-1' } } });
    const tool = await buildTool();

    const response = await tool.execute(
      {
        action: 'resume_session_context',
        max_bytes: 1024,
        max_items: 5,
        session_id: '00000000-0000-0000-0000-000000000002',
        workspace_id: '00000000-0000-0000-0000-000000000003',
      },
      { session: undefined }
    );

    const payload = JSON.parse(response.content[0].text) as { result: { truncated: boolean } };
    expect(getSessionResumeBundleMock).toHaveBeenCalledWith(expect.objectContaining({
      max_bytes: 1024,
      max_items: 5,
      session_id: '00000000-0000-0000-0000-000000000002',
      workspace_id: '00000000-0000-0000-0000-000000000003',
    }));
    expect(payload.result.truncated).toBe(false);
  });

  it('rejects removed keys and requires explicit action', async () => {
    const tool = await buildTool();
    expect(tool.parameters.safeParse({}).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'list', cursor: 'abc' }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'create', dry_run: true }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'list', op: 'list' }).success).toBe(false);
    expect(tool.parameters.safeParse({ action: 'cleanup_expired' }).success).toBe(false);
  });
});
