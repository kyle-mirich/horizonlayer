import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import type { AppServer } from '../mcp.js';
import { registerCoreTools } from '../tools/core.js';

type ToolCall = {
  arguments: Record<string, unknown>;
  location: string;
  tool: string;
};

const UUID_FIELDS = new Set([
  'id',
  'workspace_id',
  'session_id',
  'page_id',
  'task_id',
  'run_id',
]);

function collectSchemas(): Map<string, ZodTypeAny> {
  const schemas = new Map<string, ZodTypeAny>();
  const server = {
    addTool(definition: { name: string; parameters: ZodTypeAny }) {
      schemas.set(definition.name, definition.parameters);
    },
  } as unknown as AppServer;

  registerCoreTools(server);

  return schemas;
}

function extractToolCalls(markdown: string, filePath: string): ToolCall[] {
  const matches = markdown.matchAll(/```json\n([\s\S]*?)```/g);
  const calls: ToolCall[] = [];

  let blockIndex = 0;
  for (const match of matches) {
    blockIndex += 1;

    const raw = match[1].trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const toolCall = parsed as Record<string, unknown>;
    if (typeof toolCall.tool !== 'string') continue;
    if (!toolCall.arguments || typeof toolCall.arguments !== 'object' || Array.isArray(toolCall.arguments)) continue;

    calls.push({
      tool: toolCall.tool,
      arguments: toolCall.arguments as Record<string, unknown>,
      location: `${filePath}#block-${blockIndex}`,
    });
  }

  return calls;
}

function fakeUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function normalizePlaceholderUuids(value: unknown, placeholderMap: Map<string, string>, path: string[] = []): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizePlaceholderUuids(item, placeholderMap, path));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizePlaceholderUuids(child, placeholderMap, [...path, key]),
      ])
    );
  }

  if (typeof value !== 'string') {
    return value;
  }

  const field = path[path.length - 1] ?? '';
  const shouldBeUuid =
    UUID_FIELDS.has(field)
    || field.endsWith('_id')
    || field.endsWith('_ids');

  if (!shouldBeUuid) {
    return value;
  }

  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if (looksLikeUuid) {
    return value;
  }

  const placeholderKey = value.trim();
  if (!placeholderMap.has(placeholderKey)) {
    placeholderMap.set(placeholderKey, fakeUuid(placeholderMap.size + 1));
  }

  return placeholderMap.get(placeholderKey)!;
}

describe('markdown tool examples', () => {
  it('match the live tool schemas', () => {
    const schemas = collectSchemas();
    const root = process.cwd();
    const files = [
      join(root, 'docs', 'api.md'),
      ...readdirSync(join(root, 'examples'))
        .filter((name) => name.endsWith('.md'))
        .map((name) => join(root, 'examples', name)),
    ];

    const placeholderMap = new Map<string, string>();
    const failures: string[] = [];

    for (const filePath of files) {
      const markdown = readFileSync(filePath, 'utf8');
      const toolCalls = extractToolCalls(markdown, filePath);

      for (const call of toolCalls) {
        const schema = schemas.get(call.tool);
        if (!schema) {
          failures.push(`${call.location}: unknown tool '${call.tool}'`);
          continue;
        }

        const normalized = normalizePlaceholderUuids(call.arguments, placeholderMap);
        const parsed = schema.safeParse(normalized);

        if (!parsed.success) {
          failures.push(
            `${call.location}: ${call.tool} arguments do not match schema\n${parsed.error.message}`
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
