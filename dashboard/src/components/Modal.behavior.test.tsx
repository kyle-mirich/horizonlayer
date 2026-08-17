// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Modal } from './Modal';

afterEach(() => {
  cleanup();
  document.body.classList.remove('modal-open');
});

describe('Modal behavior', () => {
  it('focuses the first control, traps Tab both ways, and closes from button or backdrop', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <Modal description="Edit safely" onClose={onClose} title="Edit">
        <input aria-label="First field" />
        <button type="button">Last action</button>
      </Modal>,
    );
    const last = screen.getByRole('button', { name: 'Last action' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close dialog' }));
    last.focus();
    await user.keyboard('{Tab}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close dialog' }));
    const close = screen.getByRole('button', { name: 'Close dialog' });
    close.focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(last);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(container.querySelector('.modal-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('dialog').getAttribute('aria-describedby')).toBeTruthy();
  });

  it('works without a description or focusable descendants and restores prior focus on unmount', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(<Modal onClose={vi.fn()} title="Read only"><p>Nothing to edit</p></Modal>);
    const dialog = screen.getByRole('dialog', { name: 'Read only' });
    expect(dialog.getAttribute('aria-describedby')).toBeNull();
    fireEvent.keyDown(document, { key: 'Tab' });
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
