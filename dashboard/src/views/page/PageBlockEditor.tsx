import { Icon } from '../../components/Icon';
import type { Block, BlockType } from '../../types';
import { AutoTextarea } from './AutoTextarea';

export const BLOCK_LABELS: Record<BlockType, string> = {
  callout: 'Callout',
  code: 'Code',
  heading: 'Heading',
  text: 'Text',
  todo: 'To-do',
};

export function PageBlockEditor({
  block,
  disabled,
  onArchive,
  onChange,
  onRestore,
  onSave,
  onToggleTodo,
}: {
  block: Block;
  disabled: boolean;
  onArchive(): void;
  onChange(value: string): void;
  onRestore(): void;
  onSave(): void;
  onToggleTodo(done: boolean): void;
}) {
  const archived = block.archived_at !== null;
  const done = block.metadata.done === true;
  const editor = (
    <AutoTextarea
      className="page-block__input"
      disabled={disabled || archived}
      label={`${BLOCK_LABELS[block.block_type]} block`}
      onBlur={onSave}
      onChange={onChange}
      placeholder={block.block_type === 'heading' ? 'Heading' : 'Write something…'}
      spellCheck={block.block_type !== 'code'}
      value={block.content}
    />
  );

  return (
    <article className={`page-block page-block--${block.block_type}${archived ? ' is-archived' : ''}`}>
      <div className="page-block__gutter" aria-hidden="true">
        <span>{block.position + 1}</span>
      </div>
      <div className="page-block__body">
        {block.block_type === 'todo' ? (
          <div className="page-block__todo">
            <input
              aria-label={done ? 'Mark to-do incomplete' : 'Mark to-do complete'}
              checked={done}
              disabled={disabled || archived}
              onChange={(event) => onToggleTodo(event.target.checked)}
              type="checkbox"
            />
            {editor}
          </div>
        ) : editor}
      </div>
      <div className="page-block__actions">
        <span className="page-block__kind">{BLOCK_LABELS[block.block_type]}</span>
        {archived ? (
          <button className="text-button" disabled={disabled} onClick={onRestore} type="button">
            Restore
          </button>
        ) : (
          <button
            aria-label={`Archive ${BLOCK_LABELS[block.block_type].toLowerCase()} block`}
            className="icon-button page-block__archive"
            disabled={disabled}
            onClick={onArchive}
            type="button"
          >
            <Icon name="archive" size={16} />
          </button>
        )}
      </div>
    </article>
  );
}
