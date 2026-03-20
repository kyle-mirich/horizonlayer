import { describe, expect, it } from 'vitest';
import { SYSTEM_ACCESS } from '../db/access.js';
import type { AppSession } from '../mcp.js';
import { getAccessContext } from './context.js';

describe('getAccessContext', () => {
  it('returns system access when session is missing', () => {
    expect(getAccessContext()).toEqual(SYSTEM_ACCESS);
  });

  it('returns system access when required fields are missing', () => {
    expect(getAccessContext({ accessToken: 'token', userId: 'u1' } as AppSession)).toEqual(SYSTEM_ACCESS);
    expect(getAccessContext({ accessToken: 'token', authMethod: 'google_oidc' } as AppSession)).toEqual(SYSTEM_ACCESS);
  });

  it('returns user access and filters scopes', () => {
    expect(
      getAccessContext({
        accessToken: 'token',
        authMethod: 'google_oidc',
        email: 'user@example.com',
        scopes: ['openid', 123 as never, 'email'],
        userId: 'user-1',
      } as AppSession)
    ).toEqual({
      authMethod: 'google_oidc',
      email: 'user@example.com',
      kind: 'user',
      organizationId: null,
      organizationRole: null,
      scopes: ['openid', 'email'],
      userId: 'user-1',
    });
  });
});
