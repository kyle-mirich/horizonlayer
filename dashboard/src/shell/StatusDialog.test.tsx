// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DashboardApiClient } from '../api';
import type { DashboardStatus } from '../types';
import { StatusDialog } from './StatusDialog';

const status: DashboardStatus = {
  database: 'connected', mcp: { available: true, command: 'npx -y horizonlayer@latest mcp' }, rag: { enabled: true },
  tools: ['workspace', 'page', 'database', 'row', 'search'], version: '1.2.3',
};

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});

describe('StatusDialog', () => {
  it('uses refreshed health and copies the live agent command', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<StatusDialog api={{ status: vi.fn(async () => ({ ...status, mcp: { available: true, command: 'npx -y horizonlayer@latest mcp' } })) } as unknown as DashboardApiClient}
      onClose={vi.fn()} status={{ ...status, rag: { enabled: false } }} />);
    expect(await screen.findByText('Enabled')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('npx -y horizonlayer@latest mcp'));
    expect(screen.getByRole('status').textContent).toContain('Agent command copied.');
    expect(screen.getByText('HorizonLayer 1.2.3')).toBeTruthy();
  });

  it('reports unavailable health and clipboard failures', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('denied'); }) },
    });
    render(<StatusDialog api={{ status: vi.fn(async () => { throw new Error('offline'); }) } as unknown as DashboardApiClient}
      onClose={vi.fn()} status={status} />);
    await waitFor(() => expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Clipboard unavailable. Select the command to copy it.')).toBeTruthy();
  });
});
