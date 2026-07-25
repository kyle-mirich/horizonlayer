export const BLOCK_TYPES = ['text', 'heading', 'todo', 'callout', 'code'] as const;

export const PROPERTY_TYPES = [
  'title',
  'text',
  'number',
  'select',
  'multi_select',
  'date',
  'checkbox',
  'url',
] as const;
export type PropertyType = typeof PROPERTY_TYPES[number];

export function isPropertyType(value: string): value is PropertyType {
  return (PROPERTY_TYPES as readonly string[]).includes(value);
}

export const LINK_ITEM_TYPES = [
  'workspace',
  'page',
  'database',
  'row',
  'block',
  'issue_project',
  'issue',
] as const;
export type LinkItemType = typeof LINK_ITEM_TYPES[number];

export function isLinkItemType(value: string): value is LinkItemType {
  return (LINK_ITEM_TYPES as readonly string[]).includes(value);
}

export const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export type RunStatus = typeof RUN_STATUSES[number];

export type RunOutcome = 'completed' | 'failed' | 'cancelled';
