// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

const render = vi.fn();
const createRoot = vi.fn(() => ({ render }));

vi.mock('react-dom/client', () => ({ createRoot }));

afterEach(() => {
  document.body.innerHTML = '';
  render.mockClear();
  createRoot.mockClear();
  vi.resetModules();
});

describe('dashboard entrypoint', () => {
  it('mounts the strict-mode dashboard tree into the root element', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);

    await import('./main');

    expect(createRoot).toHaveBeenCalledWith(root);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('fails clearly if the host page has no dashboard root', async () => {
    await expect(import('./main')).rejects.toThrow('Dashboard root element is missing');
  });
});
