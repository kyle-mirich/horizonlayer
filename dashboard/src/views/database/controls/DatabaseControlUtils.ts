import type {
  DatabaseProperty,
  DatabaseRow,
  JsonObject,
  JsonValue,
  PropertyType,
  RowFilter,
} from '../../../types';

export const PROPERTY_LABELS: Record<PropertyType, string> = {
  checkbox: 'Checkbox',
  date: 'Date',
  multi_select: 'Multi-select',
  number: 'Number',
  select: 'Select',
  text: 'Text',
  title: 'Title',
  url: 'URL',
};

export const PROPERTY_TYPES: PropertyType[] = [
  'text',
  'number',
  'date',
  'checkbox',
  'url',
  'select',
  'multi_select',
];

export type RowFormDraft = Record<string, boolean | string | string[]>;
export type SortDirection = 'asc' | 'desc';
export type FilterOperator = RowFilter['operator'];

export function uniqueTags(value: string): string[] {
  return [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))];
}

export function choicesFrom(value: string): string[] {
  const choices: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.split(',')) {
    const choice = candidate.trim();
    const normalized = choice.toLocaleLowerCase();
    if (!choice || seen.has(normalized)) continue;
    seen.add(normalized);
    choices.push(choice);
  }
  return choices;
}

export function titleProperty(properties: DatabaseProperty[]): DatabaseProperty | undefined {
  return properties.find((property) => property.property_type === 'title' && !property.archived_at);
}

export function titleForRow(row: DatabaseRow, properties: DatabaseProperty[]): string {
  const property = titleProperty(properties);
  const title = property ? row.values[property.name] : null;
  return typeof title === 'string' && title.trim() ? title : 'Untitled record';
}

export function dateInputValue(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

export function textInputValue(value: JsonValue | undefined): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function multiValue(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function cellDraftValue(propertyType: PropertyType, value: JsonValue | undefined): string {
  if (propertyType === 'multi_select') return multiValue(value).join(', ');
  if (propertyType === 'date') return dateInputValue(value);
  return textInputValue(value);
}

export function sameJsonValue(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}

export function emptyRowDraft(properties: DatabaseProperty[]): RowFormDraft {
  return Object.fromEntries(properties.filter((property) => !property.archived_at).map((property) => [
    property.name,
    property.property_type === 'checkbox'
      ? false
      : property.property_type === 'multi_select'
        ? []
        : '',
  ]));
}

export function rowDraft(properties: DatabaseProperty[], row: DatabaseRow): RowFormDraft {
  return Object.fromEntries(properties.filter((property) => !property.archived_at).map((property) => {
    const value = row.values[property.name];
    if (property.property_type === 'checkbox') {
      return [property.name, value === true];
    }
    if (property.property_type === 'multi_select') {
      return [property.name, multiValue(value)];
    }
    return [property.name, cellDraftValue(property.property_type, value)];
  }));
}

export function valuesFromDraft(
  properties: DatabaseProperty[],
  draft: RowFormDraft,
): JsonObject {
  const values: JsonObject = {};
  for (const property of properties.filter((item) => !item.archived_at)) {
    const draftValue = draft[property.name];
    switch (property.property_type) {
      case 'title':
        values[property.name] = typeof draftValue === 'string' ? draftValue.trim() : '';
        break;
      case 'number':
        if (draftValue === '') values[property.name] = null;
        else if (typeof draftValue === 'string') values[property.name] = Number(draftValue);
        break;
      case 'checkbox':
        values[property.name] = draftValue === true;
        break;
      case 'multi_select':
        values[property.name] = Array.isArray(draftValue) ? draftValue : [];
        break;
      case 'date':
      case 'select':
      case 'text':
      case 'url':
        values[property.name] = typeof draftValue === 'string' && draftValue !== ''
          ? draftValue
          : null;
        break;
    }
  }
  return values;
}

export function filterOperators(property: DatabaseProperty | undefined): FilterOperator[] {
  if (!property) return [];
  switch (property.property_type) {
    case 'number':
    case 'date':
      return ['eq', 'neq', 'gt', 'lt', 'is_empty'];
    case 'checkbox':
    case 'select':
      return ['eq', 'neq', 'is_empty'];
    case 'multi_select':
      return ['contains', 'is_empty'];
    case 'text':
    case 'title':
    case 'url':
      return ['contains', 'eq', 'neq', 'is_empty'];
  }
}

export function operatorLabel(operator: FilterOperator): string {
  switch (operator) {
    case 'contains': return 'contains';
    case 'eq': return 'is';
    case 'neq': return 'is not';
    case 'gt': return 'is greater than';
    case 'lt': return 'is less than';
    case 'is_empty': return 'is empty';
  }
}

export function propertyGlyph(type: PropertyType): string {
  switch (type) {
    case 'title': return 'Aa';
    case 'text': return 'T';
    case 'number': return '#';
    case 'date': return '◷';
    case 'checkbox': return '✓';
    case 'url': return '↗';
    case 'select': return '◆';
    case 'multi_select': return '✣';
  }
}
