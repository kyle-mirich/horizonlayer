import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, open, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

export const BACKUP_ARTIFACT_VERSION = 1;
export const HORIZONLAYER_SCHEMA_VERSION = 1;
export const BACKUP_EXTENSION = '.hlbackup';
export const BACKUP_MAGIC = Buffer.from('HORIZONLAYER-BK\n', 'ascii');
export const MAX_BACKUP_MANIFEST_BYTES = 64 * 1024;

const HEADER_BYTES = BACKUP_MAGIC.length + 4;

const ContentsSchema = z.object({
  canonical_knowledge: z.literal('postgresql'),
  derived_search_index_included: z.literal(false),
}).passthrough();

const PostgreSqlSchema = z.object({
  pg_dump_version: z.string().trim().min(1).max(256),
  server_major: z.literal(17),
  server_version: z.string().trim().min(1).max(256),
}).passthrough();

const PayloadSchema = z.object({
  bytes: z.number().int().positive().safe(),
  format: z.literal('postgresql-custom'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).passthrough();

export const BackupManifestSchema = z.object({
  artifact: z.literal('horizonlayer-backup'),
  artifact_version: z.literal(BACKUP_ARTIFACT_VERSION),
  completed_at: z.string().datetime({ offset: true })
    .refine((value) => value.endsWith('Z'), 'completed_at must use UTC Z notation'),
  contents: ContentsSchema,
  horizonlayer_schema_version: z.literal(HORIZONLAYER_SCHEMA_VERSION),
  horizonlayer_version: z.string().regex(/^0\.\d+\.\d+$/u),
  payload: PayloadSchema,
  postgresql: PostgreSqlSchema,
  scope: z.literal('managed-runtime'),
  source_database: z.string().trim().min(1).max(256),
  started_at: z.string().datetime({ offset: true })
    .refine((value) => value.endsWith('Z'), 'started_at must use UTC Z notation'),
}).passthrough().superRefine((manifest, context) => {
  if (Date.parse(manifest.completed_at) < Date.parse(manifest.started_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'completed_at cannot be earlier than started_at',
      path: ['completed_at'],
    });
  }
});

export type BackupManifest = z.infer<typeof BackupManifestSchema>;
export type BackupManifestInput = Omit<BackupManifest, 'payload'>;

export interface BackupArtifactInspection {
  manifest: BackupManifest;
  path: string;
  payloadOffset: number;
}

export class BackupArtifactError extends Error {
  constructor(message: string, readonly details?: string) {
    super(message);
    this.name = 'BackupArtifactError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (!Number.isSafeInteger(bytes)) {
      throw new BackupArtifactError('Backup payload is too large to represent safely.');
    }
    hash.update(buffer);
  }
  if (bytes === 0) throw new BackupArtifactError('Backup payload cannot be empty.');
  return { bytes, sha256: hash.digest('hex') };
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    // Windows and some filesystems do not allow directory fsync. The artifact
    // itself is already synced; directory syncing is a best-effort durability step.
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EACCES', 'EINVAL', 'EPERM', 'EISDIR'].includes(code ?? '')) throw error;
  } finally {
    await handle?.close();
  }
}

function artifactStagingPath(destination: string): string {
  return join(dirname(destination), `.${basename(destination)}.partial-${randomUUID()}`);
}

function assertBackupDestination(destination: string): void {
  if (!destination.endsWith(BACKUP_EXTENSION)) {
    throw new BackupArtifactError(`Backup destination must end with ${BACKUP_EXTENSION}.`);
  }
}

export async function createBackupArtifact(params: {
  destination: string;
  manifest: BackupManifestInput;
  payloadPath: string;
}): Promise<BackupArtifactInspection> {
  assertBackupDestination(params.destination);
  const payload = await hashFile(params.payloadPath);
  const manifest = BackupManifestSchema.parse({
    ...params.manifest,
    payload: {
      ...payload,
      format: 'postgresql-custom',
    },
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (manifestBytes.length > MAX_BACKUP_MANIFEST_BYTES) {
    throw new BackupArtifactError(
      `Backup manifest cannot exceed ${MAX_BACKUP_MANIFEST_BYTES} bytes.`
    );
  }

  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32BE(manifestBytes.length);
  const header = Buffer.concat([BACKUP_MAGIC, lengthBytes, manifestBytes]);
  const staging = artifactStagingPath(params.destination);
  let handle;
  let published = false;
  try {
    handle = await open(staging, 'wx', 0o600);
    await handle.write(header, 0, header.length, 0);
    await handle.close();
    handle = undefined;
    await pipeline(
      createReadStream(params.payloadPath),
      createWriteStream(staging, { flags: 'a', mode: 0o600 })
    );
    handle = await open(staging, 'r+');
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      // A hard link publishes the already complete inode and fails atomically
      // when any filesystem entry already occupies the destination.
      await link(staging, params.destination);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new BackupArtifactError(
          `Backup destination already exists: ${params.destination}. Choose a new path.`
        );
      }
      throw new BackupArtifactError(
        `Cannot atomically publish Backup at ${params.destination}.`,
        errorMessage(error)
      );
    }
    await syncDirectory(dirname(params.destination));
    await rm(staging, { force: true });
    return {
      manifest,
      path: params.destination,
      payloadOffset: header.length,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(staging, { force: true }).catch(() => undefined);
    if (published) {
      await rm(params.destination, { force: true }).catch(() => undefined);
      await syncDirectory(dirname(params.destination)).catch(() => undefined);
    }
    if (error instanceof BackupArtifactError) throw error;
    throw new BackupArtifactError(
      `Cannot create Backup artifact at ${params.destination}.`,
      errorMessage(error)
    );
  }
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      length - total,
      position + total
    );
    if (bytesRead === 0) throw new BackupArtifactError('Backup artifact is truncated.');
    total += bytesRead;
  }
  return buffer;
}

function parseManifest(bytes: Buffer): BackupManifest {
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    throw new BackupArtifactError('Backup manifest is not valid UTF-8 JSON.', errorMessage(error));
  }
  const result = BackupManifestSchema.safeParse(value);
  if (!result.success) {
    throw new BackupArtifactError('Backup manifest is invalid or incompatible.', result.error.message);
  }
  return result.data;
}

export async function inspectBackupArtifact(path: string): Promise<BackupArtifactInspection> {
  let handle;
  try {
    const file = await stat(path);
    if (!file.isFile()) throw new BackupArtifactError(`Backup artifact is not a regular file: ${path}.`);
    if (!Number.isSafeInteger(file.size) || file.size < HEADER_BYTES + 1) {
      throw new BackupArtifactError('Backup artifact is truncated or too large to represent safely.');
    }

    handle = await open(path, 'r');
    const header = await readExactly(handle, HEADER_BYTES, 0);
    if (!header.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
      throw new BackupArtifactError('Backup artifact has an unknown file signature.');
    }
    const manifestLength = header.readUInt32BE(BACKUP_MAGIC.length);
    if (manifestLength === 0 || manifestLength > MAX_BACKUP_MANIFEST_BYTES) {
      throw new BackupArtifactError('Backup artifact manifest length is invalid.');
    }
    const manifest = parseManifest(await readExactly(handle, manifestLength, HEADER_BYTES));
    const payloadOffset = HEADER_BYTES + manifestLength;
    if (payloadOffset + manifest.payload.bytes !== file.size) {
      throw new BackupArtifactError('Backup payload byte length does not match the artifact.');
    }
    await handle.close();
    handle = undefined;

    const actual = await hashFileRange(path, payloadOffset);
    if (actual.bytes !== manifest.payload.bytes || actual.sha256 !== manifest.payload.sha256) {
      throw new BackupArtifactError('Backup payload checksum does not match the manifest.');
    }
    return { manifest, path, payloadOffset };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof BackupArtifactError) throw error;
    throw new BackupArtifactError(`Cannot inspect Backup artifact at ${path}.`, errorMessage(error));
  }
}

async function hashFileRange(path: string, start: number): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, { start })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest('hex') };
}

export function createBackupPayloadStream(inspection: BackupArtifactInspection) {
  return createReadStream(inspection.path, { start: inspection.payloadOffset });
}

export const backupArtifactInternals = { readExactly };
