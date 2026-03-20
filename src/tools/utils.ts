const MINIMAL_KEYS = new Set([
  'id',
  'type',
  'name',
  'title',
  'success',
  'count',
  'created_at',
  'updated_at',
  'workspace_id',
  'parent_page_id',
  'database_id',
  'importance',
]);

export type ReturnMode = 'minimal' | 'full';

function pickFields(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, field)) {
      out[field] = obj[field];
    }
  }
  return out;
}

function minimalObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (MINIMAL_KEYS.has(key)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : obj;
}

export function projectResult(value: unknown, mode: ReturnMode, fields?: string[]): unknown {
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.map((item) => projectResult(item, mode, fields));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (fields && fields.length > 0) {
      return pickFields(obj, fields);
    }
    if (mode === 'minimal') {
      return minimalObject(obj);
    }
    return obj;
  }

  return value;
}

export function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(raw) as { offset?: number };
    return Number.isInteger(parsed.offset) && (parsed.offset ?? 0) >= 0 ? (parsed.offset as number) : 0;
  } catch {
    return 0;
  }
}

export function encodeCursor(offset: number | null): string | null {
  if (offset == null) return null;
  return Buffer.from(JSON.stringify({ offset })).toString('base64');
}

export function isPreview(params: { dry_run?: boolean; validate_only?: boolean }): boolean {
  return Boolean(params.dry_run || params.validate_only);
}
