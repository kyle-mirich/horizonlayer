// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DashboardApiClient } from '../api';
import { DashboardViewContext, useDashboard } from './DashboardContext';
import type { Workspace } from '../types';

const workspace: Workspace = {
  archived_at: null, created_at: '2026-07-01T00:00:00.000Z', description: null, icon: null, id: 'workspace-1',
  name: 'Research', revision: 1, updated_at: '2026-07-01T00:00:00.000Z',
};

function Reader() {
  const value = useDashboard();
  return <span>{value.workspace.name}</span>;
}

afterEach(() => cleanup());

describe('useDashboard', () => {
  it('returns the dashboard context value inside its provider', () => {
    render(<DashboardViewContext.Provider value={{
      api: {} as DashboardApiClient, navigate: vi.fn(), refreshWorkspaceData: vi.fn(async () => undefined),
      showToast: vi.fn(), workspace,
    }}><Reader /></DashboardViewContext.Provider>);
    expect(screen.getByText('Research')).toBeTruthy();
  });

  it('rejects use outside the dashboard provider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Reader />)).toThrow('useDashboard must be used inside the HorizonLayer dashboard');
    consoleError.mockRestore();
  });
});
