import { format } from 'node:util';

import { afterEach } from 'vitest';

interface ActWarningState {
  guardedConsoleError?: typeof console.error;
  warnings: string[];
}

const stateKey = Symbol.for('horizonlayer.vitest.act-warning-state');
const testGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
const state = (testGlobal[stateKey] as ActWarningState | undefined) ?? { warnings: [] };
testGlobal[stateKey] = state;

if (console.error !== state.guardedConsoleError) {
  const originalConsoleError = console.error;
  const guardedConsoleError = (...args: unknown[]) => {
    const message = format(...args);
    if (message.includes('not wrapped in act')) state.warnings.push(message);
    Reflect.apply(originalConsoleError, console, args);
  };
  state.guardedConsoleError = guardedConsoleError;
  console.error = guardedConsoleError;
}

afterEach(() => {
  const warnings = state.warnings.splice(0);
  if (warnings.length > 0) {
    throw new Error(`React state update escaped act():\n${warnings.join('\n')}`);
  }
});
