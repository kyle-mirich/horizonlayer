import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sourceEvidence(root = process.cwd()): Record<string, unknown> {
  const git = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0').filter((file) => file && !file.startsWith('benchmarks/results/') && !file.endsWith('.hlbackup'))
    .sort();
  const manifest = files.map((file) => `${file}\0${existsSync(resolve(root, file))
    ? sha256(readFileSync(resolve(root, file))) : 'deleted'}`).join('\n');
  return {
    head_sha: git(['rev-parse', 'HEAD']),
    working_tree_dirty: git(['status', '--porcelain', '--', '.', ':!benchmarks/results']).length > 0,
    source_tree_sha256: sha256(manifest),
    lockfile_sha256: sha256(readFileSync(resolve(root, 'package-lock.json'))),
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    available_parallelism: availableParallelism(),
    host_memory_bytes: totalmem(),
    execution: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
    github_run_url: process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  };
}

export async function writeEvidence(path: string, report: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
