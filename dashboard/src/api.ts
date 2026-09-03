import type {
  DashboardStatus,
  DashboardToolInput,
  DashboardToolName,
  DashboardToolSuccess,
  DatabaseInput,
  DatabaseSuccess,
  PageInput,
  PageSuccess,
  RowInput,
  RowSuccess,
  SearchInput,
  SearchSuccess,
  ToolErrorCode,
  WorkspaceInput,
  WorkspaceSuccess,
} from './types';

export type DashboardClientErrorCode =
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR';

export type DashboardApiErrorCode = ToolErrorCode | DashboardClientErrorCode;

export interface DashboardRequestOptions {
  signal?: AbortSignal;
}

export interface DashboardApiErrorOptions {
  action: string;
  cause?: unknown;
  code: DashboardApiErrorCode;
  endpoint: string;
  meta?: Record<string, unknown>;
  requestId?: string | null;
  retryable?: boolean;
  status?: number | null;
}

export class DashboardApiError extends Error {
  readonly action: string;
  readonly code: DashboardApiErrorCode;
  readonly endpoint: string;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(message: string, options: DashboardApiErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DashboardApiError';
    this.action = options.action;
    this.code = options.code;
    this.endpoint = options.endpoint;
    this.meta = options.meta ?? {};
    this.requestId = options.requestId ?? null;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}

export type DashboardFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface DashboardApiClientOptions {
  baseUrl?: string;
  fetch?: DashboardFetch;
}

interface UnknownFailureEnvelope {
  ok: false;
  action: string;
  result: null;
  error: {
    code: unknown;
    message: string;
    retryable: boolean;
  };
  meta: Record<string, unknown>;
}

interface JsonResponse {
  payload: unknown;
  response: Response;
}

const DASHBOARD_TOOLS: ReadonlySet<string> = new Set([
  'workspace',
  'page',
  'database',
  'row',
  'search',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFailureEnvelope(value: unknown): value is UnknownFailureEnvelope {
  if (!isRecord(value) || value.ok !== false || value.result !== null) return false;
  if (typeof value.action !== 'string' || !isRecord(value.error) || !isRecord(value.meta)) {
    return false;
  }
  return typeof value.error.message === 'string'
    && typeof value.error.retryable === 'boolean';
}

function isSuccessEnvelope(value: unknown): value is {
  ok: true;
  action: string;
  result: unknown;
  error: null;
  meta: Record<string, unknown>;
} {
  return isRecord(value)
    && value.ok === true
    && typeof value.action === 'string'
    && Object.prototype.hasOwnProperty.call(value, 'result')
    && value.error === null
    && isRecord(value.meta);
}

function isDashboardStatus(value: unknown): value is DashboardStatus {
  if (!isRecord(value) || !isRecord(value.mcp) || !isRecord(value.rag)) return false;
  return (value.database === 'connected' || value.database === 'unavailable')
    && value.mcp.available === true
    && typeof value.mcp.command === 'string'
    && value.mcp.command.length > 0
    && typeof value.rag.enabled === 'boolean'
    && Array.isArray(value.tools)
    && value.tools.every((tool) => typeof tool === 'string' && DASHBOARD_TOOLS.has(tool))
    && typeof value.version === 'string';
}

function isToolErrorCode(value: unknown): value is ToolErrorCode {
  return value === 'CONFLICT'
    || value === 'DEPENDENCY_UNAVAILABLE'
    || value === 'INTERNAL'
    || value === 'INVALID_ARGUMENT'
    || value === 'INVALID_REFERENCE'
    || value === 'NOT_FOUND';
}

function requestIdFrom(
  response: Response,
  payload?: { meta: Record<string, unknown> },
): string | null {
  const header = response.headers.get('x-request-id');
  if (header) return header;
  const fromMeta = payload?.meta.request_id;
  return typeof fromMeta === 'string' ? fromMeta : null;
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value ?? '').replace(/\/+$/u, '');
}

export class DashboardApiClient {
  readonly baseUrl: string;
  private readonly fetcher: DashboardFetch;

  constructor(options: DashboardApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async status(options: DashboardRequestOptions = {}): Promise<DashboardStatus> {
    const endpoint = `${this.baseUrl}/api/status`;
    const { payload, response } = await this.requestJson(
      endpoint,
      'status',
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      options.signal,
    );
    if (!isDashboardStatus(payload)) {
      throw new DashboardApiError('Dashboard returned an invalid status response', {
        action: 'status',
        code: 'INVALID_RESPONSE',
        endpoint,
        requestId: requestIdFrom(response),
        status: response.status,
      });
    }
    return payload;
  }

  async callTool<
    Tool extends DashboardToolName,
    Input extends DashboardToolInput<Tool>,
  >(
    tool: Tool,
    input: Input,
    options: DashboardRequestOptions = {},
  ): Promise<DashboardToolSuccess<Tool, Input>> {
    const endpoint = `${this.baseUrl}/api/tools/${tool}`;
    const action = 'action' in input ? input.action : 'search';
    const { payload, response } = await this.requestJson(
      endpoint,
      action,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      },
      options.signal,
    );
    if (!isSuccessEnvelope(payload) || payload.action !== action) {
      throw new DashboardApiError('Dashboard returned an invalid tool response', {
        action,
        code: 'INVALID_RESPONSE',
        endpoint,
        requestId: requestIdFrom(response),
        status: response.status,
      });
    }
    return payload as DashboardToolSuccess<Tool, Input>;
  }

  workspace<Input extends WorkspaceInput>(
    input: Input,
    options?: DashboardRequestOptions,
  ): Promise<WorkspaceSuccess<Input>> {
    return this.callTool('workspace', input, options);
  }

  page<Input extends PageInput>(
    input: Input,
    options?: DashboardRequestOptions,
  ): Promise<PageSuccess<Input>> {
    return this.callTool('page', input, options);
  }

  database<Input extends DatabaseInput>(
    input: Input,
    options?: DashboardRequestOptions,
  ): Promise<DatabaseSuccess<Input>> {
    return this.callTool('database', input, options);
  }

  row<Input extends RowInput>(
    input: Input,
    options?: DashboardRequestOptions,
  ): Promise<RowSuccess<Input>> {
    return this.callTool('row', input, options);
  }

  search<Input extends SearchInput>(
    input: Input,
    options?: DashboardRequestOptions,
  ): Promise<SearchSuccess<Input>> {
    return this.callTool('search', input, options);
  }

  private async requestJson(
    endpoint: string,
    action: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<JsonResponse> {
    let response: Response;
    try {
      response = await this.fetcher(endpoint, { ...init, signal });
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      throw new DashboardApiError('Could not reach the HorizonLayer dashboard', {
        action,
        cause: error,
        code: 'NETWORK_ERROR',
        endpoint,
        retryable: true,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      throw new DashboardApiError('Dashboard returned an invalid JSON response', {
        action,
        cause: error,
        code: response.ok ? 'INVALID_RESPONSE' : 'HTTP_ERROR',
        endpoint,
        requestId: requestIdFrom(response),
        retryable: response.status >= 500,
        status: response.status,
      });
    }

    if (isFailureEnvelope(payload)) {
      throw new DashboardApiError(payload.error.message, {
        action: payload.action,
        code: isToolErrorCode(payload.error.code) ? payload.error.code : 'HTTP_ERROR',
        endpoint,
        meta: payload.meta,
        requestId: requestIdFrom(response, payload),
        retryable: payload.error.retryable,
        status: response.status,
      });
    }

    if (!response.ok) {
      throw new DashboardApiError(`Dashboard request failed with HTTP ${response.status}`, {
        action,
        code: 'HTTP_ERROR',
        endpoint,
        requestId: requestIdFrom(response),
        retryable: response.status >= 500,
        status: response.status,
      });
    }

    return { payload, response };
  }
}

export function createDashboardApiClient(
  options?: DashboardApiClientOptions,
): DashboardApiClient {
  return new DashboardApiClient(options);
}

export const dashboardApi = createDashboardApiClient();
