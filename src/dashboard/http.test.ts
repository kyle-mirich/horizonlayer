import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  request as createHttpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDashboardHttpServer,
  defaultDashboardAssetsDirectory,
  type DashboardHttpOptions,
} from './http.js';

interface HttpResponse {
  body: string;
  headers: IncomingHttpHeaders;
  status: number;
}

interface RequestOptions {
  body?: Buffer | string;
  chunked?: boolean;
  headers?: OutgoingHttpHeaders;
  method?: string;
  setHost?: boolean;
}

type ToolEnvelope = NonNullable<CallToolResult['structuredContent']>;
type ToolCall = DashboardHttpOptions['appServer']['callTool'];

function successEnvelope(action = 'list'): ToolEnvelope {
  return {
    ok: true,
    action,
    result: { items: [{ id: 'workspace-1', name: 'Research' }] },
    error: null,
    meta: { count: 1 },
  };
}

function failureEnvelope(code: string): ToolEnvelope {
  return {
    ok: false,
    action: 'get',
    result: null,
    error: {
      code,
      message: `A ${code.toLowerCase()} error occurred`,
      retryable: code === 'CONFLICT' || code === 'DEPENDENCY_UNAVAILABLE',
    },
    meta: {},
  };
}

function toolResult(envelope: ToolEnvelope): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: envelope.ok === false,
  };
}

describe('dashboard HTTP server', () => {
  let assetsDirectory: string;
  let baseDirectory: string;
  let callTool: ReturnType<typeof vi.fn<ToolCall>>;
  let port: number;
  let server: Server;

  async function request(pathname: string, options: RequestOptions = {}): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const request = createHttpRequest({
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: options.method ?? 'GET',
        headers: options.headers,
        setHost: options.setHost,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
      });
      request.on('error', reject);
      if (options.chunked && options.body !== undefined) {
        const body = typeof options.body === 'string' ? Buffer.from(options.body) : options.body;
        for (let offset = 0; offset < body.length; offset += 8 * 1024) {
          request.write(body.subarray(offset, offset + (8 * 1024)));
        }
        request.end();
      } else {
        request.end(options.body);
      }
    });
  }

  function postJson(pathname: string, value: unknown, headers: OutgoingHttpHeaders = {}) {
    const body = JSON.stringify(value);
    return request(pathname, {
      method: 'POST',
      headers: {
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json; charset=utf-8',
        ...headers,
      },
      body,
    });
  }

  beforeEach(async () => {
    baseDirectory = await mkdtemp(join(tmpdir(), 'horizonlayer-dashboard-http-'));
    assetsDirectory = join(baseDirectory, 'public');
    await mkdir(join(assetsDirectory, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(join(assetsDirectory, 'index.html'), '<!doctype html><main>HorizonLayer</main>'),
      writeFile(join(assetsDirectory, 'assets', 'app-a1b2c3.js'), 'globalThis.dashboardLoaded = true;'),
      writeFile(join(baseDirectory, 'outside.txt'), 'must never be served'),
    ]);

    callTool = vi.fn<ToolCall>(async () => toolResult(successEnvelope()));
    server = createDashboardHttpServer({
      appServer: { callTool },
      assetsDirectory,
      ragEnabled: true,
      version: '0.0.1-test',
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Dashboard test server did not bind to a TCP port'));
          return;
        }
        port = address.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(baseDirectory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports live local runtime capabilities with hardened JSON headers', async () => {
    const response = await request('/api/status');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      database: 'connected',
      mcp: { available: true, command: 'npx -y horizonlayer@latest mcp' },
      rag: { enabled: true },
      tools: ['workspace', 'page', 'database', 'row', 'search'],
      version: '0.0.1-test',
    });
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it('reports database health on every status request without exposing probe failures', async () => {
    const databaseHealth = vi.fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(false)
      .mockRejectedValueOnce(new Error('postgres password leaked here'))
      .mockReturnValueOnce(true);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server = createDashboardHttpServer({
      appServer: { callTool },
      assetsDirectory,
      databaseHealth,
      ragEnabled: true,
      version: '0.0.1-test',
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Dashboard health test server did not bind'));
          return;
        }
        port = address.port;
        resolve();
      });
    });

    expect(JSON.parse((await request('/api/status')).body).database).toBe('unavailable');
    expect(JSON.parse((await request('/api/status')).body).database).toBe('unavailable');
    expect(JSON.parse((await request('/api/status')).body).database).toBe('connected');
    expect(databaseHealth).toHaveBeenCalledTimes(3);
  });

  it('accepts loopback authorities and requires Origin to match the Host authority exactly', async () => {
    const authority = `127.0.0.1:${port}`;
    const valid = await request('/api/status', {
      headers: {
        host: authority,
        origin: `http://${authority}`,
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(valid.status).toBe(200);

    const localhostAuthority = `localhost:${port}`;
    const validLocalhost = await request('/api/status', {
      headers: { host: localhostAuthority, origin: `http://${localhostAuthority}` },
    });
    expect(validLocalhost.status).toBe(200);

    const ipv6Authority = `[::1]:${port}`;
    const validIpv6Authority = await request('/api/status', {
      headers: { host: ipv6Authority, origin: `http://${ipv6Authority}` },
    });
    expect(validIpv6Authority.status).toBe(200);

    for (const origin of [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port + 1}`,
      `https://${authority}`,
      'not a valid origin',
    ]) {
      const rejected = await request('/api/status', {
        headers: { host: authority, origin },
      });
      expect(rejected.status, origin).toBe(403);
      expect(JSON.parse(rejected.body)).toMatchObject({
        ok: false,
        action: 'dashboard',
        error: { code: 'INVALID_ARGUMENT', retryable: false },
      });
    }
  });

  it('rejects missing, non-loopback, and cross-site browser boundaries', async () => {
    // Node's HTTP/1.1 parser rejects the request before the application sees it.
    const missingHost = await request('/api/status', { setHost: false });
    expect(missingHost.status).toBe(400);

    for (const headers of [
      { host: 'knowledge.example:4317' },
      { host: '127.0.0.1.example:4317' },
      { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await request('/api/status', { headers });
      expect(response.status).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('passes a valid JSON command to the shared tool contract and returns only its envelope', async () => {
    const input = { action: 'list', limit: 25 };
    const envelope = successEnvelope('list');
    callTool.mockResolvedValueOnce(toolResult(envelope));

    const response = await postJson('/api/tools/workspace', input);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(envelope);
    expect(callTool).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith('workspace', input);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('maps every structured tool error code to its HTTP status without changing the envelope', async () => {
    for (const [code, expectedStatus] of [
      ['INVALID_ARGUMENT', 400],
      ['NOT_FOUND', 404],
      ['CONFLICT', 409],
      ['INVALID_REFERENCE', 422],
      ['DEPENDENCY_UNAVAILABLE', 503],
      ['INTERNAL', 500],
      ['UNRECOGNIZED', 500],
    ] as const) {
      const envelope = failureEnvelope(code);
      callTool.mockResolvedValueOnce(toolResult(envelope));

      const response = await postJson('/api/tools/page', { action: 'get', page_id: 'page-1' });

      expect(response.status, code).toBe(expectedStatus);
      expect(JSON.parse(response.body), code).toEqual(envelope);
    }
  });

  it('maps shared MCP validation failures and hides unexpected implementation errors', async () => {
    callTool.mockRejectedValueOnce(
      new McpError(ErrorCode.InvalidParams, 'Invalid arguments for row: values are required')
    );
    const invalid = await postJson('/api/tools/row', { action: 'create' });
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body)).toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining('Invalid arguments for row: values are required'),
        retryable: false,
      },
    });

    callTool.mockRejectedValueOnce(new McpError(ErrorCode.MethodNotFound, 'Unknown tool: search'));
    const missing = await postJson('/api/tools/search', { mode: 'records', query: 'hello' });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    callTool.mockRejectedValueOnce(new Error('postgres password leaked here'));
    const failed = await postJson('/api/tools/database', { action: 'list' });
    expect(failed.status).toBe(500);
    expect(failed.body).not.toContain('postgres password leaked here');
    expect(JSON.parse(failed.body)).toMatchObject({
      error: { code: 'INTERNAL', message: 'Dashboard request failed', retryable: false },
    });
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it('rejects unknown tools, invalid methods, and malformed API routes before execution', async () => {
    const unknownTool = await postJson('/api/tools/session', { action: 'list' });
    expect(unknownTool.status).toBe(404);
    expect(JSON.parse(unknownTool.body)).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Unknown dashboard tool: session' },
    });

    const wrongToolMethod = await request('/api/tools/page');
    const wrongStatusMethod = await request('/api/status', { method: 'POST' });
    const unknownApi = await request('/api/not-real');
    expect(wrongToolMethod.status).toBe(405);
    expect(wrongStatusMethod.status).toBe(405);
    expect(unknownApi.status).toBe(404);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('enforces JSON content type, syntax, and the declared four MiB body limit', async () => {
    const noContentType = await request('/api/tools/page', {
      method: 'POST',
      body: '{}',
    });
    expect(noContentType.status).toBe(415);
    expect(JSON.parse(noContentType.body)).toMatchObject({
      error: { code: 'INVALID_ARGUMENT', message: 'Dashboard tool calls require application/json' },
    });

    const malformed = await request('/api/tools/page', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"action":',
    });
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toMatchObject({
      error: { code: 'INVALID_ARGUMENT', message: 'Request body must contain valid JSON' },
    });

    const chunkedValid = await request('/api/tools/page', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      chunked: true,
    });
    expect(chunkedValid.status).toBe(200);
    callTool.mockClear();

    const tooLarge = await request('/api/tools/page', {
      method: 'POST',
      headers: {
        'content-length': (4 * 1024 * 1024) + 1,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(tooLarge.status).toBe(413);
    expect(JSON.parse(tooLarge.body)).toMatchObject({
      error: { code: 'INVALID_ARGUMENT', message: 'Request body cannot exceed 4194304 bytes' },
    });

    const streamedTooLarge = await request('/api/tools/page', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: Buffer.alloc((4 * 1024 * 1024) + 1, 0x20),
      chunked: true,
    });
    expect(streamedTooLarge.status).toBe(413);
    expect(JSON.parse(streamedTooLarge.body)).toMatchObject({
      error: { code: 'INVALID_ARGUMENT', message: 'Request body cannot exceed 4194304 bytes' },
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('rejects tool results without a structured envelope', async () => {
    callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not structured' }],
    });

    const response = await postJson('/api/tools/search', { mode: 'records', query: 'memory' });

    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toMatchObject({
      error: {
        code: 'INTERNAL',
        message: 'Tool did not return structured content',
        retryable: false,
      },
    });
  });

  it('serves the SPA with secure headers and falls back to index only for extensionless routes', async () => {
    const root = await request('/');
    expect(root.status).toBe(200);
    expect(root.body).toBe('<!doctype html><main>HorizonLayer</main>');
    expect(root.headers['cache-control']).toBe('no-cache');
    expect(root.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(root.headers['content-security-policy']).toContain("script-src 'self'");
    expect(root.headers['content-security-policy']).not.toContain('unsafe-inline');

    const nestedRoute = await request('/workspaces/workspace-1/pages/page-2');
    expect(nestedRoute.status).toBe(200);
    expect(nestedRoute.body).toBe(root.body);
    expect(nestedRoute.headers['cache-control']).toBe('no-cache');

    const missingFile = await request('/assets/not-built.js');
    expect(missingFile.status).toBe(404);
    expect(JSON.parse(missingFile.body)).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const missingExtensionlessAsset = await request('/assets/not-built');
    expect(missingExtensionlessAsset.status).toBe(404);
    expect(missingExtensionlessAsset.headers['cache-control']).toBe('no-store');

    const head = await request('/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');

    const wrongMethod = await request('/', { method: 'POST' });
    expect(wrongMethod.status).toBe(405);
  });

  it('serves immutable assets with ETags and honors conditional and HEAD requests', async () => {
    const first = await request('/assets/app-a1b2c3.js');
    expect(first.status).toBe(200);
    expect(first.body).toBe('globalThis.dashboardLoaded = true;');
    expect(first.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(first.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(first.headers.etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);

    const notModified = await request('/assets/app-a1b2c3.js', {
      headers: { 'if-none-match': first.headers.etag },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.body).toBe('');
    expect(notModified.headers.etag).toBe(first.headers.etag);

    const head = await request('/assets/app-a1b2c3.js', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('blocks encoded traversal and NUL paths from escaping the asset root', async () => {
    for (const pathname of [
      '/%2e%2e%2foutside.txt',
      '/assets/%2e%2e%2f%2e%2e%2foutside.txt',
      '/index%00.html',
    ]) {
      const response = await request(pathname);
      expect(response.status, pathname).toBe(404);
      expect(response.body, pathname).not.toContain('must never be served');
      expect(JSON.parse(response.body), pathname).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('resolves the packaged dashboard directory beside the compiled server output', () => {
    expect(defaultDashboardAssetsDirectory('file:///app/dist/dashboard/http.js'))
      .toBe('/app/dist/dashboard-ui/');
  });
});
