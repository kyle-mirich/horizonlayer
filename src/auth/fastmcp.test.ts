import { afterEach, describe, expect, it, vi } from 'vitest';

const googleAuthenticateMock = vi.fn();
const googleOAuthConfig = { enabled: true, protectedResource: { resource: 'http://127.0.0.1:3000' } };
const fetchUserInfoMock = vi.fn();
const upsertOAuthUserMock = vi.fn();

vi.mock('fastmcp', () => {
  class Provider {
    constructor(public config: unknown) {}
    authenticate = googleAuthenticateMock;
    getOAuthConfig() {
      return googleOAuthConfig;
    }
  }
  return {
    AzureProvider: Provider,
    GoogleProvider: Provider,
    OAuthProvider: Provider,
  };
});

vi.mock('fastmcp/auth', () => ({
  DiskStore: class DiskStore {
    constructor(public options: unknown) {}
  },
}));

vi.mock('./oidc.js', () => ({
  fetchUserInfo: fetchUserInfoMock,
}));

vi.mock('./users.js', () => ({
  upsertOAuthUser: upsertOAuthUserMock,
}));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env.AUTH_ENABLED;
  delete process.env.SSO_ENABLED;
  delete process.env.SSO_PROVIDER_TYPE;
  delete process.env.SSO_CLIENT_ID;
  delete process.env.SSO_CLIENT_SECRET;
  delete process.env.APP_BASE_URL;
  delete process.env.COOKIE_SECRET;
  delete process.env.ENCRYPTION_KEY;
});

async function loadModule() {
  return import('./fastmcp.js');
}

describe('fastmcp auth helpers', () => {
  it('reports missing config clearly', async () => {
    process.env.AUTH_ENABLED = 'true';
    process.env.SSO_ENABLED = 'true';
    process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
    process.env.COOKIE_SECRET = '12345678901234567890123456789012';
    process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';

    const { getFastMcpAuthStatus } = await loadModule();
    const status = getFastMcpAuthStatus();
    expect(status.configured).toBe(false);
    expect(status.issues).toContain('auth.sso.provider_type is missing');
    expect(status.issues).toContain('Google OAuth client ID is missing');
  });

  it('marks dev harness readiness only for localhost google config', async () => {
    process.env.AUTH_ENABLED = 'true';
    process.env.SSO_ENABLED = 'true';
    process.env.SSO_PROVIDER_TYPE = 'microsoft_oidc';
    process.env.SSO_CLIENT_ID = 'client-id';
    process.env.SSO_CLIENT_SECRET = 'client-secret';
    process.env.APP_BASE_URL = 'https://example.com';
    process.env.COOKIE_SECRET = '12345678901234567890123456789012';
    process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';

    const { getFastMcpAuthStatus } = await loadModule();
    const status = getFastMcpAuthStatus();
    expect(status.configured).toBe(true);
    expect(status.devHarnessReady).toBe(false);
    expect(status.devHarnessIssues).toContain('dev harness currently supports google_oidc only');
  });

  it('creates an auth bundle and enriches a session from JWT claims without userinfo fallback', async () => {
    process.env.AUTH_ENABLED = 'true';
    process.env.SSO_ENABLED = 'true';
    process.env.SSO_PROVIDER_TYPE = 'google_oidc';
    process.env.SSO_CLIENT_ID = 'client-id';
    process.env.SSO_CLIENT_SECRET = 'client-secret';
    process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
    process.env.COOKIE_SECRET = '12345678901234567890123456789012';
    process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';

    googleAuthenticateMock.mockResolvedValue({
      accessToken: 'upstream-token',
      scopes: ['openid', 'email'],
    });
    upsertOAuthUserMock.mockResolvedValue({ id: 'local-user-1' });

    const payload = Buffer.from(JSON.stringify({
      email: 'user@example.com',
      name: 'Kyle',
      picture: 'https://example.com/p.png',
      sub: 'google-sub',
    })).toString('base64url');
    const token = `header.${payload}.sig`;

    const { createFastMcpAuth } = await loadModule();
    const auth = createFastMcpAuth();
    expect(auth).not.toBeNull();

    const session = await auth?.authenticate({
      headers: {
        authorization: `Bearer ${token}`,
      },
    } as never);

    expect(fetchUserInfoMock).not.toHaveBeenCalled();
    expect(upsertOAuthUserMock).toHaveBeenCalledWith({
      email: 'user@example.com',
      issuer: 'https://accounts.google.com',
      picture: 'https://example.com/p.png',
      subject: 'google-sub',
      username: 'Kyle',
    });
    expect(session).toMatchObject({
      authMethod: 'google_oidc',
      email: 'user@example.com',
      subject: 'google-sub',
      userId: 'local-user-1',
    });
  });

  it('falls back to userinfo when token claims are unavailable', async () => {
    process.env.AUTH_ENABLED = 'true';
    process.env.SSO_ENABLED = 'true';
    process.env.SSO_PROVIDER_TYPE = 'google_oidc';
    process.env.SSO_CLIENT_ID = 'client-id';
    process.env.SSO_CLIENT_SECRET = 'client-secret';
    process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
    process.env.COOKIE_SECRET = '12345678901234567890123456789012';
    process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';

    googleAuthenticateMock.mockResolvedValue({
      accessToken: 'upstream-token',
      scopes: ['openid'],
    });
    fetchUserInfoMock.mockResolvedValue({
      email: 'fallback@example.com',
      name: 'Fallback',
      picture: null,
      sub: 'fallback-sub',
    });
    upsertOAuthUserMock.mockResolvedValue({ id: 'local-user-2' });

    const { createFastMcpAuth } = await loadModule();
    const auth = createFastMcpAuth();
    const session = await auth?.authenticate({
      headers: {
        authorization: 'Bearer malformed.token',
      },
    } as never);

    expect(fetchUserInfoMock).toHaveBeenCalledOnce();
    expect(session).toMatchObject({
      email: 'fallback@example.com',
      userId: 'local-user-2',
    });
  });

  it('rejects users outside allowed domains and supports generic provider config', async () => {
    process.env.AUTH_ENABLED = 'true';
    process.env.SSO_ENABLED = 'true';
    process.env.SSO_PROVIDER_TYPE = 'generic_oidc';
    process.env.SSO_CLIENT_ID = 'client-id';
    process.env.SSO_CLIENT_SECRET = 'client-secret';
    process.env.SSO_ISSUER_URL = 'https://issuer.example.com';
    process.env.SSO_AUTHORIZATION_ENDPOINT = 'https://issuer.example.com/oauth/authorize';
    process.env.SSO_TOKEN_ENDPOINT = 'https://issuer.example.com/oauth/token';
    process.env.SSO_ALLOWED_DOMAINS = 'example.com';
    process.env.APP_BASE_URL = 'http://127.0.0.1:3000';
    process.env.COOKIE_SECRET = '12345678901234567890123456789012';
    process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';

    googleAuthenticateMock.mockResolvedValue({
      accessToken: 'upstream-token',
      scopes: ['openid'],
    });
    fetchUserInfoMock.mockResolvedValue({
      email: 'outside@other.com',
      name: 'Outside',
      picture: null,
      sub: 'outside-sub',
    });

    const { createFastMcpAuth, getFastMcpAuthStatus } = await loadModule();
    expect(getFastMcpAuthStatus()).toMatchObject({
      configured: true,
      devHarnessReady: false,
      providerType: 'generic_oidc',
    });

    const auth = createFastMcpAuth();
    await expect(
      auth?.authenticate({
        headers: {
          authorization: 'Bearer malformed.token',
        },
      } as never)
    ).rejects.toBeInstanceOf(Response);
  });
});
