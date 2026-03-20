import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectMock = vi.fn();
const queryMock = vi.fn();
const releaseMock = vi.fn();

vi.mock('../db/client.js', () => ({
  getPool: () => ({
    connect: connectMock,
    query: queryMock,
  }),
}));

describe('auth users helpers', () => {
  beforeEach(() => {
    connectMock.mockReset();
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockResolvedValue({
      query: queryMock,
      release: releaseMock,
    });
  });

  it('returns an existing system user', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'system-user', oidc_issuer: 'system://legacy', oidc_subject: 'workspace-owner', avatar_url: null, display_name: 'Legacy', primary_email: null }],
      });

    const { ensureSystemUser } = await import('./users.js');
    const user = await ensureSystemUser();
    expect(user.id).toBe('system-user');
  });

  it('creates a system user when missing', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'new-system-user', oidc_issuer: 'system://legacy', oidc_subject: 'workspace-owner', avatar_url: null, display_name: 'Legacy', primary_email: null }],
      });

    const { ensureSystemUser } = await import('./users.js');
    const user = await ensureSystemUser();
    expect(user.id).toBe('new-system-user');
  });

  it('updates an existing oauth user matched by subject', async () => {
    queryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{ id: 'user-1', oidc_issuer: 'https://accounts.google.com', oidc_subject: 'sub-1', avatar_url: null, display_name: 'Old', primary_email: 'user@example.com' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'user-1', oidc_issuer: 'https://accounts.google.com', oidc_subject: 'sub-1', avatar_url: null, display_name: 'Kyle', primary_email: 'user@example.com' }],
      })
      .mockResolvedValueOnce(undefined);

    const { upsertOAuthUser } = await import('./users.js');
    const user = await upsertOAuthUser({
      email: 'User@Example.com',
      issuer: 'https://accounts.google.com',
      picture: null,
      subject: 'sub-1',
      username: 'Kyle',
    });

    expect(user.id).toBe('user-1');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('rejects email collisions instead of rebinding an existing oauth user', async () => {
    queryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-2' }] })
      .mockResolvedValueOnce(undefined);

    const { upsertOAuthUser } = await import('./users.js');
    await expect(
      upsertOAuthUser({
        email: 'user2@example.com',
        issuer: 'https://accounts.google.com',
        picture: null,
        subject: 'sub-2',
        username: 'Name',
      })
    ).rejects.toThrow('Email user2@example.com is already associated with another account');
  });

  it('inserts a new oauth user when no match exists', async () => {
    queryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'user-3', oidc_issuer: 'https://accounts.google.com', oidc_subject: 'sub-3', avatar_url: null, display_name: 'New User', primary_email: 'new@example.com' }],
      })
      .mockResolvedValueOnce(undefined);

    const { upsertOAuthUser } = await import('./users.js');
    const user = await upsertOAuthUser({
      email: 'new@example.com',
      issuer: 'https://accounts.google.com',
      picture: null,
      subject: 'sub-3',
      username: 'New User',
    });

    expect(user.id).toBe('user-3');
  });
});
