import { describe, expect, it } from 'vitest';
import { parseBenchmarkOptions } from './options.js';

describe('benchmark CLI options', () => {
  it('defaults to both real backends and the specified scaling sizes', () => {
    expect(parseBenchmarkOptions([])).toEqual({ backend: 'both', output: 'benchmarks/results/retrieval.json', repeats: 3, sizes: [1000, 10000] });
  });
  it('supports explicit bounded runs and skipping scaling without changing quality fixtures', () => {
    expect(parseBenchmarkOptions(['--backend', 'lexical', '--repeats', '1', '--sizes', 'none', '--output', 'result.json']))
      .toEqual({ backend: 'lexical', output: 'result.json', repeats: 1, sizes: [] });
  });
  it.each([
    ['--backend', 'mock'], ['--repeats', '0'], ['--repeats', '21'], ['--repeats', 'NaN'],
    ['--sizes', '1'], ['--sizes', '100001'], ['--sizes', '1000,NaN'], ['--output'], ['--unknown', 'x'],
  ])('rejects unsupported or unbounded input %j', (...args) => {
    expect(() => parseBenchmarkOptions(args)).toThrow();
  });
});
