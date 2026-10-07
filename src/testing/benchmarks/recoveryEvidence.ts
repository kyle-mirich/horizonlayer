import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { sourceEvidence, writeEvidence } from './evidence.js';

async function main(): Promise<void> {
  const output = resolve(process.env.HORIZONLAYER_RECOVERY_REPORT ?? 'benchmarks/results/recovery.json');
  const report: Record<string, unknown> = {
    format_version: 1, started_at: new Date().toISOString(), source: sourceEvidence(),
    implementation: 'packed public CLI; real Docker-managed PostgreSQL/Qdrant/local embeddings', status: 'running',
  };
  await writeEvidence(output, report);
  const start = performance.now();
  let code: number | null = null;
  let signal: string | null = null;
  try {
    const child = spawn('bash', ['scripts/smoke-recovery.sh'], {
      env: { ...process.env, HORIZONLAYER_RECOVERY_REPORT: output }, stdio: 'inherit',
    });
    [code, signal] = await new Promise<[number | null, string | null]>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    const detailed = JSON.parse(await readFile(output, 'utf8')) as Record<string, unknown>;
    const wrapperStartedAt = report.started_at;
    Object.assign(report, detailed);
    report.smoke_started_at = detailed.started_at;
    report.started_at = wrapperStartedAt;
    report.status = code === 0 ? 'passed' : detailed.status === 'blocked' ? 'blocked' : 'failed';
  } catch {
    report.status = 'failed';
    report.error = 'Could not launch the recovery smoke or read its evidence report';
  }
  Object.assign(report, { exit_code: code, signal, total_elapsed_ms: performance.now() - start,
    finished_at: new Date().toISOString() });
  await writeEvidence(output, report);
  process.exitCode = report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
