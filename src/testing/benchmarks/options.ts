export interface BenchmarkOptions {
  backend: 'lexical' | 'semantic' | 'both';
  output: string;
  repeats: number;
  sizes: number[];
}

export function parseBenchmarkOptions(args: string[]): BenchmarkOptions {
  const result: BenchmarkOptions = { backend: 'both', output: 'benchmarks/results/retrieval.json', repeats: 3, sizes: [1000, 10000] };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === '--backend') {
      if (!['lexical', 'semantic', 'both'].includes(value)) throw new Error('backend must be lexical, semantic, or both');
      result.backend = value as BenchmarkOptions['backend'];
    } else if (key === '--output') result.output = value;
    else if (key === '--repeats') result.repeats = Number(value);
    else if (key === '--sizes') result.sizes = value === 'none' ? [] : value.split(',').map(Number);
    else throw new Error(`Unknown option ${key}`);
  }
  if (!Number.isInteger(result.repeats) || result.repeats < 1 || result.repeats > 20) throw new Error('repeats must be 1..20');
  if (result.sizes.some((size) => !Number.isInteger(size) || size < 136 || size > 100000)) throw new Error('sizes must be integers 136..100000, or none');
  return result;
}
