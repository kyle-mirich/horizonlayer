import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const scripts = [...workflow.matchAll(/node --input-type=module <<'JS'\n([\s\S]*?)^\s+JS$/gmu)]
  .map((match) => match[1]);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runReleaseScript(index: number, options: {
  artifact?: Record<string, unknown>;
  registry?: { status: number; integrity?: string };
  tag?: string;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'horizonlayer-release-'));
  temporaryDirectories.push(directory);
  const output = join(directory, 'outputs');
  writeFileSync(output, '');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  writeFileSync(join(directory, 'release-package.json'), JSON.stringify([options.artifact ?? {
    filename: 'horizonlayer-0.2.0.tgz', version: '0.2.0', integrity: 'sha512-test-artifact',
  }]));
  const registry = options.registry;
  const mockFetch = registry ? `globalThis.fetch = async () => (${JSON.stringify({
    ok: registry.status >= 200 && registry.status < 300, status: registry.status,
  })});
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => ({ ...await fixtureFetch(...args),
    json: async () => (${JSON.stringify({ dist: { integrity: registry.integrity } })}),
  });` : '';
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    cwd: directory,
    env: { ...process.env, GITHUB_REF_NAME: options.tag ?? 'v0.2.0', GITHUB_OUTPUT: output },
    input: mockFetch + scripts[index],
    encoding: 'utf8',
  });
  return { ...result, output: readFileSync(output, 'utf8') };
}

describe('release workflow guards', () => {
  it('accepts a stable tag matching the package version', () => {
    expect(runReleaseScript(0).status).toBe(0);
  });

  it.each(['v0.1.0', 'v0.2.0-beta.1', '0.2.0'])('refuses a mismatched release tag %s', (tag) => {
    const result = runReleaseScript(0, { tag });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tag must match package.json exactly');
  });

  it('passes the packed tarball path to the publishing step', () => {
    const result = runReleaseScript(1);
    expect(result.status).toBe(0);
    expect(result.output).toBe('tarball=horizonlayer-0.2.0.tgz\n');
  });

  it('refuses an unexpected artifact filename', () => {
    const result = runReleaseScript(1, { artifact: { filename: '../other.tgz' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unexpected release artifact filename');
  });

  it('permits publishing only when the version is absent from npm', () => {
    const result = runReleaseScript(2, { registry: { status: 404 } });
    expect(result.status).toBe(0);
    expect(result.output).toBe('published=false\n');
  });

  it('reuses an identical published artifact when delivery is retried', () => {
    const result = runReleaseScript(2, { registry: { status: 200, integrity: 'sha512-test-artifact' } });
    expect(result.status).toBe(0);
    expect(result.output).toBe('published=true\n');
  });

  it('refuses to reuse the version when npm contains different package bytes', () => {
    const result = runReleaseScript(2, { registry: { status: 200, integrity: 'sha512-different-artifact' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already contains a different artifact');
  });

  it('stops on registry outages instead of treating them as an unpublished version', () => {
    const result = runReleaseScript(2, { registry: { status: 503 } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm registry lookup failed: HTTP 503');
    expect(result.output).toBe('');
  });
});
