import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import type { RevisionState } from '../../components/RevisionRing';
import type { DatabaseProperty, DatabaseWithProperties } from '../../types';
import { PropertyEditor } from './controls/PropertyControls';

export function DatabaseSchemaDialog({
  database,
  onAddProperty,
  onArchive,
  onClose,
  onRestore,
  onSave,
  saveState,
}: {
  database: DatabaseWithProperties;
  onAddProperty(): void;
  onArchive(property: DatabaseProperty): void;
  onClose(): void;
  onRestore(property: DatabaseProperty): void;
  onSave(property: DatabaseProperty, update: { name?: string; options?: { choices: string[] } }): void;
  saveState: RevisionState;
}) {
  const archived = database.archived_at !== null;
  const activePropertyCount = database.properties.filter((property) => !property.archived_at).length;

  return (
    <Modal
      description="Property types stay fixed so every agent sees a stable schema. Names and select choices can evolve."
      onClose={onClose}
      title="Database schema"
    >
      <div className="schema-dialog">
        <div className="schema-dialog__heading">
          <span>{activePropertyCount} active properties</span>
          {!archived ? (
            <button
              className="button button--primary"
              disabled={activePropertyCount >= 100}
              onClick={onAddProperty}
              type="button"
            >
              <Icon name="plus" size={16} /> Add property
            </button>
          ) : null}
        </div>
        <div className="property-list">
          {database.properties.map((property) => (
            <PropertyEditor
              disabled={archived || saveState === 'saving'}
              key={property.id}
              onArchive={() => onArchive(property)}
              onRestore={() => onRestore(property)}
              onSave={(update) => onSave(property, update)}
              property={property}
            />
          ))}
        </div>
      </div>
    </Modal>
  );
}
