import { describe, expect, it } from 'vitest';
import {
  errorEnvelope,
  errorEnvelopeFromUnknown,
  successEnvelope,
} from './common.js';

describe('tool common helpers', () => {
  it('formats success envelopes without deleting user-authored keys', () => {
    const envelope = successEnvelope({
      action: 'list',
      result: [1, { id: 'x', values: { note: 'user-authored' } }],
    });
    const payload = JSON.parse(envelope.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.result).toEqual([1, { id: 'x', values: { note: 'user-authored' } }]);
    expect(envelope.structuredContent).toEqual(payload);
  });

  it('formats error envelopes', () => {
    const error = errorEnvelope('get', 'not found');
    const payload = JSON.parse(error.content[0].text);
    expect(error.isError).toBe(true);
    expect(payload.error.message).toBe('not found');
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
    expect(payload.error.retryable).toBe(false);
    expect(error.structuredContent).toEqual(payload);
  });

  it('classifies not-found and stale-revision errors with stable codes', () => {
    const missing = errorEnvelopeFromUnknown('get', new Error('Page p-1 not found'));
    const conflict = errorEnvelopeFromUnknown('update', new Error('Conflict: page p-1 is at revision 2, not 1'));
    expect(JSON.parse(missing.content[0].text).error).toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect(JSON.parse(conflict.content[0].text).error).toMatchObject({ code: 'CONFLICT', retryable: true });
  });

  it.each([
    [{ code: '23502', message: 'null value violates not-null constraint' }, 'INVALID_ARGUMENT', false],
    [{ code: '22007', message: 'invalid datetime format' }, 'INVALID_ARGUMENT', false],
    [{ code: '23503', message: 'foreign key violation' }, 'INVALID_REFERENCE', false],
    [{ code: '23505', message: 'unique violation' }, 'CONFLICT', false],
    [{ code: '40001', message: 'serialization failure' }, 'CONFLICT', true],
    [{ code: '40P01', message: 'deadlock detected' }, 'CONFLICT', true],
    [{ code: '08006', message: 'connection failure' }, 'CONFLICT', true],
    [{ code: '08001', message: 'unable to establish connection' }, 'CONFLICT', true],
    [{ code: '53100', message: 'disk full' }, 'CONFLICT', true],
    [{ code: '53300', message: 'too many connections' }, 'CONFLICT', true],
    [{ code: '57P01', message: 'administrator shutdown' }, 'CONFLICT', true],
    [{ code: '57P02', message: 'crash shutdown' }, 'CONFLICT', true],
    [{ code: '57P03', message: 'cannot connect now' }, 'CONFLICT', true],
    [{ code: '58030', message: 'I/O error' }, 'CONFLICT', true],
    [{ code: 'ECONNRESET', message: 'socket closed' }, 'CONFLICT', true],
    [{ code: 'etimedout', message: 'connection timed out' }, 'CONFLICT', true],
    [{ code: '42601', message: 'syntax error' }, 'INTERNAL', false],
    [{ code: '58P01', message: 'undefined file' }, 'INTERNAL', false],
  ])('classifies database error %s as %s', (databaseError, code, retryable) => {
    const envelope = errorEnvelopeFromUnknown('update', databaseError);
    expect(envelope.structuredContent.error).toMatchObject({ code, retryable });
  });

  it.each([
    ['Property Status already exists in database db-1', 'CONFLICT', false],
    ['A database can have only one title property', 'CONFLICT', false],
    ['Session s-1 is closed and cannot be modified', 'CONFLICT', false],
    ['Session belongs to workspace ws-1, not ws-2', 'INVALID_ARGUMENT', false],
    ['Page p-1 is not associated with session s-1', 'INVALID_ARGUMENT', false],
  ])('classifies domain error %s as %s', (message, code, retryable) => {
    const envelope = errorEnvelopeFromUnknown('update', new Error(message));
    expect(envelope.structuredContent.error).toMatchObject({ code, retryable });
  });

  it('handles non-Error failures without throwing during classification', () => {
    const envelope = errorEnvelopeFromUnknown('update', null);
    expect(envelope.structuredContent.error).toMatchObject({
      code: 'INTERNAL',
      message: 'null',
      retryable: false,
    });
  });

  it('is null-safe for malformed thrown values and preserves plain-object messages', () => {
    const withoutPrimitive = Object.create(null) as Record<string, unknown>;
    const malformed = errorEnvelopeFromUnknown('update', withoutPrimitive);
    const plainObject = errorEnvelopeFromUnknown('update', {
      code: '08006',
      message: 'database connection dropped',
    });

    expect(malformed.structuredContent.error).toMatchObject({
      code: 'INTERNAL',
      message: 'Unrecognized thrown value',
      retryable: false,
    });
    expect(plainObject.structuredContent.error).toMatchObject({
      code: 'CONFLICT',
      message: 'database connection dropped',
      retryable: true,
    });
  });
});
