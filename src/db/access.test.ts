import { describe, expect, it } from 'vitest';
import { isSystemAccess, SYSTEM_ACCESS } from './access.js';

describe('db access helpers', () => {
  it('always uses system access in the local runtime', () => {
    expect(SYSTEM_ACCESS).toEqual({ kind: 'system' });
    expect(isSystemAccess(SYSTEM_ACCESS)).toBe(true);
  });
});
