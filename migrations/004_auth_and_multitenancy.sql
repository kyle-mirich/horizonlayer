CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email        VARCHAR(320),
  display_name VARCHAR(255),
  picture_url  TEXT,
  oidc_issuer  TEXT NOT NULL,
  oidc_subject TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (email),
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug        VARCHAR(255) NOT NULL UNIQUE,
  name        VARCHAR(255) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            VARCHAR(32) NOT NULL DEFAULT 'member',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id)
);

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sharing_scope VARCHAR(32) NOT NULL DEFAULT 'private';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workspaces_sharing_scope_check'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_sharing_scope_check
      CHECK (sharing_scope IN ('private', 'organization'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         VARCHAR(32) NOT NULL DEFAULT 'editor',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                VARCHAR(255) PRIMARY KEY,
  client_secret            TEXT,
  client_secret_expires_at BIGINT,
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code           VARCHAR(255) PRIMARY KEY,
  client_id      VARCHAR(255) NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes         TEXT[] NOT NULL DEFAULT '{}',
  resource       TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  access_token       VARCHAR(255) PRIMARY KEY,
  refresh_token      VARCHAR(255) UNIQUE,
  client_id          VARCHAR(255) NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes             TEXT[] NOT NULL DEFAULT '{}',
  resource           TEXT,
  access_expires_at  TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  session_id  VARCHAR(255) PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oidc_login_states (
  state                  VARCHAR(255) PRIMARY KEY,
  client_id              VARCHAR(255) NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri           TEXT NOT NULL,
  code_challenge         TEXT NOT NULL,
  scopes                 TEXT[] NOT NULL DEFAULT '{}',
  resource               TEXT,
  original_state         TEXT,
  upstream_code_verifier TEXT NOT NULL,
  expires_at             TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspaces_owner_user_idx
  ON workspaces(owner_user_id);

CREATE INDEX IF NOT EXISTS workspaces_org_idx
  ON workspaces(organization_id);

CREATE INDEX IF NOT EXISTS workspace_members_user_idx
  ON workspace_members(user_id);

CREATE INDEX IF NOT EXISTS organization_members_user_idx
  ON organization_members(user_id);

CREATE INDEX IF NOT EXISTS oauth_authorization_codes_client_idx
  ON oauth_authorization_codes(client_id);

CREATE INDEX IF NOT EXISTS oauth_authorization_codes_user_idx
  ON oauth_authorization_codes(user_id);

CREATE INDEX IF NOT EXISTS oauth_tokens_client_idx
  ON oauth_tokens(client_id);

CREATE INDEX IF NOT EXISTS oauth_tokens_user_idx
  ON oauth_tokens(user_id);

CREATE INDEX IF NOT EXISTS oauth_tokens_refresh_idx
  ON oauth_tokens(refresh_token)
  WHERE refresh_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS browser_sessions_user_idx
  ON browser_sessions(user_id);
