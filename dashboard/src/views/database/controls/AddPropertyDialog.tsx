import { useState } from 'react';

import { Modal } from '../../../components/Modal';
import type { DatabasePropertyInput, PropertyType } from '../../../types';
import { choicesFrom, PROPERTY_LABELS, PROPERTY_TYPES } from './DatabaseControlUtils';
import { FieldLabel } from './FieldLabel';

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
