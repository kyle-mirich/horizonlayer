import { useEffect, useState } from 'react';

import { Icon } from '../../../components/Icon';
import type { DatabaseProperty } from '../../../types';
import {
  choicesFrom,
  PROPERTY_LABELS,
  propertyGlyph,
} from './DatabaseControlUtils';

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
  const changed = normalizedName !== property.name || optionsChanged;

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
