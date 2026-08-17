import type { DatabaseProperty } from '../../../types';
import { choicesFrom } from './DatabaseControlUtils';

export function DraftValueField({
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
