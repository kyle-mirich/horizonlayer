DROP INDEX IF EXISTS workspaces_owner_user_idx;
DROP INDEX IF EXISTS workspaces_org_idx;

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_owner_user_id_fkey;

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_sharing_scope_check;

ALTER TABLE workspaces
  DROP COLUMN IF EXISTS owner_user_id,
  DROP COLUMN IF EXISTS organization_id,
  DROP COLUMN IF EXISTS sharing_scope;

DROP TABLE IF EXISTS subscriptions CASCADE;
DROP TABLE IF EXISTS billing_webhook_events CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS sso_login_states CASCADE;
DROP TABLE IF EXISTS refresh_tokens CASCADE;
DROP TABLE IF EXISTS sso_connections CASCADE;
DROP TABLE IF EXISTS identities CASCADE;
DROP TABLE IF EXISTS invitations CASCADE;
DROP TABLE IF EXISTS oauth_authorization_codes CASCADE;
DROP TABLE IF EXISTS oauth_tokens CASCADE;
DROP TABLE IF EXISTS oidc_login_states CASCADE;
DROP TABLE IF EXISTS browser_sessions CASCADE;
DROP TABLE IF EXISTS oauth_clients CASCADE;
DROP TABLE IF EXISTS workspace_members CASCADE;
DROP TABLE IF EXISTS organization_members CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;
DROP TABLE IF EXISTS users CASCADE;
