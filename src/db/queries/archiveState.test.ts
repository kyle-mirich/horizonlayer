import { describe, expect, it } from 'vitest';

import { assertArchiveTransition } from './archiveState.js';

describe('archive transition state checks', () => {
  it('distinguishes a stale revision from an entity already in the requested state', () => {
    expect(() => assertArchiveTransition('page', 'page-1', 2, true, {
      archived_at: '2026-01-01T00:00:00.000Z',
      revision: 3,
    })).toThrow('Conflict: page page-1 is at revision 3, not 2');

    expect(() => assertArchiveTransition('page', 'page-1', 3, true, {
      archived_at: '2026-01-01T00:00:00.000Z',
      revision: 3,
    })).toThrow('page page-1 is already archived');

    expect(() => assertArchiveTransition('page', 'page-1', 3, false, {
      archived_at: null,
      revision: 3,
    })).toThrow('page page-1 is already restored');
  });

  it('leaves missing records for the caller to report as not found', () => {
    expect(() => assertArchiveTransition('page', 'missing', 1, true, undefined)).not.toThrow();
  });
});
