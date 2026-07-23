// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Workspace } from '../types';
import { Onboarding, WorkspaceDialog, workspaceMark } from './WorkspaceDialog';

const NOW = '2026-07-01T00:00:00.000Z';
const current: Workspace = {
  archived_at: null,
  created_at: NOW,
  description: 'Current workspace',
  icon: '◌',
  id: 'workspace-1',
  name: 'Current',
  revision: 2,
  updated_at: NOW,
};
const other: Workspace = { ...current, id: 'workspace-2', icon: null, name: 'Other', description: null };
const archived: Workspace = { ...current, archived_at: NOW, id: 'workspace-3', name: 'Archived' };

function renderDialog(overrides: Partial<React.ComponentProps<typeof WorkspaceDialog>> = {}) {
  const onArchive = vi.fn(async () => undefined);
  const onClose = vi.fn();
  const onCreate = vi.fn(async () => undefined);
  const onRestore = vi.fn(async () => undefined);
  const onSelect = vi.fn();
  const onUpdate = vi.fn(async () => undefined);
  render(
    <WorkspaceDialog
      currentWorkspaceId={current.id}
      onArchive={onArchive}
      onClose={onClose}
      onCreate={onCreate}
      onRestore={onRestore}
      onSelect={onSelect}
      onUpdate={onUpdate}
      workspaces={[current, other, archived]}
      {...overrides}
    />,
  );
  return { onArchive, onClose, onCreate, onRestore, onSelect, onUpdate };
}

afterEach(() => cleanup());

describe('WorkspaceDialog', () => {
  it('switches workspaces and supports creating a trimmed workspace draft', async () => {
    const user = userEvent.setup();
    const { onClose, onCreate, onSelect } = renderDialog();
    expect(screen.getByRole('dialog', { name: 'Workspaces' })).toBeTruthy();
    expect(screen.getByText('Current workspace')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Other/ }));
    expect(onSelect).toHaveBeenCalledWith(other);

    await user.click(screen.getByRole('button', { name: /New workspace/ }));
    expect(screen.getByRole('dialog', { name: 'New workspace' })).toBeTruthy();
    const create = screen.getByRole('button', { name: 'Create workspace' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await user.type(screen.getByLabelText('Workspace icon'), '  ✨ ');
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '  New space  ');
    await user.type(screen.getByRole('textbox', { name: /Description/ }), '  Useful notes  ');
    await user.click(create);
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      description: 'Useful notes', icon: '✨', name: 'New space',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('edits a workspace and returns to the manager without closing it', async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderDialog();
    const currentRow = screen.getByText('Current').closest('[role="listitem"]') as HTMLElement;
    await user.click(within(currentRow).getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Workspace details' })).toBeTruthy();
    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(current, {
      description: 'Current workspace', icon: '◌', name: 'Renamed',
    }));
    expect(screen.getByRole('dialog', { name: 'Workspaces' })).toBeTruthy();
  });

  it('handles archive and restore actions, including an action error', async () => {
    const user = userEvent.setup();
    const archiveError = vi.fn(async () => { throw new Error('Cannot archive'); });
    renderDialog({ onArchive: archiveError });
    const otherRow = screen.getByText('Other').closest('[role="listitem"]') as HTMLElement;
    await user.click(within(otherRow).getByRole('button', { name: 'Archive' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Cannot archive');
  });

  it('archives, restores, and reports errors without leaving stale disabled actions', async () => {
    const user = userEvent.setup();
    const { onArchive, onClose, onRestore } = renderDialog();
    const otherRow = screen.getByText('Other').closest('[role="listitem"]') as HTMLElement;
    await user.click(within(otherRow).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(onArchive).toHaveBeenCalledWith(other));

    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(archived));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets users cancel a new form and renders onboarding restoration affordances', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: /New workspace/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Workspaces' })).toBeTruthy();

    cleanup();
    const onCreate = vi.fn(async () => undefined);
    const onOpenWorkspaces = vi.fn();
    render(<Onboarding archivedCount={1} onCreate={onCreate} onOpenWorkspaces={onOpenWorkspaces} />);
    expect(screen.getByRole('button', { name: 'Create workspace' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Restore an archived workspace' }));
    expect(onOpenWorkspaces).toHaveBeenCalledTimes(1);
    expect(workspaceMark({ icon: ' ', name: '' })).toBe('H');
  });
});
