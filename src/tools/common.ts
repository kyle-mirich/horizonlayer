export type ToolErrorCode =
  | 'CONFLICT'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL'
  | 'INVALID_ARGUMENT'
  | 'INVALID_REFERENCE'
  | 'NOT_FOUND';

interface DatabaseLikeError {
  code?: string;
  message?: string;
  retryable?: boolean;
}

const INVALID_DATABASE_CODES = new Set([
  '22001', // string_data_right_truncation
  '22003', // numeric_value_out_of_range
  '22007', // invalid_datetime_format
  '22P02', // invalid_text_representation
  '23502', // not_null_violation
  '23514', // check_violation
]);

const RETRYABLE_DATABASE_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '58030', // io_error
]);

const RETRYABLE_DATABASE_CODE_PREFIXES = [
  '08', // connection_exception class
  '53', // insufficient_resources class
] as const;

const RETRYABLE_RUNTIME_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);

function retryableDatabaseCode(code: string | undefined): boolean {
  if (!code) return false;
  return RETRYABLE_DATABASE_CODES.has(code)
    || RETRYABLE_RUNTIME_CODES.has(code)
    || RETRYABLE_DATABASE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

function errorMessage(error: unknown, databaseError: DatabaseLikeError): string {
  if (error instanceof Error) return error.message;
  if (typeof databaseError.message === 'string') return databaseError.message;
  try {
    return String(error);
  } catch {
    return 'Unrecognized thrown value';
  }
}

function classifyError(error: unknown): {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
} {
  const dbError: DatabaseLikeError = error != null && typeof error === 'object'
    ? error as DatabaseLikeError
    : {};
  const databaseCode = typeof dbError.code === 'string'
    ? dbError.code.toUpperCase()
    : undefined;
  const message = errorMessage(error, dbError);
  const normalized = message.toLowerCase();

  if (databaseCode === 'DEPENDENCY_UNAVAILABLE') {
    return {
      code: 'DEPENDENCY_UNAVAILABLE',
      message,
      retryable: dbError.retryable ?? true,
    };
  }
  if (databaseCode === '23505') {
    return { code: 'CONFLICT', message: 'A record with these values already exists', retryable: false };
  }
  if (databaseCode === '23503') {
    return { code: 'INVALID_REFERENCE', message, retryable: false };
  }
  if (databaseCode && INVALID_DATABASE_CODES.has(databaseCode)) {
    return { code: 'INVALID_ARGUMENT', message, retryable: false };
  }
  if (retryableDatabaseCode(databaseCode)) {
    return { code: 'CONFLICT', message, retryable: true };
  }
  if (normalized.startsWith('conflict:') || normalized.includes('is no longer')) {
    return { code: 'CONFLICT', message, retryable: true };
  }
  if (normalized.includes('not found') || normalized.includes('does not exist')) {
    return { code: 'NOT_FOUND', message, retryable: false };
  }
  if (
    normalized.includes('already exists')
    || normalized.includes(' is already ')
    || normalized.includes('can have only one')
    || normalized.includes('active property conflicts')
    || normalized.includes('closed and cannot be modified')
  ) {
    return { code: 'CONFLICT', message, retryable: false };
  }
  if (
    normalized.includes('required')
    || normalized.includes('must ')
    || normalized.includes('cannot ')
    || normalized.includes('belongs to workspace')
    || normalized.includes('not associated with')
    || normalized.includes('duplicate ')
    || normalized.includes('invalid')
    || normalized.includes('unknown ')
    || normalized.includes('unsupported')
    || normalized.includes('at least one')
  ) {
    return { code: 'INVALID_ARGUMENT', message, retryable: false };
  }
  return { code: 'INTERNAL', message, retryable: false };
}

export function successEnvelope(params: {
  action: string;
  result: unknown;
  meta?: Record<string, unknown>;
}) {
  const payload = {
    ok: true,
    action: params.action,
    result: params.result,
    error: null,
    meta: params.meta ?? {},
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export function errorEnvelope(
  action: string,
  message: string,
  code: ToolErrorCode = 'INVALID_ARGUMENT',
  retryable = false,
  meta?: Record<string, unknown>
) {
  const payload = {
    ok: false,
    action,
    result: null,
    error: { code, message, retryable },
    meta: meta ?? {},
  };
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(payload),
    }],
    structuredContent: payload,
    isError: true,
  };
}

export function errorEnvelopeFromUnknown(action: string, error: unknown) {
  const classified = classifyError(error);
  return errorEnvelope(
    action,
    classified.message,
    classified.code,
    classified.retryable
  );
}
