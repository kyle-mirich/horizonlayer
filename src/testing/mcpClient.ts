import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export type JsonObject = Record<string, unknown>;

export const TOOL_NAMES = [
  'workspace',
  'session',
  'page',
  'database',
  'row',
  'link',
  'search',
  'run',
] as const;

export type ToolName = typeof TOOL_NAMES[number];
export type ToolErrorCode =
  | 'CONFLICT'
  | 'INTERNAL'
  | 'INVALID_ARGUMENT'
  | 'INVALID_REFERENCE'
  | 'NOT_FOUND';

export interface ToolEnvelope {
  action: string;
  error: null | {
    code: ToolErrorCode;
    message: string;
    retryable: boolean;
  };
  meta: JsonObject;
  ok: boolean;
  result: unknown;
}

const TOOL_ERROR_CODES = new Set<ToolErrorCode>([
  'CONFLICT',
  'INTERNAL',
  'INVALID_ARGUMENT',
  'INVALID_REFERENCE',
  'NOT_FOUND',
]);

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function asRecord(value: unknown, message: string): JsonObject {
  assert(value != null && typeof value === 'object' && !Array.isArray(value), message);
  return value as JsonObject;
}

export function asArray(value: unknown, message: string): unknown[] {
  assert(Array.isArray(value), message);
  return value;
}

export function getString(record: JsonObject, key: string): string {
  const value = record[key];
  assert(typeof value === 'string' && value.length > 0, `Expected ${key} to be a non-empty string`);
  return value;
}

export function getRevision(record: JsonObject, label: string): number {
  const revision = record.revision;
  assert(
    typeof revision === 'number' && Number.isInteger(revision) && revision > 0,
    `${label} did not return a positive integer revision`
  );
  return revision;
}

export function getPaginatedItems(value: unknown, label: string): JsonObject[] {
  const result = asRecord(value, `${label} result was not an object`);
  return asArray(result.items, `${label} result missing items`).map((item) =>
    asRecord(item, `${label} returned an invalid item`)
  );
}

export function parseCommandLine(input: string): string[] {
  const parts: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: 'single' | 'double' | null = null;

  const finishToken = () => {
    if (!tokenStarted) return;
    parts.push(token);
    token = '';
    tokenStarted = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      tokenStarted = true;
      continue;
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      tokenStarted = true;
      continue;
    }
    if (character === '\\' && quote !== 'single') {
      const next = input[index + 1];
      assert(next !== undefined, 'Command line cannot end with an escape character');
      if (quote === 'double' && next !== '"' && next !== '\\') {
        token += character;
        tokenStarted = true;
        continue;
      }
      index += 1;
      token += next;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character) && quote == null) {
      finishToken();
      continue;
    }

    token += character;
    tokenStarted = true;
  }

  assert(quote == null, `Command line contains an unterminated ${quote} quote`);
  finishToken();
  return parts;
}

export function resolveMcpCommand(): { args: string[]; command: string } {
  const commandParts = parseCommandLine(process.env.MCP_COMMAND ?? 'node');
  assert(commandParts.length > 0, 'MCP_COMMAND must contain an executable');
  return {
    command: commandParts[0],
    args: [
      ...commandParts.slice(1),
      ...parseCommandLine(process.env.MCP_ARGS ?? 'dist/launcher.js'),
    ],
  };
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

export function createStdioClient(name: string): {
  args: string[];
  client: Client;
  command: string;
  transport: StdioClientTransport;
} {
  const { args, command } = resolveMcpCommand();
  const client = new Client({ name, version: '0.0.1' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    args,
    command,
    cwd: process.cwd(),
    env: processEnvironment(),
  });
  return { args, client, command, transport };
}

export function parseToolEnvelope(
  toolName: ToolName,
  responseValue: unknown,
  expectedAction: string
): ToolEnvelope {
  const response = asRecord(responseValue, `${toolName} returned an invalid MCP response`);
  let payload: JsonObject;
  if (response.structuredContent !== undefined) {
    payload = asRecord(
      response.structuredContent,
      `${toolName} structured envelope was not an object`
    );
  } else {
    const textItem = asArray(response.content, `${toolName} response missing content`)
      .map((item) => asRecord(item, `${toolName} response contained invalid content`))
      .find((item) => item.type === 'text');
    assert(textItem && typeof textItem.text === 'string', `${toolName} response missing text content`);
    try {
      payload = asRecord(JSON.parse(textItem.text), `${toolName} envelope was not an object`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`${toolName} returned non-JSON text: ${textItem.text}`);
      }
      throw error;
    }
  }

  assert(typeof payload.ok === 'boolean', `${toolName} envelope missing boolean ok`);
  assert(payload.action === expectedAction, `${toolName} envelope action was not ${expectedAction}`);
  const meta = asRecord(payload.meta, `${toolName} envelope missing meta object`);
  const isError = response.isError;
  if (isError !== undefined) {
    assert(typeof isError === 'boolean', `${toolName} MCP isError flag was not boolean`);
    assert(isError === !payload.ok, `${toolName} MCP isError flag disagreed with its envelope`);
  }

  if (payload.ok) {
    assert(payload.error === null, `${toolName} successful envelope contained an error`);
    return {
      action: expectedAction,
      error: null,
      meta,
      ok: true,
      result: payload.result,
    };
  }

  assert(payload.result === null, `${toolName} failed envelope contained a result`);
  const error = asRecord(payload.error, `${toolName} failed envelope missing error details`);
  assert(
    typeof error.code === 'string' && TOOL_ERROR_CODES.has(error.code as ToolErrorCode),
    `${toolName} returned an unknown error code`
  );
  assert(typeof error.message === 'string' && error.message.length > 0, `${toolName} error missing message`);
  assert(typeof error.retryable === 'boolean', `${toolName} error missing retryable flag`);
  return {
    action: expectedAction,
    error: {
      code: error.code as ToolErrorCode,
      message: error.message,
      retryable: error.retryable,
    },
    meta,
    ok: false,
    result: null,
  };
}

export async function callToolEnvelope(
  client: Client,
  toolName: ToolName,
  args: JsonObject
): Promise<ToolEnvelope> {
  const expectedAction = typeof args.action === 'string' ? args.action : toolName;
  const response = await client.callTool({ name: toolName, arguments: args });
  return parseToolEnvelope(toolName, response, expectedAction);
}

export async function callTool(
  client: Client,
  toolName: ToolName,
  args: JsonObject
): Promise<ToolEnvelope> {
  const envelope = await callToolEnvelope(client, toolName, args);
  if (!envelope.ok) {
    throw new Error(
      `${toolName}/${envelope.action} failed [${envelope.error?.code}]: ${envelope.error?.message}`
    );
  }
  return envelope;
}

export async function closeClient(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // A failed child process may already have closed the transport.
  }
}
