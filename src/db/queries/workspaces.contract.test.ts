import { describe, expect, it } from 'vitest';

describe('workspace public contract', () => {
  it('publishes the revisioned archive lifecycle', async () => {
    const workspaceQueries = await import('./workspaces.js');
    expect(workspaceQueries).toHaveProperty('archiveWorkspace');
    expect(workspaceQueries).toHaveProperty('restoreWorkspace');
  });
});
