import { describe, expect, it, vi } from 'vitest';
import { HorizonApiClient } from './apiClient.js';

describe('HorizonApiClient', () => {
  it('routes requests through the Electron bridge when available', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, result: [{ id: 'workspace-1' }] });
    const client = new HorizonApiClient({
      bridge: { request },
      baseUrl: 'http://127.0.0.1:3737',
    });

    await expect(client.get('/api/workspaces')).resolves.toEqual([{ id: 'workspace-1' }]);
    expect(request).toHaveBeenCalledWith({
      body: undefined,
      method: 'GET',
      path: '/api/workspaces',
    });
  });

  it('falls back to fetch for browser development', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, result: { id: 'task-1' } }),
      ok: true,
    } as Response);
    const client = new HorizonApiClient({
      baseUrl: 'http://127.0.0.1:3737',
      fetchImpl: fetchMock,
    });

    await expect(client.post('/api/tasks', { title: 'Ship', workspace_id: 'workspace-1' })).resolves.toEqual({ id: 'task-1' });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3737/api/tasks', {
      body: JSON.stringify({ title: 'Ship', workspace_id: 'workspace-1' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  });

  it('throws API error messages', async () => {
    const client = new HorizonApiClient({
      bridge: {
        request: vi.fn().mockResolvedValue({ error: { message: 'workspace_id is required' }, ok: false }),
      },
      baseUrl: 'http://127.0.0.1:3737',
    });

    await expect(client.get('/api/dashboard')).rejects.toThrow('workspace_id is required');
  });
});
