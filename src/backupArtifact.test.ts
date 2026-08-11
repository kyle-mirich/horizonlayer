import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUP_MAGIC,
  backupArtifactInternals,
  createBackupArtifact,
  createBackupPayloadStream,
  inspectBackupArtifact,
  MAX_BACKUP_MANIFEST_BYTES,
  type BackupManifestInput,
} from './backupArtifact.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'horizonlayer-backup-artifact-'));
  directories.push(directory);
  return directory;
}

function manifest(overrides: Partial<BackupManifestInput> = {}): BackupManifestInput {
  return {
    artifact: 'horizonlayer-backup',
    artifact_version: 1,
    completed_at: '2026-08-10T20:00:01.000Z',
    contents: {
      canonical_knowledge: 'postgresql',
      derived_search_index_included: false,
    },
    horizonlayer_schema_version: 1,
    horizonlayer_version: '2.0.0',
    postgresql: {
      pg_dump_version: 'pg_dump (PostgreSQL) 17.6',
      server_major: 17,
      server_version: '17.6',
    },
    scope: 'managed-runtime',
    source_database: 'horizon_layer',
    started_at: '2026-08-10T20:00:00.000Z',
    ...overrides,
  };
}

async function artifactFixture(payload = randomBytes(1024 * 1024 + 17)) {
  const directory = await temporaryDirectory();
  const payloadPath = join(directory, 'database.dump');
  const destination = join(directory, 'knowledge.hlbackup');
  await writeFile(payloadPath, payload, { mode: 0o600 });
  const inspection = await createBackupArtifact({
    destination,
    manifest: manifest(),
    payloadPath,
  });
  return { destination, directory, inspection, payload, payloadPath };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

describe('Backup artifact codec', () => {
  it('retries short positional reads and rejects only an actual early EOF', async () => {
    const source = Buffer.from('portable backup header');
    const positions: number[] = [];
    const shortReader = {
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        positions.push(position);
        const bytesRead = Math.min(3, length, source.length - position);
        if (bytesRead > 0) source.copy(buffer, offset, position, position + bytesRead);
        return { buffer, bytesRead };
      },
    } as unknown as Parameters<typeof backupArtifactInternals.readExactly>[0];

    await expect(backupArtifactInternals.readExactly(shortReader, source.length, 0))
      .resolves.toEqual(source);
    expect(positions).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);

    const truncatedReader = {
      read: async (buffer: Buffer) => ({ buffer, bytesRead: 0 }),
    } as unknown as Parameters<typeof backupArtifactInternals.readExactly>[0];
    await expect(backupArtifactInternals.readExactly(truncatedReader, 1, 0))
      .rejects.toThrow('truncated');
  });

  it('round-trips a multi-chunk binary payload with private atomic publication', async () => {
    const fixture = await artifactFixture();
    const inspected = await inspectBackupArtifact(fixture.destination);

    expect(inspected.manifest).toEqual(fixture.inspection.manifest);
    expect(inspected.manifest.payload.bytes).toBe(fixture.payload.length);
    expect(inspected.manifest.payload.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readFile(fixture.destination).then((value) => value.subarray(0, BACKUP_MAGIC.length)))
      .toEqual(BACKUP_MAGIC);

    const chunks: Buffer[] = [];
    const stream = createBackupPayloadStream(inspected);
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    await once(stream, 'end');
    expect(Buffer.concat(chunks)).toEqual(fixture.payload);
    if (process.platform !== 'win32') {
      expect((await stat(fixture.destination)).mode & 0o777).toBe(0o600);
    }
    expect((await readdir(fixture.directory)).filter((name) => name.includes('.partial-'))).toEqual([]);
  }, 15_000);

  it('preserves additive metadata within artifact version 1', async () => {
    const directory = await temporaryDirectory();
    const payloadPath = join(directory, 'database.dump');
    const destination = join(directory, 'additive.hlbackup');
    await writeFile(payloadPath, randomBytes(128));
    await createBackupArtifact({
      destination,
      manifest: {
        ...manifest(),
        future_metadata: { producer: 'test' },
      } as BackupManifestInput,
      payloadPath,
    });

    expect(await inspectBackupArtifact(destination)).toMatchObject({
      manifest: { future_metadata: { producer: 'test' } },
    });
  });

  it('refuses empty payloads, wrong suffixes, and existing destinations without partial files', async () => {
    const directory = await temporaryDirectory();
    const payloadPath = join(directory, 'empty.dump');
    await writeFile(payloadPath, '');
    await expect(createBackupArtifact({
      destination: join(directory, 'empty.hlbackup'),
      manifest: manifest(),
      payloadPath,
    })).rejects.toThrow('cannot be empty');

    await writeFile(payloadPath, 'payload');
    await expect(createBackupArtifact({
      destination: join(directory, 'wrong.dump'),
      manifest: manifest(),
      payloadPath,
    })).rejects.toThrow('must end with .hlbackup');

    const destination = join(directory, 'existing.hlbackup');
    await writeFile(destination, 'keep me');
    await expect(createBackupArtifact({ destination, manifest: manifest(), payloadPath }))
      .rejects.toThrow('already exists');
    expect(await readFile(destination, 'utf8')).toBe('keep me');
    expect((await readdir(directory)).filter((name) => name.includes('.partial-'))).toEqual([]);
  });

  it('requires a valid UTC snapshot interval', async () => {
    const directory = await temporaryDirectory();
    const payloadPath = join(directory, 'database.dump');
    await writeFile(payloadPath, 'payload');
    await expect(createBackupArtifact({
      destination: join(directory, 'offset.hlbackup'),
      manifest: manifest({ started_at: '2026-08-10T13:00:00.000-07:00' }),
      payloadPath,
    })).rejects.toThrow('UTC Z notation');
    await expect(createBackupArtifact({
      destination: join(directory, 'backwards.hlbackup'),
      manifest: manifest({ completed_at: '2026-08-10T19:59:59.000Z' }),
      payloadPath,
    })).rejects.toThrow('earlier than started_at');
  });

  it('refuses to replace a symlink destination', async () => {
    const directory = await temporaryDirectory();
    const payloadPath = join(directory, 'database.dump');
    const target = join(directory, 'target');
    const destination = join(directory, 'linked.hlbackup');
    await writeFile(payloadPath, 'payload');
    await writeFile(target, 'target');
    await symlink(target, destination);

    await expect(createBackupArtifact({ destination, manifest: manifest(), payloadPath }))
      .rejects.toThrow('already exists');
    expect(await readFile(target, 'utf8')).toBe('target');
  });

  it('rejects signatures, framing, JSON, compatibility, length, and checksum corruption', async () => {
    const fixture = await artifactFixture(randomBytes(4096));
    const original = await readFile(fixture.destination);
    const cases: Array<{ mutate: (value: Buffer) => Buffer; message: string; name: string }> = [
      {
        message: 'unknown file signature',
        mutate: (value) => Buffer.concat([Buffer.from('X'), value.subarray(1)]),
        name: 'magic',
      },
      {
        message: 'manifest length is invalid',
        mutate: (value) => {
          const next = Buffer.from(value);
          next.writeUInt32BE(MAX_BACKUP_MANIFEST_BYTES + 1, BACKUP_MAGIC.length);
          return next;
        },
        name: 'manifest-length',
      },
      {
        message: 'not valid UTF-8 JSON',
        mutate: (value) => {
          const next = Buffer.from(value);
          next[BACKUP_MAGIC.length + 4] = 0xff;
          return next;
        },
        name: 'json',
      },
      {
        message: 'checksum does not match',
        mutate: (value) => {
          const next = Buffer.from(value);
          next[next.length - 1] ^= 0xff;
          return next;
        },
        name: 'checksum',
      },
      {
        message: 'byte length does not match',
        mutate: (value) => Buffer.concat([value, Buffer.from('trailing')]),
        name: 'trailing',
      },
    ];

    for (const testCase of cases) {
      const path = join(fixture.directory, `${testCase.name}.hlbackup`);
      await writeFile(path, testCase.mutate(original));
      await expect(inspectBackupArtifact(path)).rejects.toThrow(testCase.message);
    }

    const manifestLength = original.readUInt32BE(BACKUP_MAGIC.length);
    const manifestStart = BACKUP_MAGIC.length + 4;
    const parsed = JSON.parse(original.subarray(manifestStart, manifestStart + manifestLength).toString('utf8'));
    parsed.artifact_version = 2;
    const incompatibleManifest = Buffer.from(JSON.stringify(parsed));
    const incompatibleLength = Buffer.alloc(4);
    incompatibleLength.writeUInt32BE(incompatibleManifest.length);
    const incompatible = Buffer.concat([
      BACKUP_MAGIC,
      incompatibleLength,
      incompatibleManifest,
      original.subarray(manifestStart + manifestLength),
    ]);
    const incompatiblePath = join(fixture.directory, 'incompatible.hlbackup');
    await writeFile(incompatiblePath, incompatible);
    await expect(inspectBackupArtifact(incompatiblePath)).rejects.toThrow('invalid or incompatible');

    const truncatedPath = join(fixture.directory, 'truncated.hlbackup');
    await writeFile(truncatedPath, original.subarray(0, 8));
    await expect(inspectBackupArtifact(truncatedPath)).rejects.toThrow('truncated');
  });

  it('cleans staging output when publication cannot access the destination directory', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const directory = await temporaryDirectory();
    const payloadPath = join(directory, 'database.dump');
    await writeFile(payloadPath, 'payload');
    await chmod(directory, 0o500);
    try {
      await expect(createBackupArtifact({
        destination: join(directory, 'denied.hlbackup'),
        manifest: manifest(),
        payloadPath,
      })).rejects.toThrow('Cannot create Backup artifact');
    } finally {
      await chmod(directory, 0o700);
    }
    expect((await readdir(directory)).filter((name) => name.includes('.partial-'))).toEqual([]);
  });

  it('does not require loading payload bytes through a writable aggregate stream', async () => {
    const directory = await temporaryDirectory();
    const payloadPath = join(directory, 'streamed.dump');
    const output = createWriteStream(payloadPath, { flags: 'wx', mode: 0o600 });
    for (let index = 0; index < 128; index += 1) {
      if (!output.write(randomBytes(64 * 1024))) await once(output, 'drain');
    }
    output.end();
    await once(output, 'close');

    const destination = join(directory, 'streamed.hlbackup');
    await createBackupArtifact({ destination, manifest: manifest(), payloadPath });
    expect((await inspectBackupArtifact(destination)).manifest.payload.bytes).toBe(8 * 1024 * 1024);
  });
});
