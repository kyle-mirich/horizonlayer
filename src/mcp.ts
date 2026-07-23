import { EventEmitter } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { toJsonSchema } from 'xsschema';
import type { z } from 'zod';

export interface AppToolDefinition<Schema extends z.ZodTypeAny> {
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
  parameters: Schema;
  outputSchema: NonNullable<Tool['outputSchema']>;
  execute: (parameters: z.infer<Schema>) => CallToolResult | Promise<CallToolResult>;
}

export interface AppServerOptions {
  name: string;
  version: string;
  instructions?: string;
}

interface StoredTool {
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
  parameters: z.ZodTypeAny;
  outputSchema: NonNullable<Tool['outputSchema']>;
  execute: (parameters: unknown) => CallToolResult | Promise<CallToolResult>;
}

function closeStrictActionIntersectionBases(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) closeStrictActionIntersectionBases(item);
    return;
  }
  if (value == null || typeof value !== 'object') return;

  const node = value as Record<string, unknown>;
  if (Array.isArray(node.allOf)) {
    const base = node.allOf[0];
    if (base != null && typeof base === 'object' && !Array.isArray(base)) {
      const baseSchema = base as Record<string, unknown>;
      const properties = baseSchema.properties;
      if (properties != null && typeof properties === 'object' && !Array.isArray(properties)) {
        const action = (properties as Record<string, unknown>).action;
        if (action != null && typeof action === 'object' && !Array.isArray(action)
          && typeof (action as Record<string, unknown>).const === 'string'
          && baseSchema.additionalProperties === undefined) {
          // xsschema drops Zod's strict-object marker when that object is the
          // base of an intersection. Restore it so tools/list matches runtime.
          baseSchema.additionalProperties = false;
        }
      }
    }
  }

  for (const child of Object.values(node)) closeStrictActionIntersectionBases(child);
}

export class AppServer extends EventEmitter {
  private readonly server: Server;
  private readonly tools = new Map<string, StoredTool>();
  private readonly inputSchemas = new WeakMap<z.ZodTypeAny, Promise<Tool['inputSchema']>>();

  constructor(options: AppServerOptions) {
    super();
    this.server = new Server(
      { name: options.name, version: options.version },
      {
        capabilities: { tools: {} },
        instructions: options.instructions,
      }
    );

    this.server.onclose = () => {
      this.emit('disconnect');
    };

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await Promise.all(
        [...this.tools.values()].map(async (tool) => ({
          name: tool.name,
          description: tool.description,
          annotations: tool.annotations,
          inputSchema: await this.inputSchema(tool.parameters),
          outputSchema: tool.outputSchema,
        }))
      ),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.callTool(request.params.name, request.params.arguments ?? {});
    });
  }

  addTool<Schema extends z.ZodTypeAny>(tool: AppToolDefinition<Schema>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, {
      ...tool,
      execute: (parameters) => tool.execute(parameters as z.infer<Schema>),
    });
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async callTool(name: string, parameters: unknown): Promise<CallToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    const parsed = tool.parameters.safeParse(parameters ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${tool.name}: ${details}`);
    }

    return tool.execute(parsed.data);
  }

  async start(options: { transportType: 'stdio' }): Promise<void> {
    if (options.transportType !== 'stdio') {
      throw new Error(`Unsupported transport: ${String(options.transportType)}`);
    }
    await this.connect(new StdioServerTransport());
  }

  async stop(): Promise<void> {
    await this.server.close();
  }

  private inputSchema(schema: z.ZodTypeAny): Promise<Tool['inputSchema']> {
    const cached = this.inputSchemas.get(schema);
    if (cached) return cached;

    const converted = toJsonSchema(schema).then(
      (jsonSchema) => {
        const normalized = {
          ...jsonSchema,
          type: 'object',
        } as Tool['inputSchema'];
        closeStrictActionIntersectionBases(normalized);
        return normalized;
      }
    );
    this.inputSchemas.set(schema, converted);
    return converted;
  }
}
