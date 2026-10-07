import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceEvidence, writeEvidence } from './evidence.js';

describe('benchmark source evidence', () => {
  it('identifies code changes, additions and tracked deletions without making results dirty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hl-evidence-'));
    const git = (args: string[]): void => { execFileSync('git', args, { cwd: root, stdio: 'ignore' }); };
    try {
      git(['init']);
      await writeFile(join(root, 'package-lock.json'), '{}\n');
      await writeFile(join(root, 'tracked.ts'), 'original');
      git(['add', '.']);
      git(['-c', 'user.name=Benchmark Test', '-c', 'user.email=benchmark@example.invalid', 'commit', '-m', 'fixture']);
      const initial = sourceEvidence(root);
      expect(initial.working_tree_dirty).toBe(false);
      await writeEvidence(join(root, 'benchmarks/results/report.json'), { result: 'synthetic' });
      expect(sourceEvidence(root).working_tree_dirty).toBe(false);
      expect(sourceEvidence(root).source_tree_sha256).toBe(initial.source_tree_sha256);
      await writeFile(join(root, 'untracked.ts'), 'addition');
      expect(sourceEvidence(root).source_tree_sha256).not.toBe(initial.source_tree_sha256);
      await unlink(join(root, 'tracked.ts'));
      expect(sourceEvidence(root).working_tree_dirty).toBe(true);
      expect(sourceEvidence(root).head_sha).toBe(initial.head_sha);
      expect(JSON.parse(await readFile(join(root, 'benchmarks/results/report.json'), 'utf8'))).toEqual({ result: 'synthetic' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
