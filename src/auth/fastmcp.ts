import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { AzureProvider, GoogleProvider, OAuthProvider } from 'fastmcp';
import { DiskStore, type OAuthSession } from 'fastmcp/auth';
import { config } from '../config.js';
import type { AppSession } from '../mcp.js';
import { fetchUserInfo } from './oidc.js';
import { upsertOAuthUser } from './users.js';

type ProviderType = 'google_oidc' | 'microsoft_oidc' | 'generic_oidc';

export type FastMcpAuthStatus = {
  configured: boolean;
  devHarnessReady: boolean;
  devHarnessIssues: string[];
  issues: string[];
  providerType: ProviderType | null;
  publicUrl: string;
};

type AuthBundle = {
  authenticateToken: (token: string) => Promise<AppSession | undefined>;
  authenticate: (request?: IncomingMessage) => Promise<AppSession | undefined>;
  oauth: ReturnType<GoogleProvider['getOAuthConfig']>;
};

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized.includes('your-google-oauth-client') ||
    normalized.includes('replace-') ||
    normalized.includes('unused-with-fastmcp')
  );
}

type GoogleLikeClaims = {
  email?: string;
  name?: string;
  picture?: string;
  sub?: string;
};

function getBearerToken(request?: IncomingMessage): string | null {
  const header = Array.isArray(request?.headers.authorization)
    ? request?.headers.authorization[0]
    : request?.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  return header.slice('Bearer '.length);
}

function decodeJwtClaims(token: string): GoogleLikeClaims | null {
  const segments = token.split('.');
  if (segments.length < 2) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as GoogleLikeClaims;
  } catch {
    return null;
  }
}

export function getFastMcpAuthStatus(): FastMcpAuthStatus {
  const type = config.auth.sso.provider_type ?? null;
  const issues: string[] = [];
  const devHarnessIssues: string[] = [];

  if (!config.auth.enabled) {
    issues.push('auth.enabled is false');
  }

  if (!config.auth.sso.enabled) {
    issues.push('auth.sso.enabled is false');
  }
  if (!type) {
    issues.push('auth.sso.provider_type is missing');
  }

  if (isPlaceholder(config.auth.sso.client_id)) {
    issues.push('Google OAuth client ID is missing');
  }

  if (isPlaceholder(config.auth.sso.client_secret)) {
    issues.push('Google OAuth client secret is missing');
  }

  if (config.auth.security.cookie_secret.length < 32) {
    issues.push('auth.security.cookie_secret must be at least 32 characters');
  }

  if (config.auth.security.encryption_key.length < 32) {
    issues.push('auth.security.encryption_key must be at least 32 characters');
  }

  if (type !== 'google_oidc') {
    devHarnessIssues.push('dev harness currently supports google_oidc only');
  }

  if (config.server.public_url !== 'http://127.0.0.1:3000') {
    devHarnessIssues.push('dev harness requires server.public_url to be http://127.0.0.1:3000');
  }

  return {
    configured: issues.length === 0,
    devHarnessReady: issues.length === 0 && devHarnessIssues.length === 0,
    devHarnessIssues,
    issues,
    providerType: type,
    publicUrl: config.server.public_url,
  };
}

function getIssuerUrl(type: ProviderType): string {
  if (config.auth.sso.issuer_url) {
    return config.auth.sso.issuer_url;
  }

  if (type === 'google_oidc') {
    return 'https://accounts.google.com';
  }

  if (type === 'microsoft_oidc') {
    const tenantId = config.auth.sso.tenant_id ?? 'common';
    return `https://login.microsoftonline.com/${tenantId}/v2.0`;
  }

  throw new Error('auth.sso.issuer_url is required for generic_oidc');
}

function createProvider() {
  const status = getFastMcpAuthStatus();
  const type = status.providerType;
  if (!status.configured || !type) {
    return null;
  }
  const clientId = config.auth.sso.client_id as string;
  const clientSecret = config.auth.sso.client_secret as string;

  const providerConfig = {
    baseUrl: config.server.public_url,
    clientId,
    clientSecret,
    consentRequired: true,
    encryptionKey: config.auth.security.encryption_key,
    jwtSigningKey: config.auth.security.cookie_secret,
    scopes: config.auth.sso.default_scopes,
    tokenStorage: new DiskStore({
      directory: config.auth.sso.token_storage_dir ?? join(process.cwd(), '.fastmcp-auth'),
    }),
  };

  switch (type) {
    case 'google_oidc':
      return new GoogleProvider(providerConfig);
    case 'microsoft_oidc':
      return new AzureProvider({
        ...providerConfig,
        tenantId: config.auth.sso.tenant_id ?? 'common',
      });
    case 'generic_oidc':
      if (!config.auth.sso.authorization_endpoint || !config.auth.sso.token_endpoint) {
        throw new Error('generic_oidc requires auth.sso.authorization_endpoint and auth.sso.token_endpoint');
      }
      return new OAuthProvider({
        ...providerConfig,
        authorizationEndpoint: config.auth.sso.authorization_endpoint,
        tokenEndpoint: config.auth.sso.token_endpoint,
        tokenEndpointAuthMethod: config.auth.sso.token_endpoint_auth_method ?? 'client_secret_basic',
      });
  }
}

async function enrichSession(
  session: OAuthSession,
  request: IncomingMessage | undefined,
  type: ProviderType,
): Promise<AppSession> {
  const issuerUrl = getIssuerUrl(type);
  const claims = getBearerToken(request) ? decodeJwtClaims(getBearerToken(request) as string) : null;
  const userInfo = claims?.sub
    ? {
        email: claims.email,
        name: claims.name,
        picture: claims.picture,
        sub: claims.sub,
      }
    : await fetchUserInfo(
        {
          allowedDomains: config.auth.sso.allowed_domains,
          clientId: config.auth.sso.client_id ?? '',
          encryptedClientSecret: '',
          issuerUrl,
          providerType: type === 'generic_oidc' ? 'google_oidc' : type,
        },
        session.accessToken,
      );

  const emailDomain = userInfo.email?.split('@')[1]?.toLowerCase() ?? null;
  if (
    config.auth.sso.allowed_domains.length > 0 &&
    (!emailDomain || !config.auth.sso.allowed_domains.map((domain) => domain.toLowerCase()).includes(emailDomain))
  ) {
    throw new Response(null, {
      status: 403,
      statusText: 'Email domain is not allowed',
    });
  }

  const localUser = await upsertOAuthUser({
    email: userInfo.email ?? null,
    issuer: issuerUrl,
    picture: userInfo.picture ?? null,
    subject: userInfo.sub,
    username: userInfo.name ?? null,
  });

  return {
    ...session,
    authMethod: type,
    email: userInfo.email ?? null,
    scopes: session.scopes ?? [],
    subject: userInfo.sub,
    userId: localUser.id,
  };
}

export function createFastMcpAuth(): AuthBundle | null {
  const provider = createProvider();
  const type = config.auth.sso.provider_type;
  if (!provider || !type) {
    return null;
  }

  const authenticateToken = async (token: string): Promise<AppSession | undefined> => {
    const session = await provider.authenticate({
      headers: {
        authorization: `Bearer ${token}`,
      },
    } as IncomingMessage);
    if (!session) {
      return undefined;
    }
    return enrichSession(
      session,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      } as IncomingMessage,
      type
    );
  };

  return {
    authenticateToken,
    authenticate: async (request?: IncomingMessage) => {
      const token = getBearerToken(request);
      if (!token) {
        return undefined;
      }
      return authenticateToken(token);
    },
    oauth: provider.getOAuthConfig(),
  };
}
