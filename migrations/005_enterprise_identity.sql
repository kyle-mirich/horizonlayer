ALTER TABLE users
  ALTER COLUMN oidc_issuer DROP NOT NULL,
  ALTER COLUMN oidc_subject DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS primary_email VARCHAR(320),
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS password_enabled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE users
SET primary_email = COALESCE(primary_email, email),
    avatar_url = COALESCE(avatar_url, picture_url)
WHERE primary_email IS NULL OR avatar_url IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_primary_email_idx
  ON users (LOWER(primary_email))
  WHERE primary_email IS NOT NULL;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS auth_policy JSONB NOT NULL DEFAULT '{"allow_local_login":true,"enforce_sso":false,"default_member_role":"member"}'::jsonb;

UPDATE organizations
SET display_name = COALESCE(display_name, name)
WHERE display_name IS NULL;

ALTER TABLE organization_members
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE workspaces
  ALTER COLUMN sharing_scope SET DEFAULT 'private';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workspaces_sharing_scope_check'
  ) THEN
    ALTER TABLE workspaces DROP CONSTRAINT workspaces_sharing_scope_check;
  END IF;
END $$;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_sharing_scope_check
  CHECK (sharing_scope IN ('private', 'explicit_members', 'organization'));

CREATE TABLE IF NOT EXISTS identities (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_type     VARCHAR(32) NOT NULL,
  provider_subject  TEXT,
  provider_issuer   TEXT,
  provider_tenant_id TEXT,
  claims_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS identities_provider_idx
  ON identities(provider_type, provider_subject, provider_issuer)
  WHERE provider_subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS sso_connections (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_type           VARCHAR(32) NOT NULL,
  status                  VARCHAR(32) NOT NULL DEFAULT 'draft',
  client_id               TEXT NOT NULL,
  encrypted_client_secret TEXT NOT NULL,
  issuer_url              TEXT NOT NULL,
  tenant_id               TEXT,
  allowed_domains         TEXT[] NOT NULL DEFAULT '{}',
  is_default              BOOLEAN NOT NULL DEFAULT FALSE,
  jit_provisioning_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  enforce_sso             BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_cache          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sso_connections_org_idx
  ON sso_connections(organization_id, provider_type, status);

CREATE TABLE IF NOT EXISTS invitations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           VARCHAR(320) NOT NULL,
  role            VARCHAR(32) NOT NULL DEFAULT 'member',
  status          VARCHAR(32) NOT NULL DEFAULT 'pending',
  invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  invited_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_idx
  ON invitations(organization_id, LOWER(email))
  WHERE status = 'pending';

ALTER TABLE browser_sessions
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS auth_method VARCHAR(32) NOT NULL DEFAULT 'local_admin',
  ADD COLUMN IF NOT EXISTS absolute_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

UPDATE browser_sessions
SET absolute_expires_at = COALESCE(absolute_expires_at, expires_at);

ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS session_id VARCHAR(255) REFERENCES browser_sessions(session_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id           VARCHAR(255) NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  session_id          VARCHAR(255) REFERENCES browser_sessions(session_id) ON DELETE SET NULL,
  token_hash          TEXT NOT NULL UNIQUE,
  family_id           UUID NOT NULL,
  scopes              TEXT[] NOT NULL DEFAULT '{}',
  resource            TEXT,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  rotated_from_token_id UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  revoked_at          TIMESTAMPTZ,
  revoked_reason      TEXT
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx
  ON refresh_tokens(user_id, client_id);

CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx
  ON refresh_tokens(family_id);

CREATE TABLE IF NOT EXISTS sso_login_states (
  state            VARCHAR(255) PRIMARY KEY,
  provider_type    VARCHAR(32) NOT NULL,
  redirect_to      TEXT,
  code_verifier    TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action           VARCHAR(128) NOT NULL,
  target_type      VARCHAR(64) NOT NULL,
  target_id        TEXT,
  ip_address       TEXT,
  user_agent       TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_org_created_idx
  ON audit_logs(organization_id, created_at DESC);
