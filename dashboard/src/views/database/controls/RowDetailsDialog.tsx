import { useEffect, useRef, useState } from 'react';

import { Modal } from '../../../components/Modal';
import type { DatabaseProperty, DatabaseRow, JsonObject } from '../../../types';
import {
  emptyRowDraft,
  PROPERTY_LABELS,
  rowDraft,
  titleForRow,
  titleProperty,
  uniqueTags,
  valuesFromDraft,
  type RowFormDraft,
} from './DatabaseControlUtils';
import { DraftValueField } from './DraftValueField';
import { FieldLabel } from './FieldLabel';

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
