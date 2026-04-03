export type AccessContext = { kind: 'system' };

export const SYSTEM_ACCESS: AccessContext = { kind: 'system' };

export function isSystemAccess(_access: AccessContext): boolean {
  return true;
}
