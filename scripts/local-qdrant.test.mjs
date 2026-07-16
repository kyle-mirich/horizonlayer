import { describe, expect, it } from 'vitest';
import {
  buildLocalQdrantConfig,
  buildLocalQdrantDockerRun,
} from './local-qdrant.mjs';

describe('local Qdrant lifecycle helper', () => {
  it('uses the same stable container, image, and volume as the launcher', () => {
    expect(buildLocalQdrantConfig({})).toEqual({
      containerName: 'horizonlayer-qdrant',
      host: '127.0.0.1',
      image: 'qdrant/qdrant:v1.18.2-unprivileged',
      port: 6333,
      volumeName: 'horizonlayer-qdrant-data',
    });
  });

  it('binds only to loopback and disables telemetry without putting values in argv', () => {
    const run = buildLocalQdrantDockerRun(buildLocalQdrantConfig({}));

    expect(run.args).toEqual([
      'run',
      '-d',
      '--name',
      'horizonlayer-qdrant',
      '-e',
      'QDRANT__TELEMETRY_DISABLED',
      '-p',
      '127.0.0.1:6333:6333',
      '-v',
      'horizonlayer-qdrant-data:/qdrant/storage',
      'qdrant/qdrant:v1.18.2-unprivileged',
    ]);
    expect(run.env).toEqual({ QDRANT__TELEMETRY_DISABLED: 'true' });
    expect(run.args.join(' ')).not.toContain('true');
  });

  it('honors the same container customization environment as the launcher', () => {
    expect(buildLocalQdrantConfig({
      HORIZONLAYER_QDRANT_DOCKER_CONTAINER_NAME: 'custom-qdrant',
      HORIZONLAYER_QDRANT_DOCKER_IMAGE: 'qdrant/qdrant:custom',
      HORIZONLAYER_QDRANT_DOCKER_VOLUME_NAME: 'custom-qdrant-data',
    })).toMatchObject({
      containerName: 'custom-qdrant',
      image: 'qdrant/qdrant:custom',
      volumeName: 'custom-qdrant-data',
    });
  });
});
