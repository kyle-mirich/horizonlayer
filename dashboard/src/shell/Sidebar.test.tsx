// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database, Page, Workspace } from '../types';
import { Sidebar } from './Sidebar';

const NOW = '2026-07-01T00:00:00.000Z';
const workspace: Workspace = {
  archived_at: null,
  created_at: NOW,
  description: null,
  icon: null,
  id: 'workspace-1',
  name: 'Research',
  revision: 1,
  updated_at: NOW,
};
const page: Page = {
  archived_at: null,
  created_at: NOW,
  id: 'page / 1',
  importance: 0.5,
  parent_page_id: null,
  revision: 1,
  session_id: null,
  tags: [],
  title: 'Page one',
  updated_at: NOW,
  workspace_id: workspace.id,
};
const database: Database = {
  archived_at: null,
  created_at: NOW,
  description: null,
  id: 'database / 1',
  name: 'Database one',
  parent_page_id: null,
  revision: 1,
  tags: [],
  updated_at: NOW,
  workspace_id: workspace.id,
};

function renderSidebar(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const onCloseDrawer = vi.fn();
  const onCreateDatabase = vi.fn(async () => undefined);
  const onCreatePage = vi.fn(async () => undefined);
  const onOpenSearch = vi.fn();
  const onOpenStatus = vi.fn();
  const onOpenWorkspaces = vi.fn();
  render(
    <Sidebar
      creating={null}
      databases={[database]}
      drawerOpen={false}
      loading={false}
      onCloseDrawer={onCloseDrawer}
      onCreateDatabase={onCreateDatabase}
      onCreatePage={onCreatePage}
      onOpenSearch={onOpenSearch}
      onOpenStatus={onOpenStatus}
      onOpenWorkspaces={onOpenWorkspaces}
      pages={[page]}
      route={{ name: 'page', pageId: page.id }}
      workspace={workspace}
      {...overrides}
    />,
  );
  return { onCloseDrawer, onCreateDatabase, onCreatePage, onOpenSearch, onOpenStatus, onOpenWorkspaces };
}

afterEach(() => {
  cleanup();
  document.body.classList.remove('drawer-open');
});

describe('Sidebar', () => {
  it('renders active links and sends all shell controls to their callbacks', async () => {
    const user = userEvent.setup();
    const callbacks = renderSidebar();
    const pageLink = screen.getByRole('link', { name: 'Page one' });
    expect(pageLink.getAttribute('aria-current')).toBe('page');
    expect(pageLink.getAttribute('href')).toBe('#/page/page%20%2F%201');
    expect(screen.getByRole('link', { name: 'Database one' }).getAttribute('href')).toBe('#/database/database%20%2F%201');

    await user.click(screen.getByRole('button', { name: 'Create page' }));
    await user.click(screen.getByRole('button', { name: 'Create database' }));
    await user.click(screen.getByRole('button', { name: /Search knowledge/ }));
    await user.click(screen.getByRole('button', { name: /Local dashboard/ }));
    await user.click(screen.getByRole('button', { name: /Research/ }));
    expect(callbacks.onCreatePage).toHaveBeenCalledTimes(1);
    expect(callbacks.onCreateDatabase).toHaveBeenCalledTimes(1);
    expect(callbacks.onOpenSearch).toHaveBeenCalledTimes(1);
    expect(callbacks.onOpenStatus).toHaveBeenCalledTimes(1);
    expect(callbacks.onOpenWorkspaces).toHaveBeenCalledTimes(1);
    expect(callbacks.onCloseDrawer).toHaveBeenCalledTimes(5);
  });

  it('shows loading and empty collection variants, and disables creates while a mutation is active', () => {
    const { rerender } = render(
      <Sidebar
        creating={null}
        databases={[]}
        drawerOpen={false}
        loading
        onCloseDrawer={vi.fn()}
        onCreateDatabase={vi.fn(async () => undefined)}
        onCreatePage={vi.fn(async () => undefined)}
        onOpenSearch={vi.fn()}
        onOpenStatus={vi.fn()}
        onOpenWorkspaces={vi.fn()}
        pages={[]}
        route={{ name: 'home' }}
        workspace={workspace}
      />,
    );
    expect(document.querySelectorAll('.sidebar-skeleton')).toHaveLength(2);

    rerender(
      <Sidebar
        creating="database"
        databases={[]}
        drawerOpen={false}
        loading={false}
        onCloseDrawer={vi.fn()}
        onCreateDatabase={vi.fn(async () => undefined)}
        onCreatePage={vi.fn(async () => undefined)}
        onOpenSearch={vi.fn()}
        onOpenStatus={vi.fn()}
        onOpenWorkspaces={vi.fn()}
        pages={[]}
        route={{ name: 'archive' }}
        workspace={workspace}
      />,
    );
    expect(screen.getAllByText(/No .* yet/)).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Archive' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Create page' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Create database' })).toHaveProperty('disabled', true);
  });

  it('focuses the mobile drawer and closes through Escape, Tab trapping, and scrim clicks', async () => {
    const user = userEvent.setup();
    const { onCloseDrawer } = renderSidebar({ drawerOpen: true, route: { name: 'database', databaseId: database.id } });
    const drawer = screen.getByRole('dialog', { name: 'Workspace navigation' });
    const close = within(drawer).getByRole('button', { name: 'Close navigation' });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(document.body.classList.contains('drawer-open')).toBe(true);
    expect(screen.getByRole('link', { name: 'Database one' }).getAttribute('aria-current')).toBe('page');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseDrawer).toHaveBeenCalledTimes(1);
    screen.getByRole('button', { name: /Research/ }).focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Local dashboard/ }));
    fireEvent.click(document.querySelector('.sidebar-scrim')!);
    expect(onCloseDrawer).toHaveBeenCalledTimes(2);
  });
});
