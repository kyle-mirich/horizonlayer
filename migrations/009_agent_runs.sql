CREATE TABLE IF NOT EXISTS agent_runs (
  id                         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id               UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id                    UUID REFERENCES tasks(id) ON DELETE SET NULL,
  parent_run_id              UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  agent_name                 VARCHAR(255) NOT NULL,
  title                      VARCHAR(500),
  status                     VARCHAR(32) NOT NULL DEFAULT 'running',
  metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  result                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message              TEXT,
  latest_checkpoint_sequence INTEGER NOT NULL DEFAULT 0,
  latest_checkpoint_at       TIMESTAMPTZ,
  started_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at                TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_runs_status_check CHECK (status IN ('running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS agent_runs_workspace_created_idx
  ON agent_runs(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_runs_task_created_idx
  ON agent_runs(task_id, created_at DESC)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_runs_agent_status_idx
  ON agent_runs(workspace_id, agent_name, status, created_at DESC);

CREATE TABLE IF NOT EXISTS run_checkpoints (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id     UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence   INTEGER NOT NULL,
  summary    TEXT,
  state      JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS run_checkpoints_run_created_idx
  ON run_checkpoints(run_id, created_at DESC);
