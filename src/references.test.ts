import { describe, expect, it } from 'vitest';
import {
  compactReference,
  expandReference,
  isEntityReference,
} from './references.js';

describe('compact entity references', () => {
  const id = 'c2b12324-eb92-4d55-a884-2b61d0b4fd30';

  it('round-trips a UUID through a typed, lossless reference', () => {
    const reference = compactReference('page', id);

    expect(reference).toBe('p_wrEjJOuSTVWohCth0LT9MA');
    expect(reference).toHaveLength(24);
    expect(expandReference(reference)).toBe(id);
  });

  it('accepts canonical UUIDs without changing their meaning', () => {
    expect(isEntityReference(id)).toBe(true);
    expect(expandReference(id.toUpperCase())).toBe(id);
  });

  it('rejects malformed and unknown references', () => {
    expect(isEntityReference('page_wrEjJOuSTVWohCth0LT9MA')).toBe(false);
    expect(isEntityReference('p_wrEjJOuSTVWohCth0LT9MB')).toBe(false);
    expect(() => expandReference('x_wrEjJOuSTVWohCth0LT9MA')).toThrow(
      'Expected a HorizonLayer UUID or compact reference'
    );
  });
});
