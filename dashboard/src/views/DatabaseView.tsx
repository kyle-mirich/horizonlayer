import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { RevisionRing } from '../components/RevisionRing';
import { useDashboard } from '../shell/DashboardContext';
import { DatabaseLedger } from './database/DatabaseLedger';
import { DatabaseSchemaDialog } from './database/DatabaseSchemaDialog';
import { AddPropertyDialog } from './database/controls/AddPropertyDialog';
import { CreateRowDialog } from './database/controls/CreateRowDialog';
import { DatabaseDetailsDialog } from './database/controls/DatabaseDetailsDialog';
import { RowDetailsDialog } from './database/controls/RowDetailsDialog';
import { useDatabaseEditor } from './database/useDatabaseEditor';
import './DatabaseView.css';

export function DatabaseView({ databaseId, rowId }: { databaseId: string; rowId?: string }) {
  const { navigate } = useDashboard();
  const editor = useDatabaseEditor(databaseId, rowId);

  if (editor.loading) {
    return (
      <main className="database-view database-view--loading" aria-busy="true" id="main-content">
        <div className="database-skeleton database-skeleton--crumb" />
        <div className="database-skeleton database-skeleton--title" />
        <div className="database-skeleton database-skeleton--table" />
      </main>
    );
  }

  if (!editor.database || editor.loadError) {
    return (
      <main className="database-view database-view--error" id="main-content">
        <div className="view-message">
          <span className="view-message__mark"><Icon name="warning" /></span>
          <p className="eyebrow">Database unavailable</p>
          <h1>We couldn’t open this database.</h1>
          <p>{editor.loadError ?? 'The database no longer exists.'}</p>
          <div className="view-message__actions">
            <button className="button button--primary" onClick={editor.reloadDatabase} type="button">
              <Icon name="refresh" /> Retry
            </button>
            <button className="button" onClick={() => navigate({ name: 'home' })} type="button">
              Back to workspace
            </button>
          </div>
        </div>
      </main>
    );
  }

  const database = editor.database;
  const archived = database.archived_at !== null;

  return (
    <main className="database-view" id="main-content">
      {archived ? (
        <div className="archive-banner database-archive-banner">
          <span>This database is archived and read-only.</span>
          <button className="text-button" onClick={editor.restoreDatabase} type="button">
            Restore database
          </button>
        </div>
      ) : null}

      <header className="database-view__header">
        <div className="database-view__breadcrumbs">
          <button className="breadcrumb-button" onClick={() => navigate({ name: 'home' })} type="button">
            Database
          </button>
          <span aria-hidden="true">/</span>
          <span>rev {database.revision}</span>
        </div>
        <div className="database-view__tools">
          <RevisionRing state={editor.saveState} />
          <button className="button button--quiet" onClick={() => editor.setSchemaOpen(true)} type="button">
            Schema
          </button>
          <button className="button button--quiet" onClick={() => editor.setDetailsOpen(true)} type="button">
            Details
          </button>
          {!archived ? (
            <button
              aria-label="Archive database"
              className="icon-button"
              onClick={() => editor.setArchivePrompt(true)}
              type="button"
            >
              <Icon name="archive" />
            </button>
          ) : null}
        </div>
      </header>

      <section className="database-intro">
        <div className="database-intro__mark" aria-hidden="true"><Icon name="database" size={20} /></div>
        <div className="database-intro__copy">
          <div className="database-intro__tags">
            {database.tags.length ? database.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>) : (
              <span>Structured knowledge</span>
            )}
          </div>
          <h1>{database.name}</h1>
          {database.description ? <p>{database.description}</p> : null}
        </div>
      </section>

      <DatabaseLedger
        activeProperties={editor.activeProperties}
        archived={archived}
        compactRows={editor.compactRows}
        database={database}
        databaseId={databaseId}
        editorEpoch={editor.editorEpoch}
        onCreateRow={() => editor.setCreateRowOpen(true)}
        rowEditor={editor.rowEditor}
        visibleProperties={editor.visibleProperties}
      />

      {editor.detailsOpen ? (
        <DatabaseDetailsDialog
          database={database}
          disabled={archived || editor.saveState === 'saving'}
          onArchive={editor.showArchivePromptFromDetails}
          onClose={() => editor.setDetailsOpen(false)}
          onSave={editor.saveDatabaseDetails}
        />
      ) : null}

      {editor.schemaOpen ? (
        <DatabaseSchemaDialog
          database={database}
          onAddProperty={editor.showAddProperty}
          onArchive={(property) => editor.setPropertyArchived(property, false)}
          onClose={() => editor.setSchemaOpen(false)}
          onRestore={(property) => editor.setPropertyArchived(property, true)}
          onSave={editor.updateProperty}
          saveState={editor.saveState}
        />
      ) : null}

      {editor.addPropertyOpen ? (
        <AddPropertyDialog
          disabled={editor.saveState === 'saving'}
          onClose={() => editor.setAddPropertyOpen(false)}
          onCreate={editor.addProperty}
        />
      ) : null}

      {editor.createRowOpen ? (
        <CreateRowDialog
          disabled={editor.saveState === 'saving'}
          onClose={() => editor.setCreateRowOpen(false)}
          onCreate={editor.createRow}
          properties={editor.activeProperties}
        />
      ) : null}

      {rowId ? (
        <RowDetailsDialog
          databaseArchived={archived}
          disabled={editor.saveState === 'saving'}
          key={`row-details-${editor.rowEditor.selectedRow?.id ?? 'loading'}`}
          onArchive={(row) => editor.rowEditor.setRowArchived(row, false)}
          onClose={() => navigate({ name: 'database', databaseId })}
          onRestore={(row) => editor.rowEditor.setRowArchived(row, true)}
          onSaveDetails={editor.rowEditor.updateRowDetails}
          properties={editor.visibleProperties}
          row={editor.rowEditor.selectedRow}
        />
      ) : null}

      {editor.archivePrompt ? (
        <Modal
          description="Normal reads and search will stop returning it. You can restore it from Archive."
          onClose={() => editor.setArchivePrompt(false)}
          title="Archive this database?"
        >
          <div className="modal-actions">
            <button className="button" onClick={() => editor.setArchivePrompt(false)} type="button">Keep database</button>
            <button className="button button--danger" onClick={editor.archiveDatabase} type="button">
              Archive database
            </button>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}
