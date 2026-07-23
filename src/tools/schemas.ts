import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  BLOCK_TYPES,
  LINK_ITEM_TYPES,
  RUN_STATUSES,
} from '../domain.js';
import { COMPACT_REFERENCE_PATTERN, expandReference } from '../references.js';

const Id = z.union([
  z.string().uuid(),
  z.string().regex(COMPACT_REFERENCE_PATTERN),
], {
  errorMap: () => ({ message: 'Expected a HorizonLayer UUID or compact reference' }),
}).transform(expandReference).describe(
  'HorizonLayer UUID or lossless compact reference returned by search (for example p_… for a page)'
);
const Revision = z.number().int().positive().describe('Current entity revision returned by the last read');
const Limit = z.number().int().min(1).max(50).optional().describe('Page size; defaults to 50 and cannot exceed 50');
const Offset = z.number().int().nonnegative().optional().describe('Zero-based result offset; defaults to 0');
const WorkspaceId = Id.describe('Workspace scope; obtain this from workspace list or create');

const MAX_JSON_METADATA_BYTES = 8 * 1024;
const MAX_JSON_RECORD_BYTES = 32 * 1024;
const MAX_BLOCK_CONTENT_CHARACTERS = 16_384;
const MAX_TAGS = 50;
const MAX_TAG_CHARACTERS = 100;
const MAX_CHOICE_CHARACTERS = 200;

function serializedJsonBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return null;
  }
}

function boundedJsonObject(maxBytes: number, label: string) {
  return z.record(z.unknown()).superRefine((value, context) => {
    const bytes = serializedJsonBytes(value);
    if (bytes === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be JSON-serializable` });
    } else if (bytes > maxBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must serialize to at most ${maxBytes} bytes`,
      });
    }
  }).describe(`${label}; JSON object serialized size is limited to ${maxBytes} UTF-8 bytes`);
}

function boundedJsonValue(maxBytes: number, label: string) {
  return z.unknown().superRefine((value, context) => {
    const bytes = serializedJsonBytes(value);
    if (bytes === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be JSON-serializable` });
    } else if (bytes > maxBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must serialize to at most ${maxBytes} bytes`,
      });
    }
  }).describe(`${label}; serialized size is limited to ${maxBytes} UTF-8 bytes`);
}

const Metadata = boundedJsonObject(MAX_JSON_METADATA_BYTES, 'Metadata');
const RunState = boundedJsonObject(MAX_JSON_RECORD_BYTES, 'Checkpoint state');
const RunResult = boundedJsonObject(MAX_JSON_RECORD_BYTES, 'Run result');
const Tag = z.string().trim().min(1).max(MAX_TAG_CHARACTERS)
  .describe(`Non-empty tag, at most ${MAX_TAG_CHARACTERS} characters`);
const Tags = z.array(Tag).max(MAX_TAGS)
  .describe(`At most ${MAX_TAGS} tags; filters match when ANY requested tag overlaps a record tag`);

const BlockInput = z.object({
  block_type: z.enum(BLOCK_TYPES).optional().describe('Block type; defaults to text'),
  content: z.string().max(MAX_BLOCK_CONTENT_CHARACTERS)
    .describe(`Block text content; at most ${MAX_BLOCK_CONTENT_CHARACTERS} characters`),
  metadata: Metadata.optional(),
}).strict();

const PropertyName = z.string().trim().min(1).max(255)
  .describe('Exact active database property name (not a property ID)');
const ChoiceOptions = z.object({
  choices: z.array(z.string().trim().min(1).max(MAX_CHOICE_CHARACTERS))
    .max(100)
    .describe('Allowed values; matching is exact and case-sensitive'),
}).strict().describe('Complete select or multi_select choice configuration');

const PropertyInput = z.discriminatedUnion('property_type', [
  z.object({
    name: PropertyName,
    property_type: z.enum(['title', 'text', 'number', 'date', 'checkbox', 'url']),
  }).strict(),
  z.object({
    name: PropertyName,
    property_type: z.enum(['select', 'multi_select']),
    options: ChoiceOptions.optional(),
  }).strict(),
]).describe(
  'Typed database property. A database has exactly one title property; if omitted at create, HorizonLayer adds Title. '
  + 'The title value is required and non-null on every row. select accepts one choice string; multi_select accepts an array of choice strings.'
);

const FilterValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.unknown()),
]).and(boundedJsonValue(MAX_JSON_METADATA_BYTES, 'Filter value')).describe(
  'Typed comparison value encoded like a row property: string for title/text/url/select/date, number, boolean, '
  + 'string[] for multi_select, or null for eq/neq empty checks'
);

const RowValues = boundedJsonObject(MAX_JSON_RECORD_BYTES, 'Row values').and(
  z.record(PropertyName, z.unknown())
).describe(
  'Object keys are exact active property names. title/text/url/select use strings; number uses a finite JSON number; '
  + 'date uses an ISO-8601 string; checkbox uses boolean; multi_select uses an array of allowed choice strings. '
  + 'null clears a non-title property. Create must include a non-null title; update patches only supplied keys and cannot clear title.'
);
const RowValuePatch = RowValues.refine((value) => Object.keys(value).length > 0, {
  message: 'Row value updates must contain at least one property',
}).describe('Non-empty row value patch keyed by exact active property names');

const RowFilter = z.discriminatedUnion('operator', [
  z.object({
    property: PropertyName,
    operator: z.literal('is_empty'),
  }).strict(),
  z.object({
    property: PropertyName,
    operator: z.enum(['eq', 'neq', 'gt', 'lt', 'contains']),
    value: FilterValue,
  }).strict(),
]).describe(
  'Filter one property by its exact name. gt/lt support number or date. contains is a literal case-insensitive substring '
  + 'for title/text/url/select and exact choice membership for multi_select. is_empty has no value.'
);

const WorkspaceName = z.string().trim().min(1).max(500);
const WorkspaceDescriptionUpdate = z.string().max(10_000).nullable();
const WorkspaceIconUpdate = z.string().max(100).nullable();
const WorkspaceUpdateSchema = z.object({
  action: z.literal('update'),
  workspace_id: WorkspaceId,
  revision: Revision,
  name: WorkspaceName.optional(),
  description: WorkspaceDescriptionUpdate.optional(),
  icon: WorkspaceIconUpdate.optional(),
}).strict().and(z.union([
  z.object({ name: WorkspaceName }).passthrough(),
  z.object({ description: WorkspaceDescriptionUpdate }).passthrough(),
  z.object({ icon: WorkspaceIconUpdate }).passthrough(),
])).describe('Update a workspace; at least one of name, description, or icon is required');

export const WorkspaceSchema = z.union([
  z.object({
    action: z.literal('create'),
    name: WorkspaceName,
    description: z.string().max(10_000).optional(),
    icon: z.string().max(100).optional(),
  }).strict(),
  z.object({
    action: z.literal('list'),
    include_archived: z.boolean().optional(),
    limit: Limit,
    offset: Offset,
  }).strict(),
  z.object({
    action: z.literal('get'),
    workspace_id: WorkspaceId,
    include_archived: z.boolean().optional(),
  }).strict(),
  WorkspaceUpdateSchema,
  z.object({ action: z.literal('archive'), workspace_id: WorkspaceId, revision: Revision }).strict(),
  z.object({ action: z.literal('restore'), workspace_id: WorkspaceId, revision: Revision }).strict(),
]);

export const SessionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    workspace_id: WorkspaceId,
    title: z.string().trim().min(1).max(500).optional(),
    summary: z.string().max(20_000).optional(),
    metadata: Metadata.optional(),
  }).strict(),
  z.object({
    action: z.literal('list'),
    workspace_id: WorkspaceId,
    status: z.array(z.enum(['active', 'closed'])).min(1).max(2).optional(),
    limit: Limit,
    offset: Offset,
  }).strict(),
  z.object({
    action: z.literal('resume'),
    session_id: Id,
    workspace_id: WorkspaceId.optional(),
    max_items: z.number().int().min(1).max(50).optional()
      .describe('Maximum items returned for each resume collection; defaults to 10 and cannot exceed 50'),
  }).strict(),
  z.object({ action: z.literal('close'), session_id: Id }).strict(),
]);

const PageTitle = z.string().trim().min(1).max(500);
const PageImportance = z.number().min(0).max(1);
const PageUpdateSchema = z.object({
  action: z.literal('update'),
  page_id: Id,
  revision: Revision,
  title: PageTitle.optional(),
  tags: Tags.optional(),
  importance: PageImportance.optional(),
}).strict().and(z.union([
  z.object({ title: PageTitle }).passthrough(),
  z.object({ tags: Tags }).passthrough(),
  z.object({ importance: PageImportance }).passthrough(),
])).describe('Update a page; at least one of title, tags, or importance is required');

const BlockContentUpdate = z.string().max(MAX_BLOCK_CONTENT_CHARACTERS)
  .describe(`Replacement block content; at most ${MAX_BLOCK_CONTENT_CHARACTERS} characters`);
const BlockUpdateSchema = z.object({
  action: z.literal('block_update'),
  block_id: Id,
  revision: Revision,
  content: BlockContentUpdate.optional(),
  metadata: Metadata.optional(),
}).strict().and(z.union([
  z.object({ content: BlockContentUpdate }).passthrough(),
  z.object({ metadata: Metadata }).passthrough(),
])).describe('Update a block; content, metadata, or both is required');

export const PageSchema = z.union([
  z.object({
    action: z.literal('create'),
    workspace_id: WorkspaceId,
    title: PageTitle,
    session_id: Id.optional(),
    parent_page_id: Id.optional(),
    tags: Tags.optional(),
    importance: PageImportance.optional(),
    blocks: z.array(BlockInput).max(100).optional(),
  }).strict(),
  z.object({
    action: z.literal('get'),
    page_id: Id,
    session_id: Id.optional(),
    include_archived: z.boolean().optional(),
    block_limit: z.number().int().min(1).max(50).optional()
      .describe('Blocks to return; defaults to 50 and cannot exceed 50'),
    block_offset: Offset,
  }).strict(),
  z.object({
    action: z.literal('list'),
    workspace_id: WorkspaceId,
    session_id: Id.optional(),
    parent_page_id: Id.optional(),
    tags: Tags.optional(),
    min_importance: PageImportance.optional(),
    include_archived: z.boolean().optional(),
    limit: Limit,
    offset: Offset,
  }).strict(),
  PageUpdateSchema,
  z.object({
    action: z.literal('append'),
    page_id: Id,
    revision: Revision,
    session_id: Id.optional(),
    blocks: z.array(BlockInput).min(1).max(100),
  }).strict(),
  BlockUpdateSchema,
  z.object({ action: z.literal('archive'), page_id: Id, revision: Revision }).strict(),
  z.object({ action: z.literal('restore'), page_id: Id, revision: Revision }).strict(),
  z.object({ action: z.literal('block_archive'), block_id: Id, revision: Revision }).strict(),
  z.object({ action: z.literal('block_restore'), block_id: Id, revision: Revision }).strict(),
]);

const DatabaseName = z.string().trim().min(1).max(500);
const DatabaseDescriptionUpdate = z.string().max(10_000).nullable();
const DatabaseUpdateSchema = z.object({
  action: z.literal('update'),
  database_id: Id,
  revision: Revision,
  name: DatabaseName.optional(),
  description: DatabaseDescriptionUpdate.optional(),
  tags: Tags.optional(),
}).strict().and(z.union([
  z.object({ name: DatabaseName }).passthrough(),
  z.object({ description: DatabaseDescriptionUpdate }).passthrough(),
  z.object({ tags: Tags }).passthrough(),
])).describe('Update a database; at least one of name, description, or tags is required');

const PropertyUpdateName = z.string().trim().min(1).max(255);
const PropertyUpdateOptions = ChoiceOptions.describe('Replacement choices for a select or multi_select property');
const PropertyUpdateSchema = z.object({
  action: z.literal('property_update'),
  property_id: Id,
  revision: Revision.describe('Current property revision'),
  name: PropertyUpdateName.optional(),
  options: PropertyUpdateOptions.optional(),
}).strict().and(z.union([
  z.object({ name: PropertyUpdateName }).passthrough(),
  z.object({ options: PropertyUpdateOptions }).passthrough(),
])).describe('Update a property; name, options, or both is required');

export const DatabaseSchema = z.union([
  z.object({
    action: z.literal('create'),
    workspace_id: WorkspaceId,
    name: DatabaseName,
    description: z.string().max(10_000).optional(),
    parent_page_id: Id.optional(),
    tags: Tags.optional(),
    properties: z.array(PropertyInput).max(100).optional().describe(
      'Initial schema. Define at most one title property; if none is supplied, HorizonLayer prepends a required Title property.'
    ),
  }).strict(),
  z.object({
    action: z.literal('list'),
    workspace_id: WorkspaceId,
    tags: Tags.optional(),
    include_archived: z.boolean().optional(),
    limit: Limit,
    offset: Offset,
  }).strict(),
  z.object({ action: z.literal('get'), database_id: Id, include_archived: z.boolean().optional() }).strict(),
  DatabaseUpdateSchema,
  z.object({ action: z.literal('archive'), database_id: Id, revision: Revision }).strict(),
  z.object({ action: z.literal('restore'), database_id: Id, revision: Revision }).strict(),
  z.object({
    action: z.literal('property_add'),
    database_id: Id,
    revision: Revision.describe('Current database revision'),
    property: PropertyInput,
  }).strict(),
  PropertyUpdateSchema,
  z.object({ action: z.literal('property_archive'), property_id: Id, revision: Revision }).strict(),
  z.object({ action: z.literal('property_restore'), property_id: Id, revision: Revision }).strict(),
]);

const RowQueryFields = {
  action: z.literal('query'),
  database_id: Id,
  filters: z.array(RowFilter).max(50).optional().describe('All supplied filters are combined with AND'),
  tags: Tags.optional(),
  include_archived: z.boolean().optional(),
  limit: Limit,
  offset: Offset,
};

const RowImportance = z.number().min(0).max(1);
const RowUpdateSchema = z.object({
  action: z.literal('update'),
  row_id: Id,
  revision: Revision,
  values: RowValuePatch.optional(),
  tags: Tags.optional(),
  importance: RowImportance.optional(),
}).strict().and(z.union([
  z.object({ values: RowValuePatch }).passthrough(),
  z.object({ tags: Tags }).passthrough(),
  z.object({ importance: RowImportance }).passthrough(),
])).describe('Update a row; values, tags, or importance is required');

export const RowSchema = z.union([
  z.object({
    action: z.literal('create'),
    database_id: Id,
    values: RowValues,
    tags: Tags.optional(),
    importance: RowImportance.optional(),
  }).strict(),
  z.object({ action: z.literal('get'), row_id: Id, include_archived: z.boolean().optional() }).strict(),
  z.object({
    ...RowQueryFields,
  }).strict().describe('Query rows in default updated-at order'),
  z.object({
    ...RowQueryFields,
    sort_by: PropertyName.describe('Exact property name to sort by; multi_select properties cannot be sorted'),
    sort_direction: z.enum(['asc', 'desc']).optional().describe('Sort order; defaults to asc'),
  }).strict(),
  RowUpdateSchema,
  z.object({ action: z.literal('archive'), row_id: Id, revision: Revision }).strict(),
  z.object({ action: z.literal('restore'), row_id: Id, revision: Revision }).strict(),
]);

const LinkListFields = {
  action: z.literal('list'),
  workspace_id: WorkspaceId,
  link_type: z.string().trim().min(1).max(100).optional(),
  include_archived: z.boolean().optional(),
  limit: Limit,
  offset: Offset,
};

export const LinkSchema = z.union([
  z.object({
    action: z.literal('create'),
    workspace_id: WorkspaceId,
    from_type: z.enum(LINK_ITEM_TYPES),
    from_id: Id,
    to_type: z.enum(LINK_ITEM_TYPES),
    to_id: Id,
    link_type: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  z.object({
    ...LinkListFields,
  }).strict().describe('List links without filtering by an endpoint'),
  z.object({
    ...LinkListFields,
    item_type: z.enum(LINK_ITEM_TYPES).describe('Endpoint entity type; must be paired with item_id'),
    item_id: Id.describe('Endpoint entity ID; must be paired with item_type'),
    direction: z.enum(['from', 'to', 'both']).optional()
      .describe('Match the endpoint as source, target, or either; defaults to both'),
  }).strict(),
  z.object({ action: z.literal('archive'), link_id: Id, revision: Revision }).strict(),
  z.object({ action: z.literal('restore'), link_id: Id, revision: Revision }).strict(),
]);

const SearchFields = {
  query: z.string().trim().min(1).max(1_000),
  tags: Tags.optional(),
  min_importance: z.number().min(0).max(1).optional(),
  format: z.enum(['compact', 'full']).optional().describe(
    'Response detail; defaults to compact. Use full for canonical UUIDs and exact metadata.'
  ),
};
const SearchRecordTypes = z.union([
  z.tuple([z.literal('page')]),
  z.tuple([z.literal('row')]),
  z.tuple([z.literal('page'), z.literal('row')]),
  z.tuple([z.literal('row'), z.literal('page')]),
]).describe('Unique canonical record kinds; omit to search both pages and rows');
const SearchScope = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workspace'),
    workspace_id: WorkspaceId,
    types: SearchRecordTypes.optional(),
  }).strict(),
  z.object({
    kind: z.literal('session'),
    session_id: Id.describe('Restrict search to pages attached to this session'),
  }).strict(),
  z.object({
    kind: z.literal('database'),
    database_id: Id.describe('Restrict search to rows in this database'),
  }).strict(),
]).describe(
  'Required search boundary. Workspace scope can select page and/or row records; session scope is page-only; database scope is row-only.'
);

export const SearchSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('records'),
    ...SearchFields,
    scope: SearchScope,
    limit: z.number().int().min(1).max(50).optional()
      .describe('Maximum canonical records; defaults to 20 and cannot exceed 50'),
  }).strict(),
  z.object({
    mode: z.literal('rag'),
    ...SearchFields,
    scope: SearchScope,
    limit: z.number().int().min(1).max(20).optional()
      .describe('Maximum citation-ready chunks; defaults to 8 and cannot exceed 20'),
  }).strict(),
]).describe(
  'Choose records for actionable pages/rows, or rag for semantic evidence. Compact output is default; RAG citations use sources[index].'
);

const CheckpointFields = {
  action: z.literal('checkpoint'),
  run_id: Id,
  summary: z.string().trim().min(1).max(20_000).optional(),
  state: RunState.optional(),
  metadata: Metadata.optional(),
};

const CheckpointSchema = z.object(CheckpointFields).strict().superRefine((value, context) => {
  if (value.summary === undefined
    && Object.keys(value.state ?? {}).length === 0
    && Object.keys(value.metadata ?? {}).length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A checkpoint requires a non-blank summary, non-empty state, or non-empty metadata',
    });
  }
}).describe('Persist meaningful resumable progress; completely blank checkpoints are rejected');

export const RunSchema = z.union([
  z.object({
    action: z.literal('start'),
    workspace_id: WorkspaceId,
    session_id: Id.optional(),
    agent_name: z.string().trim().min(1).max(255),
    title: z.string().trim().min(1).max(500).optional(),
    metadata: Metadata.optional(),
  }).strict(),
  z.object({
    action: z.literal('get'),
    run_id: Id,
    checkpoint_limit: z.number().int().min(1).max(50).optional()
      .describe('Checkpoints to return; defaults to 20 and cannot exceed 50'),
    checkpoint_offset: Offset,
  }).strict(),
  z.object({
    action: z.literal('list'),
    workspace_id: WorkspaceId,
    session_id: Id.optional(),
    agent_name: z.string().trim().min(1).max(255).optional(),
    status: z.array(z.enum(RUN_STATUSES)).min(1).max(RUN_STATUSES.length).optional(),
    limit: Limit,
    offset: Offset,
  }).strict(),
  CheckpointSchema,
  z.object({
    action: z.literal('finish'),
    run_id: Id,
    outcome: z.literal('failed'),
    result: RunResult.optional(),
    error_message: z.string().trim().min(1).max(20_000).optional().describe('Optional failure detail'),
  }).strict(),
  z.object({
    action: z.literal('finish'),
    run_id: Id,
    outcome: z.enum(['completed', 'cancelled']),
    result: RunResult.optional(),
  }).strict(),
]);

type JsonSchema = Record<string, unknown>;
type ObjectProperties = Record<string, JsonSchema>;

const stringSchema = (description?: string): JsonSchema => ({
  type: 'string',
  ...(description ? { description } : {}),
});
const integerSchema = (minimum = 0): JsonSchema => ({ type: 'integer', minimum });
const numberSchema: JsonSchema = { type: 'number' };
const booleanSchema: JsonSchema = { type: 'boolean' };
const nullSchema: JsonSchema = { type: 'null' };
const idSchema: JsonSchema = { type: 'string', format: 'uuid' };
const timestampSchema: JsonSchema = { type: 'string', format: 'date-time' };
const jsonObjectSchema: JsonSchema = { type: 'object', additionalProperties: true };
const tagsSchema: JsonSchema = { type: 'array', items: { type: 'string' } };

function objectSchema(
  properties: ObjectProperties,
  required: string[] = Object.keys(properties),
  description?: string
): JsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    ...(description ? { description } : {}),
  };
}

function arraySchema(items: JsonSchema): JsonSchema {
  return { type: 'array', items };
}

function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, nullSchema] };
}

const PageInfoOutput = objectSchema({
  has_more: booleanSchema,
  limit: { type: 'integer', minimum: 1, maximum: 50 },
  next_offset: nullable(integerSchema()),
  offset: integerSchema(),
});

function paginatedOutput(item: JsonSchema, includeTotal = false): JsonSchema {
  return objectSchema({
    items: arraySchema(item),
    page: PageInfoOutput,
    ...(includeTotal ? { total: integerSchema() } : {}),
  });
}

const workspaceProperties: ObjectProperties = {
  id: idSchema,
  name: stringSchema(),
  description: nullable(stringSchema()),
  icon: nullable(stringSchema()),
  revision: integerSchema(1),
  archived_at: nullable(timestampSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema,
};
const WorkspaceOutput = objectSchema(workspaceProperties);
const WorkspaceWithCountsOutput = objectSchema({
  ...workspaceProperties,
  page_count: integerSchema(),
  database_count: integerSchema(),
  session_count: integerSchema(),
});

const sessionProperties: ObjectProperties = {
  id: idSchema,
  workspace_id: idSchema,
  title: stringSchema(),
  status: { enum: ['active', 'closed'] },
  summary: nullable(stringSchema()),
  metadata: jsonObjectSchema,
  started_at: timestampSchema,
  last_activity_at: timestampSchema,
  ended_at: nullable(timestampSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema,
};
const SessionOutput = objectSchema(sessionProperties);
const SessionWithCountsOutput = objectSchema({
  ...sessionProperties,
  page_count: integerSchema(),
  run_count: integerSchema(),
});

const blockProperties: ObjectProperties = {
  id: idSchema,
  page_id: idSchema,
  block_type: { enum: [...BLOCK_TYPES] },
  content: stringSchema(),
  position: integerSchema(),
  metadata: jsonObjectSchema,
  revision: integerSchema(1),
  archived_at: nullable(timestampSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema,
};
const BlockOutput = objectSchema(blockProperties);

const pageProperties: ObjectProperties = {
  id: idSchema,
  workspace_id: idSchema,
  session_id: nullable(idSchema),
  parent_page_id: nullable(idSchema),
  title: stringSchema(),
  tags: tagsSchema,
  importance: numberSchema,
  revision: integerSchema(1),
  archived_at: nullable(timestampSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema,
};
const PageOutput = objectSchema(pageProperties);
const PageWithBlocksOutput = objectSchema({ ...pageProperties, blocks: arraySchema(BlockOutput) });
const PageDetailsOutput = objectSchema({
  ...pageProperties,
  blocks: arraySchema(BlockOutput),
  blocks_page: PageInfoOutput,
});
const PageBlocksMutationOutput = objectSchema({
  blocks: arraySchema(BlockOutput),
  page_revision: integerSchema(1),
});
const PageBlockMutationOutput = objectSchema({
  block: BlockOutput,
  page_revision: integerSchema(1),
});

const propertyOptionsOutput = objectSchema(
  { choices: arraySchema(stringSchema()) },
  [],
  'select and multi_select choices; empty object for other property types'
);
const propertyProperties: ObjectProperties = {
  id: idSchema,
  database_id: idSchema,
  name: stringSchema(),
  property_type: { enum: ['title', 'text', 'number', 'date', 'checkbox', 'select', 'multi_select', 'url'] },
  options: propertyOptionsOutput,
  position: integerSchema(),
  revision: integerSchema(1),
  archived_at: nullable(timestampSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema,
};
const DatabasePropertyOutput = objectSchema(propertyProperties);
const databaseProperties: ObjectProperties = {
  id: idSchema,
  workspace_id: idSchema,
  parent_page_id: nullable(idSchema),
  name: stringSchema(),
  description: nullable(stringSchema()),
  tags: tagsSchema,
  revision: integerSchema(1),
  archived_at: nullable(timestampSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema,
};
const DatabaseOutput = objectSchema(databaseProperties);
const DatabaseWithPropertiesOutput = objectSchema({
  ...databaseProperties,
  properties: arraySchema(DatabasePropertyOutput),
});
const DatabasePropertyMutationOutput = objectSchema({
  property: DatabasePropertyOutput,
  database_revision: integerSchema(1),
});

const rowProperties: ObjectProperties = {
  id: idSchema,
  database_id: idSchema,
  tags: tagsSchema,
  importance: numberSchema,
  revision: integerSchema(1),
  archived_at: nullable(timestampSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  values: jsonObjectSchema,
};
const RowOutput = objectSchema(rowProperties);

const linkProperties: ObjectProperties = {
  id: idSchema,
  workspace_id: idSchema,
  from_type: { enum: [...LINK_ITEM_TYPES] },
  from_id: idSchema,
  to_type: { enum: [...LINK_ITEM_TYPES] },
  to_id: idSchema,
  link_type: stringSchema(),
  revision: integerSchema(1),
  archived_at: nullable(timestampSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema,
};
const LinkOutput = objectSchema(linkProperties);

const checkpointProperties: ObjectProperties = {
  id: idSchema,
  run_id: idSchema,
  sequence: integerSchema(1),
  summary: nullable(stringSchema()),
  state: jsonObjectSchema,
  metadata: jsonObjectSchema,
  created_at: timestampSchema,
};
const RunCheckpointOutput = objectSchema(checkpointProperties);
const runProperties: ObjectProperties = {
  id: idSchema,
  workspace_id: idSchema,
  session_id: nullable(idSchema),
  agent_name: stringSchema(),
  title: nullable(stringSchema()),
  status: { enum: [...RUN_STATUSES] },
  metadata: jsonObjectSchema,
  result: jsonObjectSchema,
  error_message: nullable(stringSchema()),
  latest_checkpoint_sequence: integerSchema(),
  latest_checkpoint_at: nullable(timestampSchema),
  started_at: timestampSchema,
  finished_at: nullable(timestampSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema,
};
const RunOutput = objectSchema(runProperties);
const RunDetailsOutput = objectSchema({
  ...runProperties,
  checkpoints: arraySchema(RunCheckpointOutput),
  checkpoints_page: PageInfoOutput,
});
const RunCheckpointMutationOutput = objectSchema({
  checkpoint: RunCheckpointOutput,
  run: RunOutput,
});
const RunFinishMutationOutput = objectSchema({
  latest_checkpoint: nullable(RunCheckpointOutput),
  run: RunOutput,
});

const SessionResumePageOutput = objectSchema({
  id: idSchema,
  parent_page_id: nullable(idSchema),
  title: stringSchema(),
  revision: integerSchema(1),
  importance: numberSchema,
  tags: tagsSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  content_preview: stringSchema(),
});
const SessionResumeRunOutput = objectSchema({
  ...runProperties,
  latest_checkpoint: nullable(RunCheckpointOutput),
});
const SessionResumeSearchHitOutput = objectSchema({
  id: idSchema,
  title: stringSchema(),
  score: numberSchema,
  snippet: stringSchema(),
  updated_at: timestampSchema,
});
const CollectionStatusOutput = objectSchema({
  complete: booleanSchema,
  has_more: booleanSchema,
  limit: { type: 'integer', minimum: 1, maximum: 50 },
  returned: integerSchema(),
});
const SessionResumeOutput = objectSchema({
  session: SessionWithCountsOutput,
  recent_pages: arraySchema(SessionResumePageOutput),
  recent_runs: arraySchema(SessionResumeRunOutput),
  search_hits: arraySchema(SessionResumeSearchHitOutput),
  collection_status: objectSchema({
    recent_pages: CollectionStatusOutput,
    recent_runs: CollectionStatusOutput,
    search_hits: CollectionStatusOutput,
  }),
  truncated: booleanSchema,
});

const SearchRecordOutput = objectSchema({
  id: idSchema,
  type: { enum: ['page', 'row'] },
  title: stringSchema(),
  score: numberSchema,
  snippet: stringSchema(),
  workspace_id: idSchema,
  session_id: nullable(idSchema),
  parent_page_id: nullable(idSchema),
  database_id: nullable(idSchema),
  tags: tagsSchema,
  importance: numberSchema,
  revision: integerSchema(1),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

const compactReferenceSchema: JsonSchema = {
  type: 'string',
  pattern: COMPACT_REFERENCE_PATTERN.source,
  description: 'Lossless typed reference accepted anywhere a HorizonLayer UUID is accepted',
};
const compactDateSchema: JsonSchema = {
  type: 'string',
  format: 'date-time',
  description: 'UTC timestamp precise to the second',
};
const CompactSearchRecordOutput = objectSchema({
  ref: compactReferenceSchema,
  title: stringSchema(),
  score: numberSchema,
  snippet: stringSchema(),
  rev: integerSchema(1),
  updated: compactDateSchema,
  database_ref: compactReferenceSchema,
}, ['ref', 'title', 'score', 'snippet', 'rev', 'updated']);

const ragPageCitationProperties: ObjectProperties = {
  type: { const: 'page' },
  id: idSchema,
  workspace_id: idSchema,
  title: stringSchema(),
  revision: integerSchema(1),
  updated_at: timestampSchema,
};
const RagPageTitleCitationOutput = objectSchema({
  ...ragPageCitationProperties,
  part: { const: 'title' },
});
const RagPageBlockCitationOutput = objectSchema({
  ...ragPageCitationProperties,
  part: { const: 'block' },
  block_id: idSchema,
  block_revision: integerSchema(1),
  block_type: { enum: [...BLOCK_TYPES] },
  block_position: integerSchema(),
  char_start: integerSchema(),
  char_end: integerSchema(),
});
const RagRowCitationPropertyOutput = objectSchema({
  id: idSchema,
  name: stringSchema(),
});
const RagRowCitationOutput = objectSchema({
  type: { const: 'row' },
  id: idSchema,
  workspace_id: idSchema,
  database_id: idSchema,
  database_name: stringSchema(),
  database_description: nullable(stringSchema()),
  title: stringSchema(),
  revision: integerSchema(1),
  updated_at: timestampSchema,
  properties: arraySchema(RagRowCitationPropertyOutput),
});
const RagChunkOutput = objectSchema({
  rank: integerSchema(1),
  score: numberSchema,
  text: stringSchema(),
  citation: {
    anyOf: [RagPageTitleCitationOutput, RagPageBlockCitationOutput, RagRowCitationOutput],
  },
});
const compactRagSourceProperties: ObjectProperties = {
  ref: compactReferenceSchema,
  title: stringSchema(),
  rev: integerSchema(1),
  updated: compactDateSchema,
};
const CompactRagPageSourceOutput = objectSchema(compactRagSourceProperties);
const CompactRagRowSourceOutput = objectSchema({
  ...compactRagSourceProperties,
  database_ref: compactReferenceSchema,
  database: stringSchema(),
});
const CompactRagPageTitleCitationOutput = objectSchema({
  source: integerSchema(),
  part: { const: 'title' },
});
const CompactRagPageBlockCitationOutput = objectSchema({
  source: integerSchema(),
  part: { const: 'block' },
  block_ref: compactReferenceSchema,
  block_rev: integerSchema(1),
  block_type: { enum: [...BLOCK_TYPES] },
  block_pos: integerSchema(),
  chars: {
    type: 'array',
    prefixItems: [integerSchema(), integerSchema()],
    minItems: 2,
    maxItems: 2,
  },
});
const CompactRagRowCitationOutput = objectSchema({
  source: integerSchema(),
  properties: arraySchema(objectSchema({
    ref: compactReferenceSchema,
    name: stringSchema(),
  })),
});
const CompactRagChunkOutput = objectSchema({
  rank: integerSchema(1),
  score: numberSchema,
  text: stringSchema(),
  citation: {
    anyOf: [
      CompactRagPageTitleCitationOutput,
      CompactRagPageBlockCitationOutput,
      CompactRagRowCitationOutput,
    ],
  },
});
const SearchResultOutput = {
  anyOf: [
    objectSchema({
      mode: { const: 'records' },
      format: { const: 'compact' },
      records: arraySchema(CompactSearchRecordOutput),
      truncated: booleanSchema,
    }),
    objectSchema({
      mode: { const: 'records' },
      format: { const: 'full' },
      records: arraySchema(SearchRecordOutput),
      truncated: booleanSchema,
    }),
    objectSchema({
      mode: { const: 'rag' },
      format: { const: 'compact' },
      sources: arraySchema({
        anyOf: [CompactRagPageSourceOutput, CompactRagRowSourceOutput],
      }),
      chunks: arraySchema(CompactRagChunkOutput),
      truncated: booleanSchema,
    }),
    objectSchema({
      mode: { const: 'rag' },
      format: { const: 'full' },
      chunks: arraySchema(RagChunkOutput),
      truncated: booleanSchema,
    }),
  ],
};

const ToolErrorOutput = objectSchema({
  code: {
    enum: [
      'CONFLICT',
      'DEPENDENCY_UNAVAILABLE',
      'INTERNAL',
      'INVALID_ARGUMENT',
      'INVALID_REFERENCE',
      'NOT_FOUND',
    ],
  },
  message: stringSchema(),
  retryable: booleanSchema,
});
const EmptyMetaOutput = objectSchema({});
const SearchMetaOutput = objectSchema({ limit: { type: 'integer', minimum: 1, maximum: 50 } });

function envelopeOutputSchema(
  actionResults: Record<string, JsonSchema>,
  actionMeta: Record<string, JsonSchema> = {}
): NonNullable<Tool['outputSchema']> {
  const actions = Object.keys(actionResults);
  const resultSchemas = [...new Set(Object.values(actionResults))];
  const metaSchemas = [...new Set(actions.map((action) => actionMeta[action] ?? EmptyMetaOutput))];
  const required = ['ok', 'action', 'result', 'error', 'meta'];
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      action: { enum: actions },
      result: { anyOf: [...resultSchemas, nullSchema] },
      error: { anyOf: [nullSchema, ToolErrorOutput] },
      meta: { anyOf: metaSchemas },
    },
    required,
    additionalProperties: false,
    oneOf: [
      ...actions.map((action) => ({
        title: `${action} success`,
        properties: {
          ok: { const: true },
          action: { const: action },
          result: actionResults[action],
          error: nullSchema,
          meta: actionMeta[action] ?? EmptyMetaOutput,
        },
        required,
      })),
      {
        title: 'tool error',
        properties: {
          ok: { const: false },
          action: { enum: actions },
          result: nullSchema,
          error: ToolErrorOutput,
          meta: EmptyMetaOutput,
        },
        required,
      },
    ],
  } as NonNullable<Tool['outputSchema']>;
}

export const CORE_TOOL_OUTPUT_SCHEMAS = {
  workspace: envelopeOutputSchema({
    create: WorkspaceOutput,
    list: paginatedOutput(WorkspaceOutput),
    get: WorkspaceWithCountsOutput,
    update: WorkspaceOutput,
    archive: WorkspaceOutput,
    restore: WorkspaceOutput,
  }),
  session: envelopeOutputSchema({
    start: SessionOutput,
    list: paginatedOutput(SessionOutput),
    resume: SessionResumeOutput,
    close: SessionOutput,
  }),
  page: envelopeOutputSchema({
    create: PageWithBlocksOutput,
    get: PageDetailsOutput,
    list: paginatedOutput(PageOutput),
    update: PageOutput,
    append: PageBlocksMutationOutput,
    block_update: PageBlockMutationOutput,
    archive: PageOutput,
    restore: PageOutput,
    block_archive: PageBlockMutationOutput,
    block_restore: PageBlockMutationOutput,
  }),
  database: envelopeOutputSchema({
    create: DatabaseWithPropertiesOutput,
    list: paginatedOutput(DatabaseOutput),
    get: DatabaseWithPropertiesOutput,
    update: DatabaseOutput,
    archive: DatabaseOutput,
    restore: DatabaseOutput,
    property_add: DatabasePropertyMutationOutput,
    property_update: DatabasePropertyMutationOutput,
    property_archive: DatabasePropertyMutationOutput,
    property_restore: DatabasePropertyMutationOutput,
  }),
  row: envelopeOutputSchema({
    create: RowOutput,
    get: RowOutput,
    query: paginatedOutput(RowOutput, true),
    update: RowOutput,
    archive: RowOutput,
    restore: RowOutput,
  }),
  link: envelopeOutputSchema({
    create: LinkOutput,
    list: paginatedOutput(LinkOutput),
    archive: LinkOutput,
    restore: LinkOutput,
  }),
  search: envelopeOutputSchema(
    { search: SearchResultOutput },
    { search: SearchMetaOutput }
  ),
  run: envelopeOutputSchema({
    start: RunDetailsOutput,
    get: RunDetailsOutput,
    list: paginatedOutput(RunOutput),
    checkpoint: RunCheckpointMutationOutput,
    finish: RunFinishMutationOutput,
  }),
} as const;
