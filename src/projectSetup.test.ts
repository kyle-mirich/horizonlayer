import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createIssueProject: vi.fn(), createWorkspace: vi.fn(),
  installAgentPlugins: vi.fn(), listIssueProjects: vi.fn(), listWorkspaces: vi.fn(),
}));
vi.mock('./db/queries/workspaces.js', () => ({
  createWorkspace: mocks.createWorkspace,
  listWorkspaces: mocks.listWorkspaces,
}));
vi.mock('./db/queries/issueProjects.js', () => ({
  createIssueProject: mocks.createIssueProject,
  listIssueProjects: mocks.listIssueProjects,
}));
vi.mock('./install.js', () => ({ installAgentPlugins: mocks.installAgentPlugins }));

import { bundledSkills, parseProjectSetupArgs, SETUP_USAGE, setupProject } from './projectSetup.js';

const directories: string[] = [];
const workspace = { id: '00000000-0000-4000-8000-000000000001', name: 'Default' };
const issueProject = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'sample-project',
  project_key: 'SAMPLEPROJECT',
};

async function temporaryProject(name = 'sample-project') {
  const root = await mkdtemp(join(tmpdir(), 'horizonlayer-project-'));
  const path = join(root, name);
  directories.push(root);
  return path;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listWorkspaces.mockResolvedValue([]);
  mocks.createWorkspace.mockResolvedValue(workspace);
  mocks.listIssueProjects.mockResolvedValue([]);
  mocks.createIssueProject.mockResolvedValue(issueProject);
  mocks.installAgentPlugins.mockResolvedValue([{ host: 'Codex', path: '/plugin' }]);
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('project setup', () => {
  it('maps enabled modules to their bundled skills', () => {
    expect(bundledSkills(['knowledge'])).toEqual(['knowledge']);
    expect(bundledSkills(['issues'])).toEqual(['issues']);
    expect(bundledSkills(['knowledge', 'issues'])).toEqual(['knowledge', 'issues']);
  });

  it('bootstraps both modules, writes credential-free committed config, and installs selected skills', async () => {
    const directory = await temporaryProject();
    const result = await setupProject({
      directory, interactive: false, modules: ['knowledge', 'issues'], skills: 'codex',
    });

    expect(result.config).toEqual({
      version: 1,
      modules: ['knowledge', 'issues'],
      knowledge: { workspace_name: 'Default' },
      issues: {
        project_key: 'SAMPLEPROJECT',
        project_name: 'sample-project',
      },
    });
    expect(mocks.installAgentPlugins).toHaveBeenCalledWith('codex', {
      skills: ['knowledge', 'issues'],
    });
    const serialized = await readFile(result.configPath, 'utf8');
    expect(serialized).not.toMatch(/password|database_url|token|secret/iu);
  });

  it('is idempotent and reuses stored canonical records on rerun', async () => {
    const directory = await temporaryProject();
    await setupProject({ directory, interactive: false, modules: ['knowledge', 'issues'], skills: 'none' });
    vi.clearAllMocks();
    mocks.listWorkspaces.mockResolvedValue([workspace]);
    mocks.listIssueProjects.mockResolvedValue([issueProject]);

    await setupProject({ directory, interactive: false, skills: 'none' });
    expect(mocks.listWorkspaces).toHaveBeenCalled();
    expect(mocks.listIssueProjects).toHaveBeenCalled();
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
    expect(mocks.createIssueProject).not.toHaveBeenCalled();
  });

  it('changes selected modules without deleting reusable resource references', async () => {
    const directory = await temporaryProject();
    await setupProject({ directory, interactive: false, modules: ['knowledge', 'issues'], skills: 'none' });
    vi.clearAllMocks();
    mocks.listWorkspaces.mockResolvedValue([workspace]);

    const changed = await setupProject({
      directory, interactive: false, modules: ['knowledge'], skills: 'none',
    });
    expect(changed.config.modules).toEqual(['knowledge']);
    expect(changed.config.issues).toEqual(expect.objectContaining({ project_key: issueProject.project_key }));
    expect(mocks.listIssueProjects).not.toHaveBeenCalled();
    expect(mocks.installAgentPlugins).not.toHaveBeenCalled();
  });

  it('reuses a workspace after the first resource page', async () => {
    const directory = await temporaryProject();
    mocks.listWorkspaces
      .mockResolvedValueOnce(Array.from({ length: 101 }, (_value, index) => ({
        id: `workspace-${index}`, name: `Other workspace ${index}`,
      })))
      .mockResolvedValueOnce([workspace]);

    const result = await setupProject({ directory, interactive: false, modules: ['knowledge'], skills: 'none' });

    expect(result.config.knowledge).toEqual({ workspace_name: 'Default' });
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
    expect(mocks.listWorkspaces).toHaveBeenNthCalledWith(1, { limit: 101, offset: 0 });
    expect(mocks.listWorkspaces).toHaveBeenNthCalledWith(2, { limit: 101, offset: 101 });
  });

  it('reuses a saved Issue Project after the first resource page', async () => {
    const directory = await temporaryProject();
    await setupProject({ directory, interactive: false, modules: ['issues'], skills: 'none' });
    vi.clearAllMocks();
    mocks.listIssueProjects
      .mockResolvedValueOnce(Array.from({ length: 101 }, (_value, index) => ({
        id: `project-${index}`, project_key: `P${index}`, name: `Other project ${index}`,
      })))
      .mockResolvedValueOnce([issueProject]);

    const result = await setupProject({ directory, interactive: false, skills: 'none' });

    expect(result.config.issues).toEqual({ project_key: 'SAMPLEPROJECT', project_name: 'sample-project' });
    expect(mocks.createIssueProject).not.toHaveBeenCalled();
    expect(mocks.listIssueProjects).toHaveBeenNthCalledWith(2, {
      include_archived: true, limit: 101, offset: 101,
    });
  });

  it('reserves project keys appearing after the first resource page', async () => {
    const directory = await temporaryProject();
    mocks.listIssueProjects
      .mockResolvedValueOnce(Array.from({ length: 101 }, (_value, index) => ({
        id: `project-${index}`, project_key: `P${index}`, name: `Other project ${index}`,
      })))
      .mockResolvedValueOnce([
        { ...issueProject, project_key: 'SAMPLEPROJECT', name: 'Another project' },
        { ...issueProject, project_key: 'SAMPLEPROJECT2', name: 'Another project two' },
      ]);
    mocks.createIssueProject.mockResolvedValue({ ...issueProject, project_key: 'SAMPLEPROJECT3' });

    const result = await setupProject({ directory, interactive: false, modules: ['issues'], skills: 'none' });

    expect(mocks.createIssueProject).toHaveBeenCalledWith({
      name: 'sample-project', project_key: 'SAMPLEPROJECT3',
    });
    expect(result.config.issues?.project_key).toBe('SAMPLEPROJECT3');
  });

  it('reuses a renamed saved Issue Project by its immutable key', async () => {
    const directory = await temporaryProject();
    await setupProject({ directory, interactive: false, modules: ['issues'], skills: 'none' });
    vi.clearAllMocks();
    mocks.listIssueProjects.mockResolvedValue([{ ...issueProject, name: 'Renamed project' }]);

    const result = await setupProject({ directory, interactive: false, skills: 'none' });

    expect(mocks.createIssueProject).not.toHaveBeenCalled();
    expect(result.config.issues).toEqual({ project_key: 'SAMPLEPROJECT', project_name: 'Renamed project' });
  });

  it('keeps archived project keys reserved without reusing the archived project', async () => {
    const directory = await temporaryProject();
    mocks.listIssueProjects.mockImplementation(async (params: { include_archived?: boolean }) => (
      params.include_archived ? [{ ...issueProject, archived_at: '2026-10-01T00:00:00.000Z' }] : []
    ));
    mocks.createIssueProject.mockResolvedValue({ ...issueProject, project_key: 'SAMPLEPROJECT2' });

    const result = await setupProject({ directory, interactive: false, modules: ['issues'], skills: 'none' });

    expect(mocks.listIssueProjects).toHaveBeenCalledWith({ include_archived: true, limit: 101, offset: 0 });
    expect(mocks.createIssueProject).toHaveBeenCalledWith({ name: 'sample-project', project_key: 'SAMPLEPROJECT2' });
    expect(result.config.issues?.project_key).toBe('SAMPLEPROJECT2');
  });

  it('matches active canonical resource names without surrounding spaces or case differences', async () => {
    const directory = await temporaryProject();
    mocks.listWorkspaces.mockResolvedValue([{ ...workspace, name: '  DEFAULT  ' }]);
    mocks.listIssueProjects.mockResolvedValue([{
      ...issueProject, name: '  SAMPLE-PROJECT  ', project_key: 'EXISTING',
    }]);

    const result = await setupProject({ directory, interactive: false, skills: 'none' });

    expect(mocks.createWorkspace).not.toHaveBeenCalled();
    expect(mocks.createIssueProject).not.toHaveBeenCalled();
    expect(result.config.knowledge?.workspace_name).toBe('  DEFAULT  ');
    expect(result.config.issues).toEqual({ project_key: 'EXISTING', project_name: '  SAMPLE-PROJECT  ' });
  });

  it('supports interactive choices and declining skill installation', async () => {
    const directory = await temporaryProject();
    const answers = ['issues', 'none'];
    const ask = vi.fn(async () => answers.shift()!);
    const result = await setupProject({ directory, interactive: true, ask });
    expect(result.config.modules).toEqual(['issues']);
    expect(result.skills).toBe('none');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(mocks.installAgentPlugins).not.toHaveBeenCalled();
  });

  it('parses explicit non-interactive module and supported-host paths', () => {
    expect(parseProjectSetupArgs([
      '--non-interactive', '--modules', 'knowledge', '--skills=claude',
    ])).toEqual({ interactive: false, modules: ['knowledge'], skills: 'claude' });
    expect(parseProjectSetupArgs(['--yes', '--modules=both', '--skills', 'both'])).toEqual({
      interactive: false,
      modules: ['knowledge', 'issues'],
      skills: 'all',
    });
    expect(() => parseProjectSetupArgs(['--modules'])).toThrow('requires a value');
    expect(() => parseProjectSetupArgs(['--unknown'])).toThrow('Unknown setup option');
  });

  it('answers setup --help with usage instead of an unknown-option failure', () => {
    for (const args of [['--help'], ['-h'], ['help'], ['--modules', 'knowledge', '--help']]) {
      expect(() => parseProjectSetupArgs(args)).toThrow(SETUP_USAGE);
    }
    expect(SETUP_USAGE).toContain('horizonlayer setup');
  });
});
