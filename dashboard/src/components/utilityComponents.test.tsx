// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardErrorBoundary } from './DashboardErrorBoundary';
import { Icon } from './Icon';
import { RevisionRing } from './RevisionRing';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('dashboard utility components', () => {
  it('renders icon variants with caller SVG properties', () => {
    const { rerender } = render(<Icon aria-label="Archive icon" name="archive" size={24} />);
    const svg = screen.getByLabelText('Archive icon');
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.querySelector('rect')).toBeTruthy();

    rerender(<Icon aria-label="Warning icon" className="warning" name="warning" />);
    expect(screen.getByLabelText('Warning icon').classList.contains('warning')).toBe(true);
    expect(screen.getByLabelText('Warning icon').querySelectorAll('path').length).toBeGreaterThan(1);
  });

  it('announces every revision state', () => {
    const { rerender } = render(<RevisionRing />);
    expect(screen.getByRole('status', { name: 'Saved' })).toBeTruthy();
    for (const state of ['saving', 'conflict', 'error'] as const) {
      rerender(<RevisionRing state={state} />);
      const expected = state === 'saving' ? 'Saving' : state === 'conflict' ? 'Changed elsewhere' : 'Could not save';
      expect(screen.getByRole('status', { name: expected }).classList.contains(`revision-ring--${state}`)).toBe(true);
    }
  });

  it('contains rendering failures and shows the safe recovery screen', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Broken(): never {
      throw new Error('boom');
    }
    render(<DashboardErrorBoundary><Broken /></DashboardErrorBoundary>);
    expect(screen.getByRole('alert').textContent).toContain('Dashboard interrupted');
    expect(screen.getByRole('button', { name: /Reload dashboard/ })).toBeTruthy();
    expect(consoleError).toHaveBeenCalled();
  });
});
