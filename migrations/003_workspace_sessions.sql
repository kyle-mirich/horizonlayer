ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS workspaces_expires_idx
  ON workspaces(expires_at)
  WHERE expires_at IS NOT NULL;
