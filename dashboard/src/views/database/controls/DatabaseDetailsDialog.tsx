import { useState } from 'react';

import { Modal } from '../../../components/Modal';
import type { DatabaseWithProperties } from '../../../types';
import { uniqueTags } from './DatabaseControlUtils';
import { FieldLabel } from './FieldLabel';

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
