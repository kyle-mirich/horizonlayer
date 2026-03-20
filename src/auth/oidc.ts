import { createHash } from 'node:crypto';
import { OpenIdProviderDiscoveryMetadataSchema, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { decryptSecret, randomToken } from './crypto.js';

export interface OidcConnection {
  providerType: 'google_oidc' | 'microsoft_oidc';
  clientId: string;
  encryptedClientSecret: string;
  issuerUrl: string;
  allowedDomains: string[];
}

export interface OidcUserInfo {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  hd?: string;
  tid?: string;
}

export interface OidcProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
}

function base64UrlSha256(input: string): string {
  return createHash('sha256').update(input).digest().toString('base64url');
}

export async function fetchOidcMetadata(issuerUrl: string): Promise<OidcProviderMetadata> {
  const discoveryUrl = issuerUrl.endsWith('/.well-known/openid-configuration')
    ? issuerUrl
    : new URL('/.well-known/openid-configuration', issuerUrl).href;
  const response = await fetch(discoveryUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch OIDC metadata: ${response.status}`);
  }
  const json = await response.json();
  const parsed = OpenIdProviderDiscoveryMetadataSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid OIDC metadata: ${parsed.error.message}`);
  }
  return {
    issuer: parsed.data.issuer,
    authorization_endpoint: parsed.data.authorization_endpoint,
    token_endpoint: parsed.data.token_endpoint,
    userinfo_endpoint: parsed.data.userinfo_endpoint,
  };
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return {
    verifier,
    challenge: base64UrlSha256(verifier),
  };
}

export async function createAuthorizationUrl(params: {
  connection: OidcConnection;
  callbackUrl: string;
  state: string;
  scopes: string[];
  codeChallenge: string;
  loginHint?: string;
}): Promise<URL> {
  const metadata = await fetchOidcMetadata(params.connection.issuerUrl);
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('client_id', params.connection.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.callbackUrl);
  url.searchParams.set('scope', params.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (params.loginHint) {
    url.searchParams.set('login_hint', params.loginHint);
  }
  return url;
}

export async function exchangeAuthorizationCode(params: {
  connection: OidcConnection;
  callbackUrl: string;
  code: string;
  codeVerifier: string;
}): Promise<OAuthTokens> {
  const metadata = await fetchOidcMetadata(params.connection.issuerUrl);
  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.callbackUrl,
      client_id: params.connection.clientId,
      client_secret: decryptSecret(params.connection.encryptedClientSecret),
      code_verifier: params.codeVerifier,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OIDC token exchange failed: ${body}`);
  }
  return (await response.json()) as OAuthTokens;
}

export async function fetchUserInfo(
  connection: OidcConnection,
  accessToken: string
): Promise<OidcUserInfo> {
  const metadata = await fetchOidcMetadata(connection.issuerUrl);
  if (!metadata.userinfo_endpoint) {
    throw new Error('OIDC metadata does not include userinfo_endpoint');
  }
  const response = await fetch(metadata.userinfo_endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OIDC userinfo lookup failed: ${body}`);
  }
  const json = (await response.json()) as Record<string, unknown>;
  if (typeof json.sub !== 'string') {
    throw new Error('OIDC userinfo missing sub');
  }
  return {
    sub: json.sub,
    email: typeof json.email === 'string' ? json.email : undefined,
    name: typeof json.name === 'string' ? json.name : undefined,
    picture: typeof json.picture === 'string' ? json.picture : undefined,
    hd: typeof json.hd === 'string' ? json.hd : undefined,
    tid: typeof json.tid === 'string' ? json.tid : undefined,
  };
}
