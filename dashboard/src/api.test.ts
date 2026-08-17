import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  createDashboardApiClient,
  DashboardApiClient,
  DashboardApiError,
  type DashboardFetch,
} from './api';
import type { Paginated, Workspace } from './types';

function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

describe('DashboardApiClient', () => {
  it('loads and validates dashboard status', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      database: 'connected',
      mcp: { available: true, command: 'horizonlayer' },
      rag: { enabled: true },
      tools: ['workspace', 'page', 'database', 'row', 'search'],
      version: '0.1.0',
    })) as DashboardFetch;
    const client = new DashboardApiClient({
      baseUrl: 'http://127.0.0.1:4317/',
      fetch: fetcher,
    });

    await expect(client.status()).resolves.toMatchObject({ version: '0.1.0' });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:4317/api/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('accepts an unavailable database health result', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      database: 'unavailable',
      mcp: { available: true, command: 'horizonlayer' },
      rag: { enabled: false },
      tools: ['workspace', 'page', 'database', 'row', 'search'],
      version: '0.1.0',
    })) as DashboardFetch;

    await expect(new DashboardApiClient({ fetch: fetcher }).status())
      .resolves.toMatchObject({ database: 'unavailable' });
  });

  it('keeps action-specific result types for tool calls', async () => {
    const result: Paginated<Workspace> = {
      items: [],
      page: { has_more: false, limit: 50, next_offset: null, offset: 0 },
    };
    const fetcher = vi.fn(async () => jsonResponse({
      ok: true,
      action: 'list',
      result,
      error: null,
      meta: {},
    })) as DashboardFetch;
    const client = new DashboardApiClient({ fetch: fetcher });

    const response = await client.workspace({ action: 'list' });

    expectTypeOf(response.result).toEqualTypeOf<Paginated<Workspace>>();
    expect(response.result.items).toEqual([]);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/tools/workspace',
      expect.objectContaining({
        body: JSON.stringify({ action: 'list' }),
        method: 'POST',
      }),
    );
  });

  it('turns a tool failure into a rich DashboardApiError', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      ok: false,
      action: 'update',
      result: null,
      error: {
        code: 'CONFLICT',
        message: 'Page revision changed',
        retryable: true,
      },
      meta: { request_id: 'request-from-body' },
    }, {
      status: 409,
      headers: { 'X-Request-Id': 'request-from-header' },
    })) as DashboardFetch;
    const client = new DashboardApiClient({ fetch: fetcher });

    let thrown: unknown;
    try {
      await client.page({
        action: 'update',
        page_id: '8b3a9f72-61d2-4fe6-b733-51357fc18ae2',
        revision: 1,
        title: 'New title',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DashboardApiError);
    expect(thrown).toMatchObject({
      action: 'update',
      code: 'CONFLICT',
      endpoint: '/api/tools/page',
      requestId: 'request-from-header',
      retryable: true,
      status: 409,
    });
  });

  it('reports malformed successful responses with request context', async () => {
    const fetcher = vi.fn(async () => jsonResponse(
      { unexpected: true },
      { headers: { 'X-Request-Id': 'request-7' } },
    )) as DashboardFetch;
    const client = new DashboardApiClient({ fetch: fetcher });

    await expect(client.row({
      action: 'get',
      row_id: '2465fbb3-38f2-4c80-a08b-f3c47a10cf11',
    })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      requestId: 'request-7',
      status: 200,
    });
  });

  it('preserves abort errors and wraps other network failures', async () => {
    const aborted = new DOMException('The operation was aborted', 'AbortError');
    const abortingFetch = vi.fn(async () => {
      throw aborted;
    }) as DashboardFetch;
    const controller = new AbortController();
    controller.abort();

    await expect(new DashboardApiClient({ fetch: abortingFetch }).status({
      signal: controller.signal,
    })).rejects.toBe(aborted);

    const failedFetch = vi.fn(async () => {
      throw new TypeError('connection refused');
    }) as DashboardFetch;
    await expect(new DashboardApiClient({ fetch: failedFetch }).status()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
      status: null,
    });
  });

  it('rejects invalid status payloads and supports search inputs without an action field', async () => {
    const invalidStatus = vi.fn(async () => jsonResponse({ database: 'connected' })) as DashboardFetch;
    await expect(new DashboardApiClient({ fetch: invalidStatus }).status()).rejects.toMatchObject({
      action: 'status', code: 'INVALID_RESPONSE', status: 200,
    });

    const fetcher = vi.fn(async () => jsonResponse({
      action: 'search', error: null, meta: {}, ok: true, result: { mode: 'records', records: [], truncated: false },
    })) as DashboardFetch;
    const client = createDashboardApiClient({ baseUrl: 'http://localhost:4317///', fetch: fetcher });
    await expect(client.search({ mode: 'records', query: 'notes', scope: { kind: 'workspace', workspace_id: 'workspace-1' } }))
      .resolves.toMatchObject({ action: 'search' });
    expect(fetcher).toHaveBeenCalledWith('http://localhost:4317/api/tools/search', expect.objectContaining({ method: 'POST' }));
  });

  it('normalizes malformed JSON, HTTP failures, and unknown tool failure codes', async () => {
    const jsonFailure = vi.fn(async () => new Response('not json', { status: 503 })) as DashboardFetch;
    await expect(new DashboardApiClient({ fetch: jsonFailure }).status()).rejects.toMatchObject({
      code: 'HTTP_ERROR', retryable: true, status: 503,
    });

    const httpFailure = vi.fn(async () => jsonResponse({ ok: true }, { status: 400, headers: { 'X-Request-Id': 'bad-request' } })) as DashboardFetch;
    await expect(new DashboardApiClient({ fetch: httpFailure }).status()).rejects.toMatchObject({
      code: 'HTTP_ERROR', requestId: 'bad-request', retryable: false, status: 400,
    });

    const unknownToolCode = vi.fn(async () => jsonResponse({
      action: 'archive', error: { code: 'SOMETHING_NEW', message: 'Nope', retryable: false },
      meta: { request_id: 'from-meta' }, ok: false, result: null,
    })) as DashboardFetch;
    await expect(new DashboardApiClient({ fetch: unknownToolCode }).workspace({ action: 'archive', revision: 1, workspace_id: 'workspace-1' }))
      .rejects.toMatchObject({ action: 'archive', code: 'HTTP_ERROR', requestId: 'from-meta' });
  });
});
