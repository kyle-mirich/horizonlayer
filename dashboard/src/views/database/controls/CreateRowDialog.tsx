import { useState, type ChangeEvent } from 'react';

import { Modal } from '../../../components/Modal';
import type { DatabaseProperty, JsonObject } from '../../../types';
import {
  emptyRowDraft,
  PROPERTY_LABELS,
  titleProperty,
  uniqueTags,
  valuesFromDraft,
  type RowFormDraft,
} from './DatabaseControlUtils';
import { DraftValueField } from './DraftValueField';
import { FieldLabel } from './FieldLabel';

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
