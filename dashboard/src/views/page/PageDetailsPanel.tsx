import type { ChangeEvent } from 'react';

export function PageDetailsPanel({
  archived,
  importance,
  onChangeImportance,
  onChangeTags,
  onSave,
  tags,
}: {
  archived: boolean;
  importance: number;
  onChangeImportance(value: number): void;
  onChangeTags(value: string): void;
  onSave(): void;
  tags: string;
}) {
  return (
    <section className="page-properties" aria-label="Page details" id="page-details">
      <label>
        <span>Tags</span>
        <input
          disabled={archived}
          onChange={(event) => onChangeTags(event.target.value)}
          placeholder="research, architecture"
          value={tags}
        />
        <small>Separate tags with commas.</small>
      </label>
      <label>
        <span>Importance · {importance.toFixed(1)}</span>
        <input
          disabled={archived}
          max="1"
          min="0"
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChangeImportance(event.target.valueAsNumber)}
          step="0.1"
          type="range"
          value={importance}
        />
        <small>Higher importance gently improves retrieval order.</small>
      </label>
      {!archived ? (
        <button className="button button--primary" onClick={onSave} type="button">
          Save details
        </button>
      ) : null}
    </section>
  );
}
