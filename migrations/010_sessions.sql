CREATE TABLE IF NOT EXISTS sessions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title            VARCHAR(500) NOT NULL,
  status           VARCHAR(32) NOT NULL DEFAULT 'active',
  summary          TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sessions_status_check CHECK (status IN ('active', 'closed'))
);

CREATE INDEX IF NOT EXISTS sessions_workspace_last_activity_idx
  ON sessions(workspace_id, last_activity_at DESC);

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS pages_session_idx
  ON pages(session_id)
  WHERE session_id IS NOT NULL;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tasks_session_idx
  ON tasks(session_id)
  WHERE session_id IS NOT NULL;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agent_runs_session_idx
  ON agent_runs(session_id)
  WHERE session_id IS NOT NULL;
