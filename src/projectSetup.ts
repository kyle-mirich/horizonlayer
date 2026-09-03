import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  createWorkspace,
  listWorkspaces,
} from './db/queries/workspaces.js';
import {
  createIssueProject,
  listIssueProjects,
} from './db/queries/issueProjects.js';
import { installAgentPlugins, type InstallResult, type InstallTarget } from './install.js';
import type { HorizonModule } from './tools/modules.js';

const PROJECT_CONFIG_VERSION = 1;
const PROJECT_CONFIG_NAME = '.horizonlayer.json';
const DEFAULT_WORKSPACE_NAME = 'Default';
const ALL_MODULES: HorizonModule[] = ['knowledge', 'issues'];

export type SkillInstallTarget = InstallTarget | 'none';

export interface ProjectConfig {
  version: 1;
  modules: HorizonModule[];
  knowledge?: { workspace_name: string };
  issues?: { project_key: string; project_name: string };
}

export interface ProjectSetupOptions {
  ask?: (question: string) => Promise<string>;
  directory?: string;
  interactive?: boolean;
  modules?: HorizonModule[];
  skills?: SkillInstallTarget;
}

export interface ProjectSetupResult {
  config: ProjectConfig;
  configPath: string;
  installed: InstallResult[];
  skills: SkillInstallTarget;
}

export interface ProjectSetupCliOptions {
  interactive?: boolean;
  modules?: HorizonModule[];
  skills?: SkillInstallTarget;
}

function parseModules(value: string): HorizonModule[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'both') return [...ALL_MODULES];
  if (normalized === 'knowledge' || normalized === 'kb') return ['knowledge'];
  if (normalized === 'issues' || normalized === 'issue') return ['issues'];
  throw new Error('Modules must be knowledge, issues, or both');
}

function parseSkills(value: string): SkillInstallTarget {
  const normalized = value.trim().toLowerCase();
  if (['none', 'codex', 'claude', 'all'].includes(normalized)) {
    return normalized as SkillInstallTarget;
  }
  if (normalized === 'both') return 'all';
  throw new Error('Skills must be none, codex, claude, or all');
}

export const SETUP_USAGE = 'Usage: horizonlayer setup [--modules knowledge|issues|both] [--skills none|codex|claude|all] [--non-interactive]';

export function parseProjectSetupArgs(args: string[]): ProjectSetupCliOptions {
  if (args.some((argument) => argument === '--help' || argument === '-h' || argument === 'help')) {
    throw new Error(SETUP_USAGE);
  }
  const result: ProjectSetupCliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--non-interactive' || argument === '--yes') {
      result.interactive = false;
      continue;
    }
    const [name, inlineValue] = argument.split('=', 2);
    if (name !== '--modules' && name !== '--skills') {
      throw new Error(`Unknown setup option: ${argument}`);
    }
    const value = inlineValue ?? args[index + 1];
    if (!value || (!inlineValue && value.startsWith('--'))) {
      throw new Error(`${name} requires a value`);
    }
    if (!inlineValue) index += 1;
    if (name === '--modules') result.modules = parseModules(value);
    else result.skills = parseSkills(value);
  }
  return result;
}

function parseProjectConfig(value: unknown): ProjectConfig {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Project configuration must be a JSON object');
  }
  const config = value as Partial<ProjectConfig>;
  const knowledgeValid = config.knowledge === undefined
    || (typeof config.knowledge.workspace_name === 'string'
      && config.knowledge.workspace_name.trim().length > 0);
  const issuesValid = config.issues === undefined
    || (typeof config.issues.project_key === 'string'
      && typeof config.issues.project_name === 'string'
      && config.issues.project_key.trim().length > 0
      && config.issues.project_name.trim().length > 0);
  if (config.version !== PROJECT_CONFIG_VERSION
    || !Array.isArray(config.modules)
    || config.modules.length === 0
    || config.modules.some((module) => !ALL_MODULES.includes(module))
    || !knowledgeValid
    || !issuesValid) {
    throw new Error('Project configuration is invalid or unsupported');
  }
  return config as ProjectConfig;
}

export function projectConfigPath(directory = process.cwd()): string {
  return join(resolve(directory), PROJECT_CONFIG_NAME);
}

export async function readProjectConfig(path = projectConfigPath()): Promise<ProjectConfig | null> {
  try {
    return parseProjectConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read HorizonLayer project configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeProjectConfig(config: ProjectConfig, path: string): Promise<void> {
  parseProjectConfig(config);
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.write-${randomUUID()}`;
  await writeFile(staging, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  await rename(staging, path);
}

function defaultProjectKey(name: string): string {
  const normalized = name.toUpperCase().replace(/[^A-Z0-9]/gu, '');
  const key = /^[A-Z]/u.test(normalized) ? normalized : `P${normalized}`;
  return (key.length >= 2 ? key : `${key}P`).slice(0, 20);
}

async function resolveKnowledge(config: ProjectConfig) {
  const workspaceName = config.knowledge?.workspace_name ?? DEFAULT_WORKSPACE_NAME;
  const existing = (await listWorkspaces({ limit: 101 })).find(
    (workspace) => workspace.name === workspaceName
  );
  return existing ?? createWorkspace({ name: workspaceName });
}

async function resolveIssueProject(config: ProjectConfig, projectName: string) {
  const projects = await listIssueProjects({ limit: 101 });
  if (config.issues) {
    const stored = projects.find((project) => (
      project.project_key === config.issues!.project_key
      && project.name === config.issues!.project_name
    ));
    if (stored) return stored;
  }
  const byName = projects.find((project) => project.name === projectName);
  if (byName) return byName;
  const baseKey = config.issues?.project_key ?? defaultProjectKey(projectName);
  let key = baseKey;
  let suffix = 2;
  while (projects.some((project) => project.project_key === key)) {
    const marker = String(suffix);
    key = `${baseKey.slice(0, 20 - marker.length)}${marker}`;
    suffix += 1;
  }
  return createIssueProject({ name: projectName, project_key: key });
}

export function bundledSkills(modules: HorizonModule[]): string[] {
  return [
    ...(modules.includes('knowledge') ? ['knowledge'] : []),
    ...(modules.includes('issues') ? ['issues'] : []),
  ];
}

async function defaultAsk(question: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

async function choices(options: ProjectSetupOptions, existing: ProjectConfig | null) {
  const interactive = options.interactive ?? (stdin.isTTY === true && stdout.isTTY === true);
  const ask = options.ask ?? defaultAsk;
  let modules = options.modules;
  if (!modules) {
    if (interactive) {
      const fallback = existing?.modules.length === 1 ? existing.modules[0] : 'both';
      const answer = await ask(`Install Knowledge, Issues, or Both? [${fallback}]: `);
      modules = parseModules(answer.trim() || fallback);
    } else {
      modules = existing?.modules ?? [...ALL_MODULES];
    }
  }
  let skills = options.skills;
  if (!skills) {
    if (interactive) {
      const answer = await ask('Install bundled skills for Codex, Claude, Both, or None? [none]: ');
      skills = parseSkills(answer.trim() || 'none');
    } else {
      skills = 'none';
    }
  }
  return { modules, skills };
}

export async function setupProject(options: ProjectSetupOptions = {}): Promise<ProjectSetupResult> {
  const directory = resolve(options.directory ?? process.cwd());
  const configPath = projectConfigPath(directory);
  const existing = await readProjectConfig(configPath);
  const selected = await choices(options, existing);
  const config: ProjectConfig = {
    ...existing,
    version: PROJECT_CONFIG_VERSION,
    modules: selected.modules,
  };
  if (selected.modules.includes('knowledge')) {
    const workspace = await resolveKnowledge(config);
    config.knowledge = { workspace_name: workspace.name };
  }
  if (selected.modules.includes('issues')) {
    const project = await resolveIssueProject(config, basename(directory));
    config.issues = {
      project_key: project.project_key,
      project_name: project.name,
    };
  }
  await writeProjectConfig(config, configPath);
  const installed = selected.skills === 'none'
    ? []
    : await installAgentPlugins(selected.skills, { skills: bundledSkills(selected.modules) });
  return { config, configPath, installed, skills: selected.skills };
}
