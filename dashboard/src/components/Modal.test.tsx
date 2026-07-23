// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Modal } from './Modal';

describe('Modal', () => {
  it('keeps focus in place when a parent render replaces the close callback', () => {
    const firstClose = vi.fn();
    const { rerender } = render(
      <Modal onClose={firstClose} title="Edit record">
        <input aria-label="Record name" />
      </Modal>,
    );
    const input = screen.getByLabelText('Record name');
    input.focus();

    rerender(
      <Modal onClose={vi.fn()} title="Edit record">
        <input aria-label="Record name" />
      </Modal>,
    );

    expect(document.activeElement).toBe(input);
  });

  it('lets only the topmost dialog handle Escape and keeps scroll locked underneath', () => {
    function StackedDialogs() {
      const [firstOpen, setFirstOpen] = useState(true);
      const [secondOpen, setSecondOpen] = useState(true);
      return (
        <>
          {firstOpen ? <Modal onClose={() => setFirstOpen(false)} title="First dialog">First</Modal> : null}
          {secondOpen ? <Modal onClose={() => setSecondOpen(false)} title="Second dialog">Second</Modal> : null}
        </>
      );
    }

    render(<StackedDialogs />);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Second dialog' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'First dialog' })).toBeTruthy();
    expect(document.body.classList.contains('modal-open')).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.classList.contains('modal-open')).toBe(false);
  });
});
