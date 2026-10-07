import { describe, expect, it } from 'vitest';
import { latencySummary, mean, scoreRanking } from './metrics.js';

describe('record-level retrieval metrics', () => {
  it('uses graded gains and an independently worked ideal ranking', () => {
    const score = scoreRanking({ relevance: { a: 3, b: 1 }, ranking: ['b', 'x', 'a'] });
    expect(score.recall).toBe(1);
    // DCG = 1 + 7/2 = 4.5; ideal DCG = 7 + 1/log2(3).
    expect(score.ndcg).toBeCloseTo(4.5 / 7.630929753571458);
  });
  it('deduplicates chunks before truncating to five records', () => {
    expect(scoreRanking({ relevance: { a: 3, b: 2 }, ranking: ['a', 'a', 'a', 'a', 'a', 'b'] }))
      .toEqual({ recall: 1, ndcg: 1, negativeReturned: false });
  });
  it('does not silently score no-answer queries as perfect recall', () => {
    expect(scoreRanking({ relevance: {}, ranking: ['x'] }))
      .toEqual({ recall: null, ndcg: null, negativeReturned: true });
    expect(scoreRanking({ relevance: {}, ranking: [] }).negativeReturned).toBe(false);
    expect(mean([null, 0, 1])).toBe(0.5);
    expect(mean([])).toBeNull();
  });
  it('reports missing relevant documents and ignores grade-zero labels', () => {
    expect(scoreRanking({ relevance: { a: 3, b: 2, x: 0 }, ranking: ['a', 'x'] }).recall).toBe(0.5);
    expect(() => scoreRanking({ relevance: { a: -1 }, ranking: [] })).toThrow('relevance');
    expect(() => scoreRanking({ relevance: {}, ranking: [] }, 0)).toThrow('k');
  });
  it('reports observed nearest-rank percentiles, including small samples', () => {
    expect(latencySummary([20, 10, 40, 30])).toEqual({ count: 4, p50_ms: 20, p95_ms: 40 });
    expect(latencySummary([])).toEqual({ count: 0, p50_ms: null, p95_ms: null });
    expect(() => latencySummary([NaN])).toThrow('latencies');
  });
});
