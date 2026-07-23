import {
  memo,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';

import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import type {
  DatabaseProperty,
  DatabasePropertyInput,
  DatabaseRow,
  DatabaseWithProperties,
  JsonObject,
  JsonValue,
  PropertyType,
  RowFilter,
} from '../types';

const PROPERTY_LABELS: Record<PropertyType, string> = {
  checkbox: 'Checkbox',
  date: 'Date',
  multi_select: 'Multi-select',
  number: 'Number',
  select: 'Select',
  text: 'Text',
  title: 'Title',
  url: 'URL',
};

const PROPERTY_TYPES: PropertyType[] = [
  'text',
  'number',
  'date',
  'checkbox',
  'url',
  'select',
  'multi_select',
];

type RowFormDraft = Record<string, boolean | string | string[]>;
export type SortDirection = 'asc' | 'desc';
export type FilterOperator = RowFilter['operator'];

function uniqueTags(value: string): string[] {
  return [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))];
}

function choicesFrom(value: string): string[] {
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

function titleProperty(properties: DatabaseProperty[]): DatabaseProperty | undefined {
  return properties.find((property) => property.property_type === 'title' && !property.archived_at);
}

export function titleForRow(row: DatabaseRow, properties: DatabaseProperty[]): string {
  const property = titleProperty(properties);
  const title = property ? row.values[property.name] : null;
  return typeof title === 'string' && title.trim() ? title : 'Untitled record';
}

function dateInputValue(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

function textInputValue(value: JsonValue | undefined): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function multiValue(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function cellDraftValue(propertyType: PropertyType, value: JsonValue | undefined): string {
  if (propertyType === 'multi_select') return multiValue(value).join(', ');
  if (propertyType === 'date') return dateInputValue(value);
  return textInputValue(value);
}

function sameJsonValue(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}

function emptyRowDraft(properties: DatabaseProperty[]): RowFormDraft {
  return Object.fromEntries(properties.filter((property) => !property.archived_at).map((property) => [
    property.name,
    property.property_type === 'checkbox'
      ? false
      : property.property_type === 'multi_select'
        ? []
        : '',
  ]));
}

function rowDraft(properties: DatabaseProperty[], row: DatabaseRow): RowFormDraft {
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

function valuesFromDraft(
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

function FieldLabel({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="database-field">
      <span>{label}</span>
      {children}
    </div>
  );
}

export const CellEditor = memo(function CellEditor({
  disabled,
  onCommit,
  property,
  rowLabel,
  value,
}: {
  disabled: boolean;
  onCommit(value: JsonValue): void;
  property: DatabaseProperty;
  rowLabel: string;
  value: JsonValue | undefined;
}) {
  const label = `${property.name} for ${rowLabel}`;
  const choices = property.options.choices ?? [];
  const choicesConfigured = property.options.choices !== undefined;
  const initialDraft = cellDraftValue(property.property_type, value);
  const [draft, setDraft] = useState(initialDraft);
  const draftRef = useRef(initialDraft);
  const dirtyRef = useRef(false);
  const submittedDraftRef = useRef<string | null>(null);

  useEffect(() => {
    const serverDraft = cellDraftValue(property.property_type, value);
    const submitted = submittedDraftRef.current;
    if (submitted !== null && serverDraft === submitted) {
      submittedDraftRef.current = null;
      if (draftRef.current !== submitted) return;
      dirtyRef.current = false;
      draftRef.current = serverDraft;
      setDraft(serverDraft);
      return;
    }
    if (dirtyRef.current) return;
    draftRef.current = serverDraft;
    setDraft(serverDraft);
  }, [property.property_type, value]);

  const submitDraft = (parsed: JsonValue) => {
    const submittedDraft = cellDraftValue(property.property_type, parsed);
    draftRef.current = submittedDraft;
    setDraft(submittedDraft);
    if (!sameJsonValue(value, parsed)) {
      dirtyRef.current = true;
      submittedDraftRef.current = submittedDraft;
      onCommit(parsed);
    } else {
      dirtyRef.current = false;
      submittedDraftRef.current = null;
    }
  };

  const commitText = (next: string) => {
    let parsed: JsonValue = next;
    if (property.property_type === 'title') {
      const normalized = next.trim();
      if (!normalized) {
        const restored = textInputValue(value);
        draftRef.current = restored;
        dirtyRef.current = false;
        submittedDraftRef.current = null;
        setDraft(restored);
        return;
      }
      parsed = normalized;
    } else if (property.property_type === 'number') {
      parsed = next === '' ? null : Number(next);
      if (typeof parsed === 'number' && !Number.isFinite(parsed)) return;
    } else if (next === '') {
      parsed = null;
    }
    submitDraft(parsed);
  };

  if (property.property_type === 'checkbox') {
    return (
      <label className="cell-checkbox" title={label}>
        <input
          aria-label={label}
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onCommit(event.target.checked)}
          type="checkbox"
        />
        <span aria-hidden="true"><Icon name="check" size={13} /></span>
      </label>
    );
  }

  if (property.property_type === 'select' && choicesConfigured) {
    return (
      <select
        aria-label={label}
        className="cell-input cell-input--select"
        disabled={disabled}
        onChange={(event) => onCommit(event.target.value || null)}
        value={typeof value === 'string' ? value : ''}
      >
        <option value="">None</option>
        {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
      </select>
    );
  }

  if (property.property_type === 'multi_select' && choicesConfigured) {
    const selected = multiValue(value);
    const remaining = choices.filter((choice) => !selected.includes(choice));
    return (
      <div className="cell-multi" aria-label={label} role="group">
        {selected.map((choice) => (
          <button
            aria-label={`Remove ${choice} from ${property.name}`}
            className="choice-chip"
            disabled={disabled}
            key={choice}
            onClick={() => onCommit(selected.filter((item) => item !== choice))}
            type="button"
          >
            {choice}<span aria-hidden="true">×</span>
          </button>
        ))}
        {remaining.length > 0 ? (
          <select
            aria-label={`Add ${property.name} choice for ${rowLabel}`}
            className="choice-adder"
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value) onCommit([...selected, event.target.value]);
              event.target.value = '';
            }}
            value=""
          >
            <option value="">＋</option>
            {remaining.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
          </select>
        ) : null}
      </div>
    );
  }

  const multiWithoutChoices = property.property_type === 'multi_select';
  return (
    <input
      aria-label={label}
      className={`cell-input cell-input--${property.property_type}`}
      disabled={disabled}
      inputMode={property.property_type === 'number' ? 'decimal' : undefined}
      onBlur={(event) => {
        if (multiWithoutChoices) {
          const parsed = choicesFrom(event.target.value);
          submitDraft(parsed);
        } else {
          commitText(event.target.value);
        }
      }}
      onChange={(event) => {
        dirtyRef.current = true;
        draftRef.current = event.target.value;
        setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.preventDefault();
          const restored = cellDraftValue(property.property_type, value);
          dirtyRef.current = false;
          submittedDraftRef.current = null;
          draftRef.current = restored;
          setDraft(restored);
        }
      }}
      placeholder={property.property_type === 'title' ? 'Untitled' : '—'}
      step={property.property_type === 'number' ? 'any' : undefined}
      type={property.property_type === 'number'
        ? 'number'
        : property.property_type === 'date'
          ? 'date'
          : property.property_type === 'url'
            ? 'url'
            : 'text'}
      value={draft}
    />
  );
}, (previous, next) => previous.disabled === next.disabled
  && previous.property.id === next.property.id
  && previous.property.revision === next.property.revision
  && previous.rowLabel === next.rowLabel
  && sameJsonValue(previous.value, next.value));

function DraftValueField({
  disabled,
  onChange,
  property,
  value,
}: {
  disabled?: boolean;
  onChange(value: boolean | string | string[]): void;
  property: DatabaseProperty;
  value: boolean | string | string[];
}) {
  const choices = property.options.choices ?? [];
  const choicesConfigured = property.options.choices !== undefined;
  if (property.property_type === 'checkbox') {
    return (
      <label className="form-checkbox">
        <input
          aria-label={property.name}
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <span>Checked</span>
      </label>
    );
  }
  if (property.property_type === 'multi_select' && choicesConfigured) {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div aria-label={property.name} className="choice-grid" role="group">
        {choices.map((choice) => (
          <label key={choice}>
            <input
              aria-label={`${property.name}: ${choice}`}
              checked={selected.includes(choice)}
              disabled={disabled}
              onChange={(event) => onChange(event.target.checked
                ? [...selected, choice]
                : selected.filter((item) => item !== choice))}
              type="checkbox"
            />
            <span>{choice}</span>
          </label>
        ))}
      </div>
    );
  }
  if (property.property_type === 'select' && choicesConfigured) {
    return (
      <select
        aria-label={property.name}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        value={typeof value === 'string' ? value : ''}
      >
        <option value="">None</option>
        {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
      </select>
    );
  }
  if (property.property_type === 'multi_select') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <input
        aria-label={property.name}
        disabled={disabled}
        onChange={(event) => onChange(choicesFrom(event.target.value))}
        placeholder="Choice one, choice two"
        type="text"
        value={selected.join(', ')}
      />
    );
  }
  return (
    <input
      aria-label={property.name}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      placeholder={property.property_type === 'title' ? 'Required' : undefined}
      step={property.property_type === 'number' ? 'any' : undefined}
      type={property.property_type === 'number'
        ? 'number'
        : property.property_type === 'date'
          ? 'date'
          : property.property_type === 'url'
            ? 'url'
            : 'text'}
      value={Array.isArray(value) ? value.join(', ') : String(value)}
    />
  );
}

export function PropertyEditor({
  disabled,
  onArchive,
  onRestore,
  onSave,
  property,
}: {
  disabled: boolean;
  onArchive(): void;
  onRestore(): void;
  onSave(update: { name?: string; options?: { choices: string[] } }): void;
  property: DatabaseProperty;
}) {
  const [name, setName] = useState(property.name);
  const [choices, setChoices] = useState((property.options.choices ?? []).join(', '));
  const archived = property.archived_at !== null;
  const choiceProperty = property.property_type === 'select' || property.property_type === 'multi_select';

  useEffect(() => {
    setName(property.name);
    setChoices((property.options.choices ?? []).join(', '));
  }, [property.name, property.options.choices, property.revision]);

  const normalizedName = name.trim();
  const parsedChoices = choicesFrom(choices);
  const optionsChanged = choiceProperty
    && JSON.stringify(parsedChoices) !== JSON.stringify(property.options.choices ?? []);
  const validChoices = !choiceProperty
    || (parsedChoices.length <= 100 && parsedChoices.every((choice) => choice.length <= 200));
  const changed = normalizedName !== property.name
    || optionsChanged;

  return (
    <article className={`property-editor${archived ? ' is-archived' : ''}`}>
      <span className={`property-glyph property-glyph--${property.property_type}`} aria-hidden="true">
        {propertyGlyph(property.property_type)}
      </span>
      <div className="property-editor__fields">
        <label>
          <span>Name</span>
          <input
            aria-label={`Name for ${property.name} property`}
            disabled={disabled || archived}
            maxLength={255}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        {choiceProperty ? (
          <label>
            <span>Choices</span>
            <input
              aria-label={`Choices for ${property.name} property`}
              disabled={disabled || archived}
              onChange={(event) => setChoices(event.target.value)}
              placeholder="Planned, Active, Done"
              value={choices}
            />
          </label>
        ) : null}
      </div>
      <span className="property-editor__type">{PROPERTY_LABELS[property.property_type]}</span>
      <div className="property-editor__actions">
        {!archived ? (
          <button
            className="text-button"
            disabled={disabled || !changed || !normalizedName || !validChoices}
            onClick={() => onSave({
              ...(normalizedName !== property.name ? { name: normalizedName } : {}),
              ...(optionsChanged ? { options: { choices: parsedChoices } } : {}),
            })}
            type="button"
          >
            Save
          </button>
        ) : null}
        {archived ? (
          <button className="text-button" disabled={disabled} onClick={onRestore} type="button">
            Restore
          </button>
        ) : property.property_type !== 'title' ? (
          <button
            aria-label={`Archive ${property.name} property`}
            className="icon-button"
            disabled={disabled}
            onClick={onArchive}
            type="button"
          >
            <Icon name="archive" size={16} />
          </button>
        ) : null}
      </div>
    </article>
  );
}
export function FilterValueField({
  onChange,
  property,
  value,
}: {
  onChange(value: string): void;
  property: DatabaseProperty | undefined;
  value: string;
}) {
  if (property?.property_type === 'checkbox') {
    return (
      <select aria-label="Filter value" onChange={(event) => onChange(event.target.value)} value={value || 'true'}>
        <option value="true">Checked</option>
        <option value="false">Unchecked</option>
      </select>
    );
  }
  if ((property?.property_type === 'select' || property?.property_type === 'multi_select')
    && property.options.choices !== undefined) {
    return (
      <select aria-label="Filter value" onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">Value</option>
        {property.options.choices?.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
      </select>
    );
  }
  return (
    <input
      aria-label="Filter value"
      onChange={(event) => onChange(event.target.value)}
      placeholder="Value"
      step={property?.property_type === 'number' ? 'any' : undefined}
      type={property?.property_type === 'number'
        ? 'number'
        : property?.property_type === 'date'
          ? 'date'
          : 'text'}
      value={value}
    />
  );
}

export function DatabaseDetailsDialog({
  database,
  disabled,
  onArchive,
  onClose,
  onSave,
}: {
  database: DatabaseWithProperties;
  disabled: boolean;
  onArchive(): void;
  onClose(): void;
  onSave(update: { name: string; description: string | null; tags: string[] }): void;
}) {
  const [name, setName] = useState(database.name);
  const [description, setDescription] = useState(database.description ?? '');
  const [tags, setTags] = useState(database.tags.join(', '));
  const parsedTags = uniqueTags(tags);
  const valid = name.trim().length > 0
    && parsedTags.length <= 50
    && parsedTags.every((tag) => tag.length <= 100);
  return (
    <Modal description="These details are visible to people and agents." onClose={onClose} title="Database details">
      <div className="dialog-form">
        <FieldLabel label="Name">
          <input aria-label="Name" disabled={disabled} maxLength={500} onChange={(event) => setName(event.target.value)} value={name} />
        </FieldLabel>
        <FieldLabel label="Description">
          <textarea
            aria-label="Description"
            disabled={disabled}
            maxLength={10_000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What belongs in this database?"
            rows={4}
            value={description}
          />
        </FieldLabel>
        <FieldLabel label="Tags">
          <input
            aria-label="Tags"
            disabled={disabled}
            onChange={(event) => setTags(event.target.value)}
            placeholder="product, research"
            value={tags}
          />
        </FieldLabel>
        <p className="field-note">Separate tags with commas.</p>
        <div className="dialog-form__danger">
          <button className="text-button text-button--danger" disabled={disabled} onClick={onArchive} type="button">
            Archive database
          </button>
        </div>
      </div>
      <div className="modal-actions">
        <button className="button" onClick={onClose} type="button">Cancel</button>
        <button
          className="button button--primary"
          disabled={disabled || !valid}
          onClick={() => onSave({
            description: description.trim() || null,
            name: name.trim(),
            tags: parsedTags,
          })}
          type="button"
        >
          Save details
        </button>
      </div>
    </Modal>
  );
}

export function AddPropertyDialog({
  disabled,
  onClose,
  onCreate,
}: {
  disabled: boolean;
  onClose(): void;
  onCreate(property: DatabasePropertyInput): void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<PropertyType>('text');
  const [choices, setChoices] = useState('');
  const needsChoices = type === 'select' || type === 'multi_select';
  const parsedChoices = choicesFrom(choices);
  const validChoices = !needsChoices
    || (parsedChoices.length > 0
      && parsedChoices.length <= 100
      && parsedChoices.every((choice) => choice.length <= 200));
  return (
    <Modal
      description="Choose the permanent value type. You can rename the property and revise select choices later."
      onClose={onClose}
      title="Add a property"
    >
      <div className="dialog-form dialog-form--compact">
        <FieldLabel label="Property name">
          <input aria-label="Property name" disabled={disabled} maxLength={255} onChange={(event) => setName(event.target.value)} value={name} />
        </FieldLabel>
        <FieldLabel label="Type">
          <select aria-label="Type" disabled={disabled} onChange={(event) => setType(event.target.value as PropertyType)} value={type}>
            {PROPERTY_TYPES.map((propertyType) => (
              <option key={propertyType} value={propertyType}>{PROPERTY_LABELS[propertyType]}</option>
            ))}
          </select>
        </FieldLabel>
        {needsChoices ? (
          <FieldLabel label="Choices">
            <input
              aria-label="Choices"
              disabled={disabled}
              onChange={(event) => setChoices(event.target.value)}
              placeholder="Planned, Active, Done"
              value={choices}
            />
          </FieldLabel>
        ) : null}
        {needsChoices ? <p className="field-note">Separate choices with commas. Matching is exact.</p> : null}
      </div>
      <div className="modal-actions">
        <button className="button" onClick={onClose} type="button">Cancel</button>
        <button
          className="button button--primary"
          disabled={disabled || !name.trim() || !validChoices}
          onClick={() => onCreate(needsChoices
            ? { name: name.trim(), property_type: type, options: { choices: parsedChoices } } as DatabasePropertyInput
            : { name: name.trim(), property_type: type } as DatabasePropertyInput)}
          type="button"
        >
          Add property
        </button>
      </div>
    </Modal>
  );
}

export function CreateRowDialog({
  disabled,
  onClose,
  onCreate,
  properties,
}: {
  disabled: boolean;
  onClose(): void;
  onCreate(values: JsonObject, tags: string[], importance: number): void;
  properties: DatabaseProperty[];
}) {
  const [draft, setDraft] = useState<RowFormDraft>(() => emptyRowDraft(properties));
  const [tags, setTags] = useState('');
  const [importance, setImportance] = useState(0.5);
  const title = titleProperty(properties);
  const titleValue = title ? draft[title.name] : '';
  const validTitle = typeof titleValue === 'string' && titleValue.trim().length > 0;
  const parsedTags = uniqueTags(tags);
  const validTags = parsedTags.length <= 50 && parsedTags.every((tag) => tag.length <= 100);
  return (
    <Modal description="Values are checked against the live database schema." onClose={onClose} title="New record">
      <div className="row-create-form">
        {properties.map((property) => (
          <FieldLabel key={property.id} label={`${property.name} · ${PROPERTY_LABELS[property.property_type]}`}>
            <DraftValueField
              disabled={disabled}
              onChange={(value) => setDraft((current) => ({ ...current, [property.name]: value }))}
              property={property}
              value={draft[property.name] ?? ''}
            />
          </FieldLabel>
        ))}
        <div className="row-create-form__meta">
          <FieldLabel label="Tags">
            <input aria-label="Tags" disabled={disabled} onChange={(event) => setTags(event.target.value)} placeholder="Comma separated" value={tags} />
          </FieldLabel>
          <FieldLabel label={`Importance · ${importance.toFixed(1)}`}>
            <input
              aria-label="Importance"
              disabled={disabled}
              max="1"
              min="0"
              onChange={(event: ChangeEvent<HTMLInputElement>) => setImportance(event.target.valueAsNumber)}
              step="0.1"
              type="range"
              value={importance}
            />
          </FieldLabel>
        </div>
      </div>
      <div className="modal-actions">
        <button className="button" onClick={onClose} type="button">Cancel</button>
        <button
          className="button button--primary"
          disabled={disabled || !validTitle || !validTags}
          onClick={() => onCreate(valuesFromDraft(properties, draft), parsedTags, importance)}
          type="button"
        >
          Create record
        </button>
      </div>
    </Modal>
  );
}

export function RowDetailsDialog({
  databaseArchived,
  disabled,
  onArchive,
  onClose,
  onRestore,
  onSaveDetails,
  properties,
  row,
}: {
  databaseArchived: boolean;
  disabled: boolean;
  onArchive(row: DatabaseRow): void;
  onClose(): void;
  onRestore(row: DatabaseRow): void;
  onSaveDetails(
    row: DatabaseRow,
    values: JsonObject,
    tags: string[],
    importance: number,
  ): void;
  properties: DatabaseProperty[];
  row: DatabaseRow | null;
}) {
  const [draft, setDraft] = useState<RowFormDraft>(() => row
    ? rowDraft(properties, row)
    : emptyRowDraft(properties));
  const [tags, setTags] = useState(row?.tags.join(', ') ?? '');
  const [importance, setImportance] = useState(row?.importance ?? 0.5);
  const detailsDirtyRef = useRef(false);
  const persistedTags = row?.tags.join('\u0000') ?? '';
  const persistedImportance = row?.importance ?? 0.5;
  const persistedRevision = row?.revision;
  const persistedSchema = properties.map((property) => `${property.id}:${property.revision}`).join('|');

  useEffect(() => {
    if (!row || persistedRevision === undefined || detailsDirtyRef.current) return;
    setDraft(rowDraft(properties, row));
    setTags(persistedTags.split('\u0000').filter(Boolean).join(', '));
    setImportance(persistedImportance);
  }, [persistedImportance, persistedRevision, persistedSchema, persistedTags, properties, row]);

  if (!row) {
    return (
      <Modal onClose={onClose} title="Opening record…">
        <div className="row-detail-loading" aria-busy="true"><span /><span /><span /></div>
      </Modal>
    );
  }

  const archived = row.archived_at !== null;
  const title = titleForRow(row, properties);
  const titleField = titleProperty(properties);
  const titleDraft = titleField ? draft[titleField.name] : '';
  const validTitle = typeof titleDraft === 'string' && titleDraft.trim().length > 0;
  const parsedTags = uniqueTags(tags);
  const validTags = parsedTags.length <= 50 && parsedTags.every((tag) => tag.length <= 100);
  return (
    <Modal description={`Revision ${row.revision} · Updated ${new Date(row.updated_at).toLocaleString()}`} onClose={onClose} title={title}>
      {archived ? (
        <div className="row-detail-banner">
          <span>This record is archived.</span>
          {!databaseArchived ? <button className="text-button" onClick={() => onRestore(row)} type="button">Restore</button> : null}
        </div>
      ) : null}
      <div className="row-detail-grid">
        {properties.map((property) => (
          <div className="row-detail-field" key={property.id}>
            <span>{property.name}<small>{PROPERTY_LABELS[property.property_type]}</small></span>
            <DraftValueField
              disabled={disabled || archived || databaseArchived || property.archived_at !== null}
              onChange={(value) => {
                detailsDirtyRef.current = true;
                setDraft((current) => ({ ...current, [property.name]: value }));
              }}
              property={property}
              value={draft[property.name] ?? ''}
            />
          </div>
        ))}
      </div>
      <div className="row-detail-meta">
        <FieldLabel label="Tags">
          <input
            aria-label="Tags"
            disabled={disabled || archived || databaseArchived}
            onChange={(event) => {
              detailsDirtyRef.current = true;
              setTags(event.target.value);
            }}
            placeholder="Comma separated"
            value={tags}
          />
        </FieldLabel>
        <FieldLabel label={`Importance · ${importance.toFixed(1)}`}>
          <input
            aria-label="Importance"
            disabled={disabled || archived || databaseArchived}
            max="1"
            min="0"
            onChange={(event) => {
              detailsDirtyRef.current = true;
              setImportance(event.target.valueAsNumber);
            }}
            step="0.1"
            type="range"
            value={importance}
          />
        </FieldLabel>
      </div>
      <div className="modal-actions modal-actions--spread">
        {!archived && !databaseArchived ? (
          <button className="text-button text-button--danger" disabled={disabled} onClick={() => onArchive(row)} type="button">
            Archive record
          </button>
        ) : <span />}
        <div>
          <button className="button" onClick={onClose} type="button">Close</button>
          {!archived && !databaseArchived ? (
            <button
              className="button button--primary"
              disabled={disabled || !validTags || !validTitle}
              onClick={() => {
                detailsDirtyRef.current = false;
                onSaveDetails(
                  row,
                  valuesFromDraft(properties, draft),
                  parsedTags,
                  importance,
                );
              }}
              type="button"
            >
              Save details
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
