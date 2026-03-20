import { describe, expect, it } from 'vitest';
import { SYSTEM_ACCESS } from '../db/access.js';
import {
  accessFromSession,
  errorEnvelope,
  sanitizeResponseValue,
  successEnvelope,
} from './common.js';

describe('tool common helpers', () => {
  it('strips hidden embedding fields recursively', () => {
    expect(sanitizeResponseValue({
      created_at: 'now',
      embedding: [1, 2, 3],
      id: 'x',
      nested: { embeddings: [4, 5], ok: true },
      title: 'hello',
    })).toEqual({
      created_at: 'now',
      id: 'x',
      nested: { ok: true },
      title: 'hello',
    });
  });

  it('formats success envelopes and preserves arrays', () => {
    const envelope = successEnvelope({
      action: 'list',
      result: [1, { id: 'x', embedding: [1], title: 'ok' }],
    });
    const payload = JSON.parse(envelope.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.result).toEqual([1, { id: 'x', title: 'ok' }]);
  });

  it('formats error envelopes', () => {
    const error = errorEnvelope('get', 'not found');
    const payload = JSON.parse(error.content[0].text);
    expect(error.isError).toBe(true);
    expect(payload.error.message).toBe('not found');
  });

  it('maps sessions through accessFromSession', () => {
    expect(accessFromSession()).toEqual(SYSTEM_ACCESS);
    expect(accessFromSession({})).toEqual(SYSTEM_ACCESS);
    expect(accessFromSession({ userId: 'user-1' })).toEqual(SYSTEM_ACCESS);
  });
});
