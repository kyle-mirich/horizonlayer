import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readRepoFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('agent guidance', () => {
  it('keeps the root agent docs useful for fresh-context coding agents', () => {
    const sourceMap = readRepoFile('AGENT.md');
    const operatingNotes = readRepoFile('AGENTS.md');
    const combined = `${sourceMap}\n${operatingNotes}`.toLowerCase();

    expect(combined).toContain('fresh context');
    expect(combined).toContain('update');
    expect(combined).toContain('agent.md');
    expect(combined).toContain('agents.md');
    expect(combined).toContain('documentation');
    expect(combined).toContain('tests');
  });

  it('keeps source maps beside first-party subsystems', () => {
    const expectedGuides = [
      'apps/desktop/AGENT.md',
      'docs/AGENT.md',
      'examples/AGENT.md',
      'infra/AGENT.md',
      'migrations/AGENT.md',
      'src/AGENT.md',
      'src/db/AGENT.md',
      'src/db/queries/AGENT.md',
      'src/embeddings/AGENT.md',
      'src/testing/AGENT.md',
      'src/tools/AGENT.md',
    ];

    const missing = expectedGuides.filter((guide) => !existsSync(join(process.cwd(), guide)));

    expect(missing).toEqual([]);
  });
});
