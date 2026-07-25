const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// A UUID is 16 bytes. Its unpadded base64url form is 22 characters, where the
// final character can only encode the two remaining bits (A, Q, g, or w).
// Keeping this pattern public lets the MCP JSON Schema advertise exactly the
// same compact-reference grammar that runtime parsing accepts.
export const COMPACT_REFERENCE_PATTERN = /^(w|s|p|b|d|r|f|l|u|c)_([A-Za-z0-9_-]{21}[AQgw])$/u;

export type ReferenceKind =
  | 'workspace'
  | 'session'
  | 'page'
  | 'block'
  | 'database'
  | 'row'
  | 'property'
  | 'link'
  | 'run'
  | 'checkpoint';

const PREFIXES: Record<ReferenceKind, string> = {
  workspace: 'w',
  session: 's',
  page: 'p',
  block: 'b',
  database: 'd',
  row: 'r',
  property: 'f',
  link: 'l',
  run: 'u',
  checkpoint: 'c',
};

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isEntityReference(value: string): boolean {
  if (UUID_PATTERN.test(value)) return true;
  const match = COMPACT_REFERENCE_PATTERN.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[2]!, 'base64url');
  return bytes.length === 16 && bytes.toString('base64url') === match[2];
}

export function expandReference(value: string): string {
  if (UUID_PATTERN.test(value)) return value.toLowerCase();
  const match = COMPACT_REFERENCE_PATTERN.exec(value);
  if (!match) throw new Error('Expected a HorizonLayer UUID or compact reference');

  const bytes = Buffer.from(match[2]!, 'base64url');
  if (!isEntityReference(value)) {
    throw new Error('Invalid HorizonLayer compact reference');
  }
  return bytesToUuid(bytes);
}

export function compactReference(kind: ReferenceKind, id: string): string {
  const uuid = expandReference(id);
  const bytes = Buffer.from(uuid.replaceAll('-', ''), 'hex');
  return `${PREFIXES[kind]}_${bytes.toString('base64url')}`;
}
