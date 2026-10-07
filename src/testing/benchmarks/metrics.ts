export interface RankedQuery {
  relevance: Record<string, number>;
  ranking: string[];
}

/** Record-level metrics: repeated chunks from the same document count once. */
export function scoreRanking({ relevance, ranking }: RankedQuery, k = 5): {
  recall: number | null;
  ndcg: number | null;
  negativeReturned: boolean;
} {
  if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer');
  if (Object.values(relevance).some((grade) => !Number.isInteger(grade) || grade < 0 || grade > 3)) {
    throw new Error('relevance grades must be integers between 0 and 3');
  }
  const relevant = Object.entries(relevance).filter(([, grade]) => grade > 0);
  const top = [...new Set(ranking)].slice(0, k);
  if (!relevant.length) return { recall: null, ndcg: null, negativeReturned: top.length > 0 };
  const dcg = (grades: number[]): number => grades.reduce(
    (sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0
  );
  const ideal = relevant.map(([, grade]) => grade).sort((a, b) => b - a).slice(0, k);
  return {
    recall: top.filter((id) => (relevance[id] ?? 0) > 0).length / relevant.length,
    ndcg: dcg(top.map((id) => relevance[id] ?? 0)) / dcg(ideal),
    negativeReturned: false,
  };
}

/** Nearest-rank percentiles, with no interpolated measurements. */
export function latencySummary(samples: number[]): {
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
} {
  if (samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('latencies must be finite non-negative numbers');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number): number | null => sorted.length
    ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
  return { count: sorted.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95) };
}

export function mean(values: Array<number | null>): number | null {
  const measured = values.filter((value): value is number => value !== null);
  return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
}
