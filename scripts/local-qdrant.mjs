#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const action = process.argv[2];

export function buildLocalQdrantConfig(environment = process.env) {
  return {
    containerName: environment.HORIZONLAYER_QDRANT_DOCKER_CONTAINER_NAME
      ?? 'horizonlayer-qdrant',
    host: '127.0.0.1',
    image: environment.HORIZONLAYER_QDRANT_DOCKER_IMAGE
      ?? 'qdrant/qdrant:v1.18.2-unprivileged',
    port: 6333,
    volumeName: environment.HORIZONLAYER_QDRANT_DOCKER_VOLUME_NAME
      ?? 'horizonlayer-qdrant-data',
  };
}

export function buildLocalQdrantDockerRun(config) {
  return {
    args: [
      'run',
      '-d',
      '--name',
      config.containerName,
      '-e',
      'QDRANT__TELEMETRY_DISABLED',
      '-p',
      `${config.host}:${config.port}:6333`,
      '-v',
      `${config.volumeName}:/qdrant/storage`,
      config.image,
    ],
    env: {
      QDRANT__TELEMETRY_DISABLED: 'true',
    },
  };
}

function recoveryHint() {
  return 'Start Docker Desktop and try again, or set QDRANT_URL to an existing Qdrant instance.';
}

function runDocker(args, extraEnv = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`Docker is required, but the \`docker\` command was not found.\n${recoveryHint()}`);
    }
    throw new Error(
      `Docker could not start while managing local Qdrant.\n${recoveryHint()}\n`
      + `Docker said: ${result.error.message}`
    );
  }

  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || `docker ${args.join(' ')} failed`).trim();
    const availabilityCheck = args.length === 1 && args[0] === 'version';
    throw new Error(
      `${availabilityCheck
        ? 'Docker is installed, but its daemon is unavailable right now.'
        : 'Docker failed while managing local Qdrant.'}\n`
      + `${recoveryHint()}\nDocker said: ${details}`
    );
  }

  return (result.stdout ?? '').trim();
}

function containerStatus(containerName) {
  const result = spawnSync(
    'docker',
    ['container', 'inspect', containerName, '--format', '{{.State.Status}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (result.status !== 0) return 'missing';
  return (result.stdout ?? '').trim() === 'running' ? 'running' : 'stopped';
}

async function isReady(config) {
  try {
    const response = await fetch(`http://${config.host}:${config.port}/readyz`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function start(config) {
  runDocker(['version']);
  const status = containerStatus(config.containerName);
  if (status === 'missing') {
    const dockerRun = buildLocalQdrantDockerRun(config);
    console.error(`Starting local Qdrant container '${config.containerName}'...`);
    try {
      runDocker(dockerRun.args, dockerRun.env);
    } catch (error) {
      if (!(error instanceof Error) || !/container name .* already in use/i.test(error.message)) {
        throw error;
      }
      const convergedStatus = containerStatus(config.containerName);
      if (convergedStatus === 'stopped') {
        runDocker(['start', config.containerName]);
      } else if (convergedStatus !== 'running') {
        throw error;
      }
    }
  } else if (status === 'stopped') {
    console.error(`Starting existing Qdrant container '${config.containerName}'...`);
    runDocker(['start', config.containerName]);
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isReady(config)) {
      console.error(`Local Qdrant is ready at http://${config.host}:${config.port}.`);
      return;
    }
    await sleep(1_000);
  }

  throw new Error(
    `Qdrant did not become ready at http://${config.host}:${config.port}/readyz within 30 seconds.\n`
    + `Inspect it with: docker logs ${config.containerName}`
  );
}

function stop(config) {
  runDocker(['version']);
  const status = containerStatus(config.containerName);
  if (status === 'running') {
    runDocker(['stop', config.containerName]);
    console.error(`Stopped local Qdrant container '${config.containerName}'.`);
  } else if (status === 'stopped') {
    console.error(`Local Qdrant container '${config.containerName}' is already stopped.`);
  } else {
    console.error(`Local Qdrant container '${config.containerName}' does not exist.`);
  }
}

export async function manageLocalQdrant(requestedAction, environment = process.env) {
  const config = buildLocalQdrantConfig(environment);
  if (requestedAction === 'up') {
    await start(config);
    return;
  }
  if (requestedAction === 'down') {
    stop(config);
    return;
  }
  throw new Error('Usage: node scripts/local-qdrant.mjs <up|down>');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  manageLocalQdrant(action).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
