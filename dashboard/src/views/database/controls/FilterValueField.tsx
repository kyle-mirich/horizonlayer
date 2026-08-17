import type { DatabaseProperty } from '../../../types';

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
        {property.options.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
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
