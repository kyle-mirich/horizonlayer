import { config } from '../config.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipeline: any = null;
let initPromise: Promise<void> | null = null;

async function initPipeline(): Promise<void> {
  if (pipeline) return;

  // Dynamic import to avoid top-level await issues
  const { pipeline: createPipeline, env } = await import('@xenova/transformers');

  // Allow local model caching
  env.allowLocalModels = true;

  pipeline = await createPipeline('feature-extraction', config.embedding.model, {
    quantized: true,
  });
}

export async function embed(text: string): Promise<number[]> {
  if (!initPromise) {
    initPromise = initPipeline();
  }
  await initPromise;

  const output = await pipeline(text, { pooling: 'mean', normalize: true });
  // output.data is a Float32Array
  return Array.from(output.data as Float32Array);
}

export function vectorToSql(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
