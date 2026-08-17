import { useState, type FormEvent } from 'react';

import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import type { Workspace } from '../types';

export interface WorkspaceDraft {
  description: string;
  icon: string;
  name: string;
}

interface WorkspaceDialogProps {
  currentWorkspaceId: string | null;
  onArchive(workspace: Workspace): Promise<void>;
  onClose(): void;
  onCreate(draft: WorkspaceDraft): Promise<void>;
  onRestore(workspace: Workspace): Promise<void>;
  onSelect(workspace: Workspace): void;
  onUpdate(workspace: Workspace, draft: WorkspaceDraft): Promise<void>;
  workspaces: Workspace[];
}

function workspaceMark(workspace: Pick<Workspace, 'icon' | 'name'>) {
  return workspace.icon?.trim() || workspace.name.trim().slice(0, 1).toUpperCase() || 'H';
}

function WorkspaceForm({
  initial,
  onCancel,
  onSave,
  submitLabel,
}: {
  initial?: WorkspaceDraft;
  onCancel?: () => void;
  onSave(draft: WorkspaceDraft): Promise<void>;
  submitLabel: string;
}) {
  const [draft, setDraft] = useState<WorkspaceDraft>(initial ?? {
    description: '',
    icon: '',
    name: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim() || saving) return;
    setError(null);
    setSaving(true);
    try {
      await onSave({
        description: draft.description.trim(),
        icon: draft.icon.trim(),
        name: draft.name.trim(),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Workspace changes could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="workspace-form" onSubmit={submit}>
      <label className="field field--icon">
        <span>Icon</span>
        <input
          aria-label="Workspace icon"
          autoComplete="off"
          maxLength={100}
          onChange={(event) => setDraft((value) => ({ ...value, icon: event.target.value }))}
          placeholder="◌"
          value={draft.icon}
        />
      </label>
      <label className="field field--workspace-name">
        <span>Name</span>
        <input
          autoComplete="off"
          maxLength={500}
          onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
          placeholder="My workspace"
          required
          value={draft.name}
        />
      </label>
      <label className="field field--wide">
        <span>Description <small>Optional</small></span>
        <textarea
          maxLength={10_000}
          onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))}
          placeholder="What belongs here?"
          rows={3}
          value={draft.description}
        />
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="modal-actions field--wide">
        {onCancel ? <button className="button button--quiet" onClick={onCancel} type="button">Cancel</button> : null}
        <button className="button button--primary" disabled={saving || !draft.name.trim()} type="submit">
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

export function WorkspaceDialog(props: WorkspaceDialogProps) {
  const [view, setView] = useState<'create' | 'list' | 'edit'>('list');
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = props.workspaces.filter((workspace) => workspace.archived_at === null);
  const archived = props.workspaces.filter((workspace) => workspace.archived_at !== null);

  const title = view === 'create' ? 'New workspace' : view === 'edit' ? 'Workspace details' : 'Workspaces';
  const description = view === 'list'
    ? 'Separate areas for different bodies of knowledge.'
    : view === 'create'
      ? 'Give this knowledge space a clear name.'
      : 'Change how this workspace appears to people.';

  async function act(id: string, action: () => Promise<void>) {
    if (pendingId) return;
    setError(null);
    setPendingId(id);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That workspace could not be changed.');
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Modal description={description} onClose={props.onClose} title={title}>
      {view === 'create' ? (
        <WorkspaceForm
          onCancel={() => setView('list')}
          onSave={async (draft) => {
            await props.onCreate(draft);
            props.onClose();
          }}
          submitLabel="Create workspace"
        />
      ) : null}
      {view === 'edit' && editing ? (
        <WorkspaceForm
          initial={{
            description: editing.description ?? '',
            icon: editing.icon ?? '',
            name: editing.name,
          }}
          onCancel={() => {
            setEditing(null);
            setView('list');
          }}
          onSave={async (draft) => {
            await props.onUpdate(editing, draft);
            setEditing(null);
            setView('list');
          }}
          submitLabel="Save changes"
        />
      ) : null}
      {view === 'list' ? (
        <div className="workspace-manager">
          <div className="workspace-manager__list" role="list">
            {active.map((workspace) => {
              const current = workspace.id === props.currentWorkspaceId;
              return (
                <div className={`workspace-row${current ? ' workspace-row--current' : ''}`} key={workspace.id} role="listitem">
                  <button
                    className="workspace-row__select"
                    disabled={pendingId !== null}
                    onClick={() => props.onSelect(workspace)}
                    type="button"
                  >
                    <span className="workspace-mark" aria-hidden="true">{workspaceMark(workspace)}</span>
                    <span>
                      <strong>{workspace.name}</strong>
                      <small>{workspace.description || (current ? 'Current workspace' : 'Switch workspace')}</small>
                    </span>
                    {current ? <Icon name="check" size={16} /> : null}
                  </button>
                  <div className="workspace-row__actions">
                    <button
                      className="text-button"
                      disabled={pendingId !== null}
                      onClick={() => {
                        setEditing(workspace);
                        setView('edit');
                      }}
                      type="button"
                    >Edit</button>
                    <button
                      className="text-button text-button--danger"
                      disabled={pendingId !== null}
                      onClick={() => void act(workspace.id, () => props.onArchive(workspace))}
                      type="button"
                    >{pendingId === workspace.id ? 'Archiving…' : 'Archive'}</button>
                  </div>
                </div>
              );
            })}
          </div>
          {archived.length > 0 ? (
            <section className="workspace-manager__archived">
              <h3>Archived</h3>
              {archived.map((workspace) => (
                <div className="workspace-row workspace-row--archived" key={workspace.id}>
                  <span className="workspace-mark" aria-hidden="true">{workspaceMark(workspace)}</span>
                  <span className="workspace-row__copy">
                    <strong>{workspace.name}</strong>
                    <small>Kept safely out of the sidebar</small>
                  </span>
                  <button
                    className="button button--quiet button--small"
                    disabled={pendingId !== null}
                    onClick={() => void act(workspace.id, async () => {
                      await props.onRestore(workspace);
                      props.onClose();
                    })}
                    type="button"
                  >{pendingId === workspace.id ? 'Restoring…' : 'Restore'}</button>
                </div>
              ))}
            </section>
          ) : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="workspace-manager__footer">
            <button className="button button--primary" onClick={() => setView('create')} type="button">
              <Icon name="plus" size={16} /> New workspace
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

export function Onboarding({
  archivedCount,
  onCreate,
  onOpenWorkspaces,
}: {
  archivedCount: number;
  onCreate(draft: WorkspaceDraft): Promise<void>;
  onOpenWorkspaces(): void;
}) {
  return (
    <main className="onboarding-shell">
      <section className="onboarding" aria-labelledby="onboarding-title">
        <div className="brand-mark brand-mark--large" aria-hidden="true"><i /><i /><i /></div>
        <p className="eyebrow">HorizonLayer</p>
        <h1 id="onboarding-title">Make a place for shared knowledge.</h1>
        <p className="onboarding__intro">Pages and structured records live here. Your agents use the same data through MCP.</p>
        <WorkspaceForm
          onSave={onCreate}
          submitLabel="Create workspace"
        />
        {archivedCount > 0 ? (
          <button className="text-button onboarding__restore" onClick={onOpenWorkspaces} type="button">
            Restore an archived workspace
          </button>
        ) : null}
      </section>
    </main>
  );
}

export { workspaceMark };
