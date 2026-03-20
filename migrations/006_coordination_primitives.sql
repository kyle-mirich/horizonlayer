CREATE TABLE IF NOT EXISTS tasks (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id              UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title                     VARCHAR(500) NOT NULL,
  description               TEXT,
  status                    VARCHAR(32) NOT NULL DEFAULT 'pending',
  priority                  INTEGER NOT NULL DEFAULT 100,
  owner_agent_name          VARCHAR(255),
  lease_owner_agent_name    VARCHAR(255),
  lease_expires_at          TIMESTAMPTZ,
  heartbeat_at              TIMESTAMPTZ,
  revision                  INTEGER NOT NULL DEFAULT 1,
  attempt_count             INTEGER NOT NULL DEFAULT 0,
  max_attempts              INTEGER NOT NULL DEFAULT 3,
  handoff_target_agent_name VARCHAR(255),
  blocker_reason            TEXT,
  required_ack_agent_names  TEXT[] NOT NULL DEFAULT '{}',
  metadata                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_agent_name     VARCHAR(255),
  completed_at              TIMESTAMPTZ,
  failed_at                 TIMESTAMPTZ,
  cancelled_at              TIMESTAMPTZ,
  last_event_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tasks_status_check CHECK (
    status IN (
      'pending',
      'ready',
      'claimed',
      'blocked',
      'handoff_pending',
      'done',
      'failed',
      'cancelled'
    )
  ),
  CONSTRAINT tasks_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT tasks_max_attempts_check CHECK (max_attempts >= 0),
  CONSTRAINT tasks_priority_check CHECK (priority >= 0)
);

CREATE INDEX IF NOT EXISTS tasks_workspace_status_priority_idx
  ON tasks(workspace_id, status, priority, created_at);

CREATE INDEX IF NOT EXISTS tasks_lease_idx
  ON tasks(workspace_id, lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_owner_idx
  ON tasks(workspace_id, owner_agent_name, status);

CREATE INDEX IF NOT EXISTS tasks_handoff_target_idx
  ON tasks(workspace_id, handoff_target_agent_name, status)
  WHERE handoff_target_agent_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id            UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CONSTRAINT task_dependencies_self_check CHECK (task_id <> depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS task_dependencies_depends_on_idx
  ON task_dependencies(depends_on_task_id, task_id);

CREATE TABLE IF NOT EXISTS task_events (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id           UUID REFERENCES tasks(id) ON DELETE CASCADE,
  event_type        VARCHAR(64) NOT NULL,
  actor_agent_name  VARCHAR(255),
  target_agent_name VARCHAR(255),
  task_revision     INTEGER,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS task_events_workspace_created_idx
  ON task_events(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS task_events_task_created_idx
  ON task_events(task_id, created_at DESC)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS task_events_target_agent_idx
  ON task_events(workspace_id, target_agent_name, created_at DESC)
  WHERE target_agent_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_acknowledgements (
  task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_name   VARCHAR(255) NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (task_id, agent_name)
);

CREATE TABLE IF NOT EXISTS agent_inbox (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_name        VARCHAR(255) NOT NULL,
  task_id           UUID REFERENCES tasks(id) ON DELETE CASCADE,
  kind              VARCHAR(64) NOT NULL,
  actor_agent_name  VARCHAR(255),
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at           TIMESTAMPTZ,
  acknowledged_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_inbox_agent_created_idx
  ON agent_inbox(workspace_id, agent_name, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_inbox_unread_idx
  ON agent_inbox(workspace_id, agent_name, created_at DESC)
  WHERE read_at IS NULL;
