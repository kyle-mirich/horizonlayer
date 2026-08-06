import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppServer } from './mcp.js';
import { COMPACT_REFERENCE_PATTERN } from './references.js';
import { successEnvelope } from './tools/common.js';
import { registerCoreTools } from './tools/core.js';

const Parameters = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), title: z.string().trim().min(1) }).strict(),
  z.object({ action: z.literal('get'), id: z.string().uuid() }).strict(),
]);
const OutputSchema = {
  type: 'object' as const,
  properties: {},
  additionalProperties: true,
};

async function connectClient(server: AppServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'adapter-test', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('AppServer official SDK adapter', () => {
  it('completes a clean tools/list handshake for every core tool', async () => {
    const server = new AppServer({ name: 'HorizonLayer test', version: '0.0.1' });
    registerCoreTools(server);

    const client = await connectClient(server);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'workspace',
        'session',
        'page',
        'database',
        'row',
        'link',
        'search',
        'run',
      ]);
      expect(listed.tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 0))
        .toBe(true);
      expect(listed.tools.find((tool) => tool.name === 'search')?.annotations).toMatchObject({
        idempotentHint: true,
        readOnlyHint: true,
      });
      expect(listed.tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
      expect(listed.tools.every((tool) => tool.outputSchema?.type === 'object')).toBe(true);
      expect(listed.tools.every((tool) => tool.outputSchema?.additionalProperties === false)).toBe(true);
      expect(listed.tools.every((tool) => {
        const output = tool.outputSchema as { oneOf?: unknown[]; properties?: { result?: unknown } };
        return (output.oneOf?.length ?? 0) >= 2
          && JSON.stringify(output.properties?.result) !== '{}';
      })).toBe(true);

      const actionTools = listed.tools.filter((tool) => tool.name !== 'search');
      expect(actionTools.every((tool) => Array.isArray(tool.inputSchema.anyOf))).toBe(true);

      const pageInput = listed.tools.find((tool) => tool.name === 'page')!.inputSchema as unknown as {
        anyOf?: Array<{
          properties?: {
            action?: { const?: string };
            workspace_id?: { anyOf?: Array<{ format?: string; pattern?: string; type?: string }> };
            page_id?: { $ref?: string };
          };
        }>;
      };
      const pageGet = pageInput.anyOf?.find((branch) => branch.properties?.action?.const === 'get');
      expect(pageInput.anyOf?.[0]?.properties?.workspace_id?.anyOf).toEqual([
        { type: 'string', format: 'uuid' },
        { type: 'string', pattern: COMPACT_REFERENCE_PATTERN.source },
      ]);
      expect(pageGet?.properties?.page_id).toEqual({ $ref: '#/anyOf/0/properties/session_id' });

      const searchInput = listed.tools.find((tool) => tool.name === 'search')!.inputSchema as unknown as {
        anyOf?: Array<{
          required?: string[];
          additionalProperties?: boolean;
          properties?: {
            mode?: { const?: string };
            scope?: {
              anyOf?: Array<{
                required?: string[];
                additionalProperties?: boolean;
                properties?: { kind?: { const?: string } };
              }>;
            };
          };
        }>;
      };
      expect(searchInput.anyOf).toHaveLength(2);
      expect(searchInput.anyOf?.every((branch) => (
        branch.required?.includes('query')
        && branch.required.includes('mode')
        && branch.required.includes('scope')
        && branch.additionalProperties === false
      ))).toBe(true);
      expect(searchInput.anyOf?.map((branch) => branch.properties?.mode?.const)).toEqual([
        'records',
        'rag',
      ]);
      const scopes = searchInput.anyOf?.[0].properties?.scope?.anyOf;
      expect(scopes?.map((branch) => branch.properties?.kind?.const)).toEqual([
        'workspace',
        'session',
        'database',
      ]);
      expect(scopes?.every((branch) => branch.additionalProperties === false)).toBe(true);
      expect(scopes?.map((branch) => branch.required)).toEqual([
        ['kind', 'workspace_id'],
        ['kind', 'session_id'],
        ['kind', 'database_id'],
      ]);

      for (const [toolName, action, mutableFields] of [
        ['workspace', 'update', ['name', 'description', 'icon']],
        ['page', 'update', ['title', 'tags', 'importance']],
        ['page', 'block_update', ['content', 'metadata']],
        ['database', 'update', ['name', 'description', 'tags']],
        ['database', 'property_update', ['name', 'options']],
        ['row', 'update', ['values', 'tags', 'importance']],
      ] as const) {
        const input = listed.tools.find((tool) => tool.name === toolName)!.inputSchema as unknown as {
          anyOf: Array<{
            allOf?: Array<{
              additionalProperties?: boolean;
              properties?: { action?: { const?: string } };
              anyOf?: Array<{ required?: string[]; additionalProperties?: boolean }>;
            }>;
          }>;
        };
        const update = input.anyOf.find((branch) => branch.allOf?.[0].properties?.action?.const === action);
        const alternatives = update?.allOf?.[1].anyOf;
        expect(update?.allOf?.[0].additionalProperties).toBe(false);
        expect(alternatives?.map((branch) => branch.required?.[0])).toEqual(mutableFields);
        expect(alternatives?.every((branch) => branch.additionalProperties === true)).toBe(true);
      }

      const listedJson = JSON.stringify(listed.tools);
      expect(listedJson).toContain('at most 16384 characters');
      expect(listedJson).toContain('limited to 8192 UTF-8 bytes');
      expect(listedJson).toContain('limited to 32768 UTF-8 bytes');
      expect(listedJson).toContain('cannot exceed 50');

      const pageOutput = listed.tools.find((tool) => tool.name === 'page')!.outputSchema as unknown as {
        oneOf: Array<{ title?: string; properties?: { result?: { properties?: Record<string, unknown> } } }>;
      };
      const append = pageOutput.oneOf.find((branch) => branch.title === 'append success');
      expect(append?.properties?.result?.properties).toHaveProperty('page_revision');
      expect(append?.properties?.result?.properties).toHaveProperty('blocks');

      const sessionOutput = listed.tools.find((tool) => tool.name === 'session')!.outputSchema as unknown as {
        oneOf: Array<{ title?: string; properties?: { result?: { properties?: Record<string, unknown> } } }>;
      };
      const resumeProperties = sessionOutput.oneOf.find((branch) => branch.title === 'resume success')
        ?.properties?.result?.properties;
      expect(resumeProperties).toHaveProperty('recent_pages');
      expect(resumeProperties).toHaveProperty('recent_runs');
      expect(resumeProperties).toHaveProperty('search_hits');
      expect(resumeProperties).toHaveProperty('collection_status');
      expect(resumeProperties).toHaveProperty('truncated');

      const searchOutput = listed.tools.find((tool) => tool.name === 'search')!.outputSchema as unknown as {
        oneOf: Array<{
          title?: string;
          properties?: {
            error?: { properties?: { code?: { enum?: string[] } } };
            result?: { anyOf?: Array<{ properties?: Record<string, unknown> }> };
          };
        }>;
        properties?: { error?: { anyOf?: Array<{ properties?: { code?: { enum?: string[] } } }> } };
      };
      const searchResultBranches = searchOutput.oneOf.find((branch) => branch.title === 'search success')
        ?.properties?.result?.anyOf;
      expect(searchResultBranches?.map((branch) => Object.keys(branch.properties ?? {}))).toEqual([
        ['mode', 'format', 'records', 'truncated'],
        ['mode', 'format', 'records', 'truncated'],
        ['mode', 'format', 'sources', 'chunks', 'truncated'],
        ['mode', 'format', 'chunks', 'truncated'],
      ]);
      const errorEnums = JSON.stringify(searchOutput.properties?.error);
      expect(errorEnums).toContain('DEPENDENCY_UNAVAILABLE');
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it('interoperates with the official client and retains action-specific schemas', async () => {
    let receivedParameters: z.infer<typeof Parameters> | undefined;
    const server = new AppServer({
      name: 'HorizonLayer test',
      version: '0.0.1',
      instructions: 'Start by selecting a workspace.',
    });
    server.addTool({
      name: 'page',
      description: 'Manage pages.',
      annotations: { readOnlyHint: false },
      parameters: Parameters,
      outputSchema: OutputSchema,
      execute: (parameters) => {
        receivedParameters = parameters;
        return successEnvelope({ action: parameters.action, result: parameters });
      },
    });

    const client = await connectClient(server);
    try {
      expect(client.getInstructions()).toBe('Start by selecting a workspace.');

      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(1);
      expect(listed.tools[0]).toMatchObject({
        name: 'page',
        description: 'Manage pages.',
        annotations: { readOnlyHint: false },
        inputSchema: { type: 'object' },
      });

      const inputSchema = listed.tools[0].inputSchema as {
        anyOf?: Array<{ properties?: { action?: { const?: string } } }>;
      };
      expect(inputSchema.anyOf?.map((branch) => branch.properties?.action?.const)).toEqual([
        'create',
        'get',
      ]);

      const result = await client.callTool({
        name: 'page',
        arguments: { action: 'create', title: '  Durable memory  ' },
      });
      expect(result).toMatchObject({
        structuredContent: {
          action: 'create',
          ok: true,
          result: { action: 'create', title: 'Durable memory' },
        },
      });
      expect(receivedParameters).toEqual({ action: 'create', title: 'Durable memory' });
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it('rejects invalid arguments before execution and reports disconnect once', async () => {
    const execute = vi.fn(() => ({
      content: [{ type: 'text' as const, text: 'unreachable' }],
    }));
    const disconnected = vi.fn();
    const server = new AppServer({ name: 'HorizonLayer test', version: '0.0.1' });
    server.once('disconnect', disconnected);
    server.addTool({ name: 'page', parameters: Parameters, outputSchema: OutputSchema, execute });

    const client = await connectClient(server);
    await expect(
      client.callTool({ name: 'page', arguments: { action: 'create', title: '   ' } })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(client.callTool({ name: 'missing', arguments: {} })).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
    });
    expect(execute).not.toHaveBeenCalled();

    await client.close();
    await server.stop();
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it('executes the same validated tool contract without a transport', async () => {
    const server = new AppServer({ name: 'HorizonLayer test', version: '0.0.1' });
    server.addTool({
      name: 'page',
      parameters: Parameters,
      outputSchema: OutputSchema,
      execute: (parameters) => successEnvelope({
        action: parameters.action,
        result: parameters,
      }),
    });

    await expect(server.callTool('page', {
      action: 'create',
      title: '  Shared command surface  ',
    })).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        result: { title: 'Shared command surface' },
      },
    });
    await expect(server.callTool('page', {
      action: 'create',
      title: '   ',
    })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects duplicate tool names', () => {
    const server = new AppServer({ name: 'HorizonLayer test', version: '0.0.1' });
    const tool = {
      name: 'page',
      parameters: Parameters,
      outputSchema: OutputSchema,
      execute: () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    };

    server.addTool(tool);
    expect(() => server.addTool(tool)).toThrow('Tool already registered: page');
  });
});
