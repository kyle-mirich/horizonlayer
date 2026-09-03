// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import type { DashboardApiClient } from '../api';
import type { DashboardStatus, Workspace } from '../types';

const status: DashboardStatus = {
  database: 'connected',
  mcp: { available: true, command: 'npx -y horizonlayer@latest mcp' },
  rag: { enabled: false },
  tools: ['workspace', 'page', 'database', 'row', 'search'],
  version: '0.1.1',
};

const workspace: Workspace = {
  archived_at: null,
  created_at: '2026-07-16T12:00:00.000Z',
  description: 'Shared agent context',
  icon: '◌',
  id: '19f9ea37-b93e-4408-a6ab-ff8b5dd07de4',
  name: 'Field notes',
  revision: 1,
  updated_at: '2026-07-16T12:00:00.000Z',
};

function fakeApi(workspaces: Workspace[]): DashboardApiClient {
  const emptyPage = { has_more: false, limit: 50, next_offset: null, offset: 0 };
  return {
    database: vi.fn(async () => ({
      action: 'list',
      error: null,
      meta: {},
      ok: true,
      result: { items: [], page: emptyPage },
    })),
    page: vi.fn(async () => ({
      action: 'list',
      error: null,
      meta: {},
      ok: true,
      result: { items: [], page: emptyPage },
    })),
    status: vi.fn(async () => status),
    workspace: vi.fn(async () => ({
      action: 'list',
      error: null,
      meta: {},
      ok: true,
      result: { items: workspaces, page: emptyPage },
    })),
  } as unknown as DashboardApiClient;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});

describe('dashboard shell', () => {
  it('offers one clear first-run action without a dead cancel control', async () => {
    render(<App api={fakeApi([])} />);

    expect(await screen.findByRole('heading', { name: 'Make a place for shared knowledge.' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create workspace' })).toBeTruthy();
  });

  it('opens bounded workspace search from Ctrl-K and marks unavailable RAG honestly', async () => {
    render(<App api={fakeApi([workspace])} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Field notes' })).toBeTruthy());
    fireEvent.click(screen.getByText('Skip to content'));
    expect(window.location.hash).toBe('#/home');
    expect(document.activeElement?.id).toBe('main-content');

    fireEvent.keyDown(window, { ctrlKey: true, key: 'k' });

    const dialog = await screen.findByRole('dialog', { name: 'Search knowledge' });
    const passages = within(dialog).getByRole('button', { name: /Passages/ });
    expect((passages as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('Unavailable')).toBeTruthy();
  });

  it('does not stack search over another open dialog', async () => {
    render(<App api={fakeApi([workspace])} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Field notes' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Local dashboard/ }));
    expect(await screen.findByRole('dialog', { name: 'Local connection' })).toBeTruthy();

    fireEvent.keyDown(window, { ctrlKey: true, key: 'k' });

    expect(screen.queryByRole('dialog', { name: 'Search knowledge' })).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('copies the exact local MCP command without claiming a persistent connection', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<App api={fakeApi([workspace])} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Field notes' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Local dashboard/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Local connection' });
    expect(within(dialog).getByText('Available when a local agent launches it')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('npx -y horizonlayer@latest mcp'));
    expect(within(dialog).getByRole('button', { name: /Copied/ })).toBeTruthy();
  });

  it('refreshes PostgreSQL health whenever the connection dialog opens', async () => {
    const api = fakeApi([workspace]);
    const statusMock = vi.mocked(api.status);
    statusMock
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ...status, database: 'unavailable' });
    render(<App api={api} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Field notes' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Local dashboard/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Local connection' });

    await waitFor(() => expect(within(dialog).getAllByText('Unavailable').length).toBeGreaterThan(0));
    expect(statusMock).toHaveBeenCalledTimes(2);
  });

  it('focuses and contains keyboard navigation in the mobile drawer', async () => {
    render(<App api={fakeApi([workspace])} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Field notes' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByRole('dialog', { name: 'Workspace navigation' });
    const close = within(drawer).getByRole('button', { name: 'Close navigation' });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(document.querySelector('.app-main')?.hasAttribute('inert')).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Workspace navigation' })).toBeNull());
    expect(document.querySelector('.app-main')?.hasAttribute('inert')).toBe(false);
  });
});
