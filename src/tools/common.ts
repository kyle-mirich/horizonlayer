import { SYSTEM_ACCESS } from '../db/access.js';
import type { AppSessionData } from '../mcp.js';
import { getAccessContext } from '../auth/context.js';

const HIDDEN_RESPONSE_KEYS = new Set([
  'embedding',
  'embeddings',
]);

export function sanitizeResponseValue(value: unknown): unknown {
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeResponseValue(item));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(obj)) {
      if (HIDDEN_RESPONSE_KEYS.has(key)) {
        continue;
      }
      sanitized[key] = sanitizeResponseValue(nestedValue);
    }
    return sanitized;
  }

  return value;
}

export function successEnvelope(params: {
  action: string;
  result: unknown;
  meta?: Record<string, unknown>;
}) {
  const payload = {
    ok: true,
    action: params.action,
    result: sanitizeResponseValue(params.result),
    error: null,
    meta: params.meta ?? {},
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function errorEnvelope(action: string, message: string, meta?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, action, result: null, error: { message }, meta: meta ?? {} }, null, 2) }],
    isError: true,
  };
}

export function accessFromSession(_session?: AppSessionData) {
  return getAccessContext(_session);
}
