export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type BlockType = 'text' | 'heading' | 'todo' | 'callout' | 'code';
export type PropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'select'
  | 'multi_select'
  | 'url';

export type ToolErrorCode =
  | 'CONFLICT'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL'
  | 'INVALID_ARGUMENT'
  | 'INVALID_REFERENCE'
  | 'NOT_FOUND';

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
}

export interface ToolSuccessEnvelope<
  Action extends string,
  Result,
  Meta extends Record<string, unknown> = Record<string, never>,
> {
  ok: true;
  action: Action;
  result: Result;
  error: null;
  meta: Meta;
}

export interface ToolFailureEnvelope<Action extends string = string> {
  ok: false;
  action: Action;
  result: null;
  error: ToolError;
  meta: Record<string, unknown>;
}

export interface PageInfo {
  has_more: boolean;
  limit: number;
  next_offset: number | null;
  offset: number;
}

export interface Paginated<Result> {
  items: Result[];
  page: PageInfo;
}

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceWithCounts extends Workspace {
  page_count: number;
  database_count: number;
  session_count: number;
}

export interface Block {
  id: string;
  page_id: string;
  block_type: BlockType;
  content: string;
  position: number;
  metadata: JsonObject;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Page {
  id: string;
  workspace_id: string;
  session_id: string | null;
  parent_page_id: string | null;
  title: string;
  tags: string[];
  importance: number;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PageWithBlocks extends Page {
  blocks: Block[];
}

export interface PageDetails extends PageWithBlocks {
  blocks_page: PageInfo;
}

export interface PageBlocksMutation {
  blocks: Block[];
  page_revision: number;
}

export interface PageBlockMutation {
  block: Block;
  page_revision: number;
}

export interface PropertyOptions {
  choices?: string[];
}

export interface DatabaseProperty {
  id: string;
  database_id: string;
  name: string;
  property_type: PropertyType;
  options: PropertyOptions;
  position: number;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Database {
  id: string;
  workspace_id: string;
  parent_page_id: string | null;
  name: string;
  description: string | null;
  tags: string[];
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DatabaseWithProperties extends Database {
  properties: DatabaseProperty[];
}

export interface DatabasePropertyMutation {
  property: DatabaseProperty;
  database_revision: number;
}

export interface DatabaseRow {
  id: string;
  database_id: string;
  tags: string[];
  importance: number;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  values: JsonObject;
}

export interface SearchRecord {
  id: string;
  type: 'page' | 'row';
  title: string;
  score: number;
  snippet: string;
  workspace_id: string;
  session_id: string | null;
  parent_page_id: string | null;
  database_id: string | null;
  tags: string[];
  importance: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface RagPageTitleCitation {
  type: 'page';
  part: 'title';
  id: string;
  workspace_id: string;
  title: string;
  revision: number;
  updated_at: string;
}

export interface RagPageBlockCitation {
  type: 'page';
  part: 'block';
  id: string;
  workspace_id: string;
  title: string;
  revision: number;
  updated_at: string;
  block_id: string;
  block_revision: number;
  block_type: BlockType;
  block_position: number;
  char_start: number;
  char_end: number;
}

export interface RagRowCitation {
  type: 'row';
  id: string;
  workspace_id: string;
  database_id: string;
  database_name: string;
  database_description: string | null;
  title: string;
  revision: number;
  updated_at: string;
  properties: Array<{ id: string; name: string }>;
}

export type RagCitation = RagPageTitleCitation | RagPageBlockCitation | RagRowCitation;

export interface RagChunk {
  rank: number;
  score: number;
  text: string;
  citation: RagCitation;
}

export interface SearchRecordsResult {
  mode: 'records';
  records: SearchRecord[];
  truncated: boolean;
}

export interface SearchRagResult {
  mode: 'rag';
  chunks: RagChunk[];
  truncated: boolean;
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
  tools: DashboardToolName[];
  version: string;
}

type AtLeastOne<Fields, Keys extends keyof Fields = keyof Fields> =
  Keys extends keyof Fields
    ? Required<Pick<Fields, Keys>> & Partial<Omit<Fields, Keys>>
    : never;

interface ListInput {
  include_archived?: boolean;
  limit?: number;
  offset?: number;
}

type WorkspaceUpdate = AtLeastOne<{
  name: string;
  description: string | null;
  icon: string | null;
}>;

export type WorkspaceInput =
  | {
      action: 'create';
      name: string;
      description?: string;
      icon?: string;
    }
  | ({ action: 'list' } & ListInput)
  | {
      action: 'get';
      workspace_id: string;
      include_archived?: boolean;
    }
  | ({
      action: 'update';
      workspace_id: string;
      revision: number;
    } & WorkspaceUpdate)
  | { action: 'archive'; workspace_id: string; revision: number }
  | { action: 'restore'; workspace_id: string; revision: number };

export interface BlockInput {
  block_type?: BlockType;
  content: string;
  metadata?: JsonObject;
}

type PageUpdate = AtLeastOne<{
  title: string;
  tags: string[];
  importance: number;
}>;

type BlockUpdate = AtLeastOne<{
  content: string;
  metadata: JsonObject;
}>;

export type PageInput =
  | {
      action: 'create';
      workspace_id: string;
      title: string;
      session_id?: string;
      parent_page_id?: string;
      tags?: string[];
      importance?: number;
      blocks?: BlockInput[];
    }
  | {
      action: 'get';
      page_id: string;
      session_id?: string;
      include_archived?: boolean;
      block_limit?: number;
      block_offset?: number;
    }
  | ({
      action: 'list';
      workspace_id: string;
      session_id?: string;
      parent_page_id?: string;
      tags?: string[];
      min_importance?: number;
    } & ListInput)
  | ({ action: 'update'; page_id: string; revision: number } & PageUpdate)
  | {
      action: 'append';
      page_id: string;
      revision: number;
      session_id?: string;
      blocks: BlockInput[];
    }
  | ({ action: 'block_update'; block_id: string; revision: number } & BlockUpdate)
  | { action: 'archive'; page_id: string; revision: number }
  | { action: 'restore'; page_id: string; revision: number }
  | { action: 'block_archive'; block_id: string; revision: number }
  | { action: 'block_restore'; block_id: string; revision: number };

export type DatabasePropertyInput =
  | {
      name: string;
      property_type: Exclude<PropertyType, 'select' | 'multi_select'>;
    }
  | {
      name: string;
      property_type: 'select' | 'multi_select';
      options?: { choices: string[] };
    };

type DatabaseUpdate = AtLeastOne<{
  name: string;
  description: string | null;
  tags: string[];
}>;

type DatabasePropertyUpdate = AtLeastOne<{
  name: string;
  options: { choices: string[] };
}>;

export type DatabaseInput =
  | {
      action: 'create';
      workspace_id: string;
      name: string;
      description?: string;
      parent_page_id?: string;
      tags?: string[];
      properties?: DatabasePropertyInput[];
    }
  | ({
      action: 'list';
      workspace_id: string;
      tags?: string[];
    } & ListInput)
  | { action: 'get'; database_id: string; include_archived?: boolean }
  | ({ action: 'update'; database_id: string; revision: number } & DatabaseUpdate)
  | { action: 'archive'; database_id: string; revision: number }
  | { action: 'restore'; database_id: string; revision: number }
  | {
      action: 'property_add';
      database_id: string;
      revision: number;
      property: DatabasePropertyInput;
    }
  | ({
      action: 'property_update';
      property_id: string;
      revision: number;
    } & DatabasePropertyUpdate)
  | { action: 'property_archive'; property_id: string; revision: number }
  | { action: 'property_restore'; property_id: string; revision: number };

export type RowFilter =
  | { property: string; operator: 'is_empty' }
  | {
      property: string;
      operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains';
      value: JsonValue;
    };

type RowUpdate = AtLeastOne<{
  values: JsonObject;
  tags: string[];
  importance: number;
}>;

interface RowQueryBase extends ListInput {
  action: 'query';
  database_id: string;
  filters?: RowFilter[];
  tags?: string[];
}

type RowQueryInput =
  | (RowQueryBase & { sort_by?: never; sort_direction?: never })
  | (RowQueryBase & { sort_by: string; sort_direction?: 'asc' | 'desc' });

export type RowInput =
  | {
      action: 'create';
      database_id: string;
      values: JsonObject;
      tags?: string[];
      importance?: number;
    }
  | { action: 'get'; row_id: string; include_archived?: boolean }
  | RowQueryInput
  | ({ action: 'update'; row_id: string; revision: number } & RowUpdate)
  | { action: 'archive'; row_id: string; revision: number }
  | { action: 'restore'; row_id: string; revision: number };

export type SearchScope =
  | {
      kind: 'workspace';
      workspace_id: string;
      types?: ['page'] | ['row'] | ['page', 'row'] | ['row', 'page'];
    }
  | { kind: 'session'; session_id: string }
  | { kind: 'database'; database_id: string };

interface SearchInputBase {
  query: string;
  scope: SearchScope;
  tags?: string[];
  min_importance?: number;
}

export type SearchInput =
  | (SearchInputBase & { mode: 'records'; limit?: number })
  | (SearchInputBase & { mode: 'rag'; limit?: number });

interface WorkspaceActionResults {
  create: Workspace;
  list: Paginated<Workspace>;
  get: WorkspaceWithCounts;
  update: Workspace;
  archive: Workspace;
  restore: Workspace;
}

interface PageActionResults {
  create: PageWithBlocks;
  get: PageDetails;
  list: Paginated<Page>;
  update: Page;
  append: PageBlocksMutation;
  block_update: PageBlockMutation;
  archive: Page;
  restore: Page;
  block_archive: PageBlockMutation;
  block_restore: PageBlockMutation;
}

interface DatabaseActionResults {
  create: DatabaseWithProperties;
  list: Paginated<Database>;
  get: DatabaseWithProperties;
  update: Database;
  archive: Database;
  restore: Database;
  property_add: DatabasePropertyMutation;
  property_update: DatabasePropertyMutation;
  property_archive: DatabasePropertyMutation;
  property_restore: DatabasePropertyMutation;
}

interface RowActionResults {
  create: DatabaseRow;
  get: DatabaseRow;
  query: Paginated<DatabaseRow> & { total: number };
  update: DatabaseRow;
  archive: DatabaseRow;
  restore: DatabaseRow;
}

type ActionSuccess<Input, Results> = Input extends { action: infer Action extends string }
  ? Action extends keyof Results
    ? ToolSuccessEnvelope<Action, Results[Action]>
    : never
  : never;

type ActionEnvelope<Input, Results> = Input extends { action: infer Action extends string }
  ? Action extends keyof Results
    ? ToolSuccessEnvelope<Action, Results[Action]> | ToolFailureEnvelope<Action>
    : never
  : never;

export type WorkspaceSuccess<Input extends WorkspaceInput = WorkspaceInput> =
  ActionSuccess<Input, WorkspaceActionResults>;
export type PageSuccess<Input extends PageInput = PageInput> = ActionSuccess<Input, PageActionResults>;
export type DatabaseSuccess<Input extends DatabaseInput = DatabaseInput> =
  ActionSuccess<Input, DatabaseActionResults>;
export type RowSuccess<Input extends RowInput = RowInput> = ActionSuccess<Input, RowActionResults>;

export type WorkspaceEnvelope = ActionEnvelope<WorkspaceInput, WorkspaceActionResults>;
export type PageEnvelope = ActionEnvelope<PageInput, PageActionResults>;
export type DatabaseEnvelope = ActionEnvelope<DatabaseInput, DatabaseActionResults>;
export type RowEnvelope = ActionEnvelope<RowInput, RowActionResults>;

type SearchSuccessForMode<Mode extends SearchInput['mode']> =
  Mode extends 'records'
    ? ToolSuccessEnvelope<'search', SearchRecordsResult, { limit: number }>
    : Mode extends 'rag'
      ? ToolSuccessEnvelope<'search', SearchRagResult, { limit: number }>
      : never;

export type SearchSuccess<Input extends SearchInput = SearchInput> =
  SearchSuccessForMode<Input['mode']>;

export type SearchEnvelope = SearchSuccess | ToolFailureEnvelope<'search'>;

export interface DashboardToolInputs {
  workspace: WorkspaceInput;
  page: PageInput;
  database: DatabaseInput;
  row: RowInput;
  search: SearchInput;
}

export type DashboardToolName = keyof DashboardToolInputs;
export type DashboardToolInput<Tool extends DashboardToolName> = DashboardToolInputs[Tool];

export type DashboardToolSuccess<
  Tool extends DashboardToolName,
  Input extends DashboardToolInput<Tool>,
> = Tool extends 'workspace'
  ? WorkspaceSuccess<Input & WorkspaceInput>
  : Tool extends 'page'
    ? PageSuccess<Input & PageInput>
    : Tool extends 'database'
      ? DatabaseSuccess<Input & DatabaseInput>
      : Tool extends 'row'
        ? RowSuccess<Input & RowInput>
        : Tool extends 'search'
          ? SearchSuccess<Input & SearchInput>
          : never;
