import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, isPreview, projectResult } from './utils.js';

describe('tool utilities', () => {
  it('projects arrays, explicit fields, minimal fields, nulls, and primitives', () => {
    expect(projectResult(null, 'full')).toBeNull();
    expect(projectResult('text', 'minimal')).toBe('text');
    expect(projectResult({ id: '1', name: 'Name', secret: true }, 'minimal')).toEqual({ id: '1', name: 'Name' });
    expect(projectResult({ secret: true }, 'minimal')).toEqual({ secret: true });
    expect(projectResult({ id: '1', name: 'Name', secret: true }, 'full', ['secret'])).toEqual({ secret: true });
    expect(projectResult([{ id: '1', secret: true }], 'minimal')).toEqual([{ id: '1' }]);
  });

  it('encodes and decodes pagination cursors defensively', () => {
    const cursor = encodeCursor(25);
    expect(typeof cursor).toBe('string');
    expect(decodeCursor(cursor ?? undefined)).toBe(25);
    expect(encodeCursor(null)).toBeNull();
    expect(decodeCursor()).toBe(0);
    expect(decodeCursor(Buffer.from(JSON.stringify({ offset: -1 })).toString('base64'))).toBe(0);
    expect(decodeCursor(Buffer.from(JSON.stringify({ offset: 1.5 })).toString('base64'))).toBe(0);
    expect(decodeCursor('not base64')).toBe(0);
  });

  it('treats dry-run and validate-only parameters as previews', () => {
    expect(isPreview({})).toBe(false);
    expect(isPreview({ dry_run: true })).toBe(true);
    expect(isPreview({ validate_only: true })).toBe(true);
  });
});
