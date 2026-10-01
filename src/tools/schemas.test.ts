import { describe, expect, it } from 'vitest';
import { toJsonSchema } from 'xsschema';
import { PageSchema, RowSchema, RunSchema, SessionSchema } from './schemas.js';

const id = '00000000-0000-4000-8000-000000000001';

function expectExactOwnKeys(value: unknown, expected: Record<string, unknown>): void {
  expect(Object.keys(value as object)).toEqual(Object.keys(expected));
  for (const key of Object.keys(expected)) {
    expect(Object.hasOwn(value as object, key)).toBe(true);
  }
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(JSON.stringify(value)).toBe(JSON.stringify(expected));
}

function advertisesObject(value: unknown): boolean {
  const schema = value as { type?: string; allOf?: Array<{ type?: string }> };
  return [schema, ...(schema.allOf ?? [])].some((part) => part.type === 'object');
}

describe('typed row value schemas', () => {
  it.each([
    '__proto__', 'constructor', 'prototype', 'toString', '__defineGetter__', '__defineSetter__',
  ])('retains the exact %s property name in creates and patches', (name) => {
    const values = JSON.parse(`{"${name}":"Named value"}`) as Record<string, unknown>;
    const create = RowSchema.parse({ action: 'create', database_id: id, values });
    const update = RowSchema.parse({ action: 'update', row_id: id, revision: 1, values });

    if (create.action !== 'create' || update.action !== 'update') {
      throw new Error('Unexpected parsed action');
    }
    for (const parsed of [create, update]) {
      expect(Object.hasOwn(parsed.values!, name)).toBe(true);
      expect(parsed.values![name]).toBe('Named value');
      expect(Object.getPrototypeOf(parsed.values)).toBe(Object.prototype);
      expect(JSON.stringify(parsed.values)).toBe(JSON.stringify(values));
    }
  });

  it('applies the serialized byte limit to __proto__ values', () => {
    const values = JSON.parse(`{"__proto__":"${'x'.repeat(32_768)}"}`) as Record<string, unknown>;
    const result = RowSchema.safeParse({ action: 'create', database_id: id, values });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('Row values must serialize to at most 32768 bytes');
    }
  });

  it('continues advertising row values as an object', async () => {
    const schema = await toJsonSchema(RowSchema);
    const create = (schema.anyOf as Array<Record<string, unknown>>).find((branch) =>
      JSON.stringify(branch).includes('"const":"create"')
    ) as { properties: { values: unknown } };

    expect(advertisesObject(create.properties.values)).toBe(true);
  });
});

describe('bounded JSON object schemas', () => {
  it('preserves exact own keys in session and block metadata', () => {
    const metadata = JSON.parse('{"__proto__":{"note":"Kept"},"constructor":"Named value"}') as Record<string, unknown>;
    const session = SessionSchema.parse({ action: 'start', workspace_id: id, metadata });
    const page = PageSchema.parse({
      action: 'create', workspace_id: id, title: 'Metadata', blocks: [{ content: 'Note', metadata }],
    });
    if (session.action !== 'start' || page.action !== 'create') throw new Error('Unexpected parsed action');

    expectExactOwnKeys(session.metadata, metadata);
    expectExactOwnKeys(page.blocks![0].metadata, metadata);
  });

  it('preserves exact own keys in checkpoint state and run results', () => {
    const record = JSON.parse('{"__proto__":"Resume here","toString":"Named value"}') as Record<string, unknown>;
    const checkpoint = RunSchema.parse({ action: 'checkpoint', run_id: id, state: record });
    const finish = RunSchema.parse({ action: 'finish', run_id: id, outcome: 'completed', result: record });
    if (checkpoint.action !== 'checkpoint' || finish.action !== 'finish') throw new Error('Unexpected parsed action');

    expectExactOwnKeys(checkpoint.state, record);
    expectExactOwnKeys(finish.result, record);
  });

  it.each([
    ['Metadata', SessionSchema, { action: 'start', workspace_id: id }, 'metadata', 8_192],
    ['Checkpoint state', RunSchema, { action: 'checkpoint', run_id: id, summary: 'Progress' }, 'state', 32_768],
    ['Run result', RunSchema, { action: 'finish', run_id: id, outcome: 'completed' }, 'result', 32_768],
  ] as const)('counts __proto__ in the %s serialized byte limit', (label, schema, input, field, bytes) => {
    const record = JSON.parse(`{"__proto__":"${'x'.repeat(bytes)}"}`) as Record<string, unknown>;
    const result = schema.safeParse({ ...input, [field]: record });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain(`${label} must serialize to at most ${bytes} bytes`);
    }
  });

  it.each([
    [SessionSchema, { action: 'start', workspace_id: id }, 'metadata'],
    [RunSchema, { action: 'checkpoint', run_id: id, summary: 'Progress' }, 'state'],
    [RunSchema, { action: 'finish', run_id: id, outcome: 'completed' }, 'result'],
  ] as const)('rejects arrays where JSON objects are required', (schema, input, field) => {
    expect(schema.safeParse({ ...input, [field]: ['value'] }).success).toBe(false);
  });

  it('advertises metadata and checkpoint state as JSON objects', async () => {
    const sessionSchema = await toJsonSchema(SessionSchema);
    const runSchema = await toJsonSchema(RunSchema);
    const start = (sessionSchema.anyOf as Array<Record<string, unknown>>).find((branch) =>
      JSON.stringify(branch).includes('"const":"start"')
    ) as { properties: { metadata: unknown } };
    const checkpoint = (runSchema.anyOf as Array<Record<string, unknown>>).find((branch) =>
      JSON.stringify(branch).includes('"const":"checkpoint"')
    ) as { properties: { state: unknown } };

    expect(advertisesObject(start.properties.metadata)).toBe(true);
    expect(advertisesObject(checkpoint.properties.state)).toBe(true);
  });
});
