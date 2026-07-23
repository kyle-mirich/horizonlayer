import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { fileURLToPath } from 'node:url';
import { extname, relative, resolve, sep } from 'node:path';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { AppServer } from '../mcp.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const DASHBOARD_TOOLS = new Set(['workspace', 'page', 'database', 'row', 'search']);

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join('; '),
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

interface ToolEnvelope {
  action?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
  } | null;
  meta?: unknown;
  ok?: unknown;
  result?: unknown;
}

export interface DashboardStatus {
  database: 'connected' | 'unavailable';
  mcp: {
    available: true;
    command: 'horizonlayer';
  };
  rag: {
    enabled: boolean;
  };
  tools: string[];
  version: string;
}

export interface DashboardHttpOptions {
  appServer: Pick<AppServer, 'callTool'>;
  assetsDirectory?: string;
  databaseHealth?: () => boolean | Promise<boolean>;
  ragEnabled: boolean;
  version: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'INVALID_ARGUMENT'
  ) {
    super(message);
  }
}

export function defaultDashboardAssetsDirectory(metaUrl = import.meta.url): string {
  return fileURLToPath(new URL('../dashboard-ui/', metaUrl));
}

function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  requestId: string
): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Request-Id', requestId);
  if (status === 413) response.setHeader('Connection', 'close');
  response.end(JSON.stringify(value));
}

function errorEnvelope(code: string, message: string, requestId: string) {
  return {
    ok: false,
    action: 'dashboard',
    result: null,
    error: {
      code,
      message,
      retryable: code === 'CONFLICT' || code === 'DEPENDENCY_UNAVAILABLE',
    },
    meta: { request_id: requestId },
  };
}

function normalizedAuthority(authority: string): string | null {
  try {
    const url = new URL(`http://${authority}`);
    return LOOPBACK_HOSTS.has(url.hostname) ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function validateBrowserBoundary(request: IncomingMessage): void {
  const host = request.headers.host;
  const authority = host ? normalizedAuthority(host) : null;
  if (!authority) {
    throw new HttpError(403, 'Dashboard requests must use a loopback host');
  }

  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    throw new HttpError(403, 'Cross-site dashboard requests are not allowed');
  }

  const origin = request.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.protocol !== 'http:' || originUrl.host.toLowerCase() !== authority) {
        throw new Error('not loopback');
      }
    } catch {
      throw new HttpError(403, 'Dashboard requests must originate from loopback');
    }
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'Dashboard tool calls require application/json');
  }

  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    request.resume();
    throw new HttpError(413, `Request body cannot exceed ${MAX_BODY_BYTES} bytes`);
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      // Keep draining a chunked request without retaining it. Throwing from an
      // IncomingMessage async iterator destroys the socket before Node can send
      // the structured 413 response.
      oversized = true;
      chunks.length = 0;
      continue;
    }
    if (!oversized) chunks.push(buffer);
  }
  if (oversized) throw new HttpError(413, `Request body cannot exceed ${MAX_BODY_BYTES} bytes`);

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must contain valid JSON');
  }
}

function structuredContent(result: CallToolResult): ToolEnvelope {
  const value = result.structuredContent;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(500, 'Tool did not return structured content', 'INTERNAL');
  }
  return value as ToolEnvelope;
}

function envelopeStatus(envelope: ToolEnvelope): number {
  if (envelope.ok !== false) return 200;
  switch (envelope.error?.code) {
    case 'INVALID_ARGUMENT': return 400;
    case 'NOT_FOUND': return 404;
    case 'CONFLICT': return 409;
    case 'INVALID_REFERENCE': return 422;
    case 'DEPENDENCY_UNAVAILABLE': return 503;
    default: return 500;
  }
}

function staticPath(assetsDirectory: string, pathname: string): string | null {
  let requested: string;
  try {
    requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
  } catch {
    throw new HttpError(400, 'Request path is not valid URL encoding');
  }
  const candidate = resolve(assetsDirectory, requested);
  const pathWithinRoot = relative(assetsDirectory, candidate);
  if (pathWithinRoot.startsWith('..') || pathWithinRoot.includes('\0')) return null;
  return candidate;
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  assetsDirectory: string,
  pathname: string,
  requestId: string
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(405, 'Method not allowed');
  }

  let filePath = staticPath(assetsDirectory, pathname);
  if (!filePath) throw new HttpError(404, 'Not found', 'NOT_FOUND');

  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    if (pathname.startsWith('/assets/') || extname(pathname)) {
      throw new HttpError(404, 'Not found', 'NOT_FOUND');
    }
    filePath = resolve(assetsDirectory, 'index.html');
    fileStats = await stat(filePath);
  }
  if (!fileStats.isFile()) throw new HttpError(404, 'Not found', 'NOT_FOUND');

  const etag = `"${fileStats.size.toString(16)}-${Math.trunc(fileStats.mtimeMs).toString(16)}"`;
  const assetsRoot = `${resolve(assetsDirectory, 'assets')}${sep}`;
  const immutableAsset = filePath.startsWith(assetsRoot);
  applySecurityHeaders(response);
  response.setHeader('Content-Type', CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream');
  response.setHeader('ETag', etag);
  response.setHeader('X-Request-Id', requestId);
  response.setHeader(
    'Cache-Control',
    immutableAsset ? 'public, max-age=31536000, immutable' : 'no-cache'
  );
  if (request.headers['if-none-match'] === etag) {
    response.statusCode = 304;
    response.end();
    return;
  }
  response.statusCode = 200;
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(await readFile(filePath));
}

export function createDashboardHttpServer(options: DashboardHttpOptions): Server {
  const assetsDirectory = options.assetsDirectory ?? defaultDashboardAssetsDirectory();
  const status: Omit<DashboardStatus, 'database'> = {
    mcp: { available: true, command: 'horizonlayer' },
    rag: { enabled: options.ragEnabled },
    tools: [...DASHBOARD_TOOLS],
    version: options.version,
  };

  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    try {
      validateBrowserBoundary(request);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (url.pathname === '/api/status') {
        if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
        let database: DashboardStatus['database'] = 'connected';
        if (options.databaseHealth) {
          try {
            database = await options.databaseHealth() ? 'connected' : 'unavailable';
          } catch {
            database = 'unavailable';
          }
        }
        writeJson(response, 200, { ...status, database }, requestId);
        return;
      }

      if (url.pathname.startsWith('/api/tools/')) {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const toolName = url.pathname.slice('/api/tools/'.length);
        if (!DASHBOARD_TOOLS.has(toolName)) {
          throw new HttpError(404, `Unknown dashboard tool: ${toolName}`, 'NOT_FOUND');
        }
        const input = await readJson(request);
        const envelope = structuredContent(await options.appServer.callTool(toolName, input));
        writeJson(response, envelopeStatus(envelope), envelope, requestId);
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        throw new HttpError(404, 'API route not found', 'NOT_FOUND');
      }
      await serveStatic(request, response, assetsDirectory, url.pathname, requestId);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (error instanceof HttpError) {
        writeJson(response, error.status, errorEnvelope(error.code, error.message, requestId), requestId);
        return;
      }
      if (error instanceof McpError) {
        const statusCode = error.code === ErrorCode.InvalidParams ? 400 : 404;
        const code = error.code === ErrorCode.InvalidParams ? 'INVALID_ARGUMENT' : 'NOT_FOUND';
        writeJson(response, statusCode, errorEnvelope(code, error.message, requestId), requestId);
        return;
      }
      console.error(`[dashboard:${requestId}] ${error instanceof Error ? error.message : String(error)}`);
      writeJson(
        response,
        500,
        errorEnvelope('INTERNAL', 'Dashboard request failed', requestId),
        requestId
      );
    }
  });

  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.requestTimeout = 30_000;
  return server;
}
