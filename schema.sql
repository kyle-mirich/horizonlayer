CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION database_row_value_search_text(
  candidate_text TEXT,
  candidate_json JSONB,
  candidate_number DOUBLE PRECISION,
  candidate_date TIMESTAMPTZ,
  candidate_bool BOOLEAN
) RETURNS TEXT AS $$
  SELECT COALESCE(
    candidate_text,
    candidate_json::text,
    candidate_number::text,
    CASE
      WHEN candidate_date IS NULL THEN NULL
      ELSE to_char(
        candidate_date AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    END,
    candidate_bool::text,
    ''
  );
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION valid_database_property_options(
  candidate_type TEXT,
  candidate_options JSONB
) RETURNS BOOLEAN AS $$
DECLARE
  choice JSONB;
  normalized_choice TEXT;
  seen_choices TEXT[] := '{}';
BEGIN
  IF jsonb_typeof(candidate_options) IS DISTINCT FROM 'object' THEN
    RETURN FALSE;
  END IF;

  IF candidate_type NOT IN ('select', 'multi_select') THEN
    RETURN candidate_options = '{}'::jsonb;
  END IF;

  IF candidate_options = '{}'::jsonb THEN
    RETURN TRUE;
  END IF;

  IF NOT candidate_options ? 'choices'
     OR (candidate_options - 'choices') <> '{}'::jsonb
     OR jsonb_typeof(candidate_options -> 'choices') IS DISTINCT FROM 'array'
     OR jsonb_array_length(candidate_options -> 'choices') > 100 THEN
    RETURN FALSE;
  END IF;

  FOR choice IN SELECT value FROM jsonb_array_elements(candidate_options -> 'choices')
  LOOP
    IF jsonb_typeof(choice) IS DISTINCT FROM 'string' THEN
      RETURN FALSE;
    END IF;
    normalized_choice := LOWER(BTRIM(choice #>> '{}'));
    IF normalized_choice = '' OR normalized_choice = ANY(seen_choices) THEN
      RETURN FALSE;
    END IF;
    seen_choices := array_append(seen_choices, normalized_choice);
  END LOOP;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(500) NOT NULL CHECK (BTRIM(name) <> ''),
  description TEXT,
  icon        VARCHAR(100),
  revision    INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_search_changes (
  change_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title            VARCHAR(500) NOT NULL CHECK (BTRIM(title) <> ''),
  status           VARCHAR(32) NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'closed')),
  summary          TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb
                   CHECK (jsonb_typeof(metadata) = 'object'),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sessions_ended_at_check CHECK (
    (status = 'active' AND ended_at IS NULL)
    OR (status = 'closed' AND ended_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS pages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id       UUID REFERENCES sessions(id) ON DELETE SET NULL,
  parent_page_id   UUID REFERENCES pages(id) ON DELETE SET NULL,
  title            VARCHAR(500) NOT NULL DEFAULT 'Untitled'
                   CHECK (BTRIM(title) <> ''),
  tags             TEXT[] NOT NULL DEFAULT '{}'
                   CHECK (array_position(tags, NULL) IS NULL),
  importance       DOUBLE PRECISION NOT NULL DEFAULT 0.5
                   CHECK (importance BETWEEN 0 AND 1),
  revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pages_parent_page_self_check CHECK (
    parent_page_id IS NULL OR parent_page_id <> id
  )
);

CREATE TABLE IF NOT EXISTS blocks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_type  VARCHAR(50) NOT NULL CHECK (
                block_type IN ('text', 'heading', 'todo', 'callout', 'code')
              ),
  content     TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb
              CHECK (jsonb_typeof(metadata) = 'object'),
  revision    INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS databases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_page_id UUID REFERENCES pages(id) ON DELETE SET NULL,
  name           VARCHAR(500) NOT NULL CHECK (BTRIM(name) <> ''),
  description    TEXT,
  tags           TEXT[] NOT NULL DEFAULT '{}'
                 CHECK (array_position(tags, NULL) IS NULL),
  revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS database_properties (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id   UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL CHECK (BTRIM(name) <> ''),
  property_type VARCHAR(50) NOT NULL CHECK (property_type IN (
    'title',
    'text',
    'number',
    'date',
    'checkbox',
    'select',
    'multi_select',
    'url'
  )),
  options       JSONB NOT NULL DEFAULT '{}'::jsonb
                CHECK (valid_database_property_options(property_type, options)),
  position      INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS database_rows (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id      UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  tags             TEXT[] NOT NULL DEFAULT '{}'
                   CHECK (array_position(tags, NULL) IS NULL),
  importance       DOUBLE PRECISION NOT NULL DEFAULT 0.5
                   CHECK (importance BETWEEN 0 AND 1),
  revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS database_row_values (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  row_id       UUID NOT NULL REFERENCES database_rows(id) ON DELETE CASCADE,
  property_id  UUID NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
  value_text   TEXT,
  value_number DOUBLE PRECISION,
  value_date   TIMESTAMPTZ,
  value_bool   BOOLEAN,
  value_json   JSONB,
  CONSTRAINT database_row_values_row_property_unique UNIQUE (row_id, property_id),
  CONSTRAINT database_row_values_single_typed_value_check CHECK (
    ((value_text IS NOT NULL)::integer
      + (value_number IS NOT NULL)::integer
      + (value_date IS NOT NULL)::integer
      + (value_bool IS NOT NULL)::integer
      + (value_json IS NOT NULL)::integer) <= 1
  )
);

CREATE TABLE IF NOT EXISTS issue_projects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_key       VARCHAR(20) NOT NULL
                    CHECK (project_key ~ '^[A-Z][A-Z0-9]{1,19}$'),
  name              VARCHAR(500) NOT NULL CHECK (BTRIM(name) <> ''),
  description       TEXT,
  next_issue_number INTEGER NOT NULL DEFAULT 1 CHECK (next_issue_number > 0),
  revision          INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES issue_projects(id) ON DELETE CASCADE,
  issue_number    INTEGER NOT NULL CHECK (issue_number > 0),
  issue_key       VARCHAR(64) NOT NULL CHECK (BTRIM(issue_key) <> ''),
  parent_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  title           VARCHAR(500) NOT NULL CHECK (BTRIM(title) <> ''),
  description     TEXT,
  status          VARCHAR(32) NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'in_progress', 'blocked', 'done', 'closed')),
  priority        VARCHAR(16)
                  CHECK (priority IS NULL OR priority IN ('lowest', 'low', 'medium', 'high', 'highest')),
  assignee        VARCHAR(255) CHECK (assignee IS NULL OR BTRIM(assignee) <> ''),
  created_by      VARCHAR(255) NOT NULL CHECK (BTRIM(created_by) <> ''),
  tags            TEXT[] NOT NULL DEFAULT '{}' CHECK (array_position(tags, NULL) IS NULL),
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT issues_parent_self_check CHECK (parent_issue_id IS NULL OR parent_issue_id <> id),
  CONSTRAINT issues_project_number_unique UNIQUE (project_id, issue_number),
  CONSTRAINT issues_key_unique UNIQUE (issue_key)
);

CREATE TABLE IF NOT EXISTS issue_comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id   UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author     VARCHAR(255) NOT NULL CHECK (BTRIM(author) <> ''),
  body       TEXT NOT NULL CHECK (BTRIM(body) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issue_dependencies (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blocking_issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  blocked_issue_id  UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  revision          INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT issue_dependencies_self_check CHECK (blocking_issue_id <> blocked_issue_id)
);

CREATE TABLE IF NOT EXISTS record_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  from_type    VARCHAR(20) NOT NULL CHECK (
                 from_type IN ('workspace', 'page', 'database', 'row', 'block', 'issue_project', 'issue')
               ),
  from_id      UUID NOT NULL,
  to_type      VARCHAR(20) NOT NULL CHECK (
                 to_type IN ('workspace', 'page', 'database', 'row', 'block', 'issue_project', 'issue')
               ),
  to_id        UUID NOT NULL,
  link_type    VARCHAR(100) NOT NULL DEFAULT 'related'
               CHECK (BTRIM(link_type) <> ''),
  revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The v2 adapter remains writable while the legacy MCP catalog is supported.
CREATE OR REPLACE VIEW links AS
SELECT id, workspace_id, from_type, from_id, to_type, to_id, link_type,
       revision, archived_at, created_at, updated_at
FROM record_links;

CREATE TABLE IF NOT EXISTS agent_runs (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id                 UUID REFERENCES sessions(id) ON DELETE SET NULL,
  agent_name                 VARCHAR(255) NOT NULL CHECK (BTRIM(agent_name) <> ''),
  title                      VARCHAR(500),
  status                     VARCHAR(32) NOT NULL DEFAULT 'running'
                             CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb
                             CHECK (jsonb_typeof(metadata) = 'object'),
  result                     JSONB NOT NULL DEFAULT '{}'::jsonb
                             CHECK (jsonb_typeof(result) = 'object'),
  error_message              TEXT,
  latest_checkpoint_sequence INTEGER NOT NULL DEFAULT 0
                             CHECK (latest_checkpoint_sequence >= 0),
  latest_checkpoint_at       TIMESTAMPTZ,
  started_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at                TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_runs_finished_status_check CHECK (
    (status = 'running' AND finished_at IS NULL)
    OR (status <> 'running' AND finished_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS run_checkpoints (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence   INTEGER NOT NULL CHECK (sequence > 0),
  summary    TEXT,
  state      JSONB NOT NULL DEFAULT '{}'::jsonb
             CHECK (jsonb_typeof(state) = 'object'),
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb
             CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT run_checkpoints_run_sequence_unique UNIQUE (run_id, sequence)
);

CREATE OR REPLACE FUNCTION bump_knowledge_revision() RETURNS trigger AS $$
DECLARE
  old_payload JSONB;
  new_payload JSONB;
BEGIN
  old_payload := to_jsonb(OLD) - ARRAY['revision', 'updated_at'];
  new_payload := to_jsonb(NEW) - ARRAY['revision', 'updated_at'];

  -- A semantic no-op (identical payload ignoring revision bookkeeping) keeps
  -- its revision so it does not invalidate the search index. updated_at is
  -- deliberately excluded: every mutation sets it, so including it would make
  -- this branch unreachable.
  IF new_payload IS DISTINCT FROM old_payload THEN
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := clock_timestamp();
  ELSE
    NEW.revision := OLD.revision;
    NEW.updated_at := OLD.updated_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION canonical_knowledge_workspace_id(
  workspace_path TEXT,
  candidate JSONB
) RETURNS UUID AS $$
DECLARE
  resolved_workspace UUID;
BEGIN
  CASE workspace_path
    WHEN 'direct' THEN
      resolved_workspace := (candidate ->> 'workspace_id')::uuid;
    WHEN 'page' THEN
      SELECT workspace_id INTO resolved_workspace
      FROM pages
      WHERE id = (candidate ->> 'page_id')::uuid;
    WHEN 'database' THEN
      SELECT workspace_id INTO resolved_workspace
      FROM databases
      WHERE id = (candidate ->> 'database_id')::uuid;
    WHEN 'row' THEN
      SELECT database_record.workspace_id INTO resolved_workspace
      FROM database_rows AS row_record
      JOIN databases AS database_record
        ON database_record.id = row_record.database_id
      WHERE row_record.id = (candidate ->> 'row_id')::uuid;
    ELSE
      RAISE EXCEPTION 'Unsupported canonical knowledge path %', workspace_path;
  END CASE;

  RETURN resolved_workspace;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION record_workspace_search_change() RETURNS trigger AS $$
DECLARE
  old_workspace UUID;
  new_workspace UUID;
BEGIN
  -- Revision triggers run first by name, so a semantic no-op has identical rows
  -- here and does not invalidate the search index.
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    old_workspace := canonical_knowledge_workspace_id(TG_ARGV[0], to_jsonb(OLD));
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_workspace := canonical_knowledge_workspace_id(TG_ARGV[0], to_jsonb(NEW));
  END IF;

  -- Journal rows become visible atomically with the canonical write. Exact
  -- per-workspace counts advance on commit without serializing writers.
  INSERT INTO workspace_search_changes (workspace_id)
  SELECT DISTINCT candidate.workspace_id
  FROM unnest(ARRAY[old_workspace, new_workspace]) AS candidate(workspace_id)
  JOIN workspaces w ON w.id = candidate.workspace_id
  WHERE candidate.workspace_id IS NOT NULL
  ORDER BY candidate.workspace_id;

  -- An indirect parent can already be invisible during an ON DELETE CASCADE.
  -- Its canonical ancestor has its own trigger, so a missing resolution is a
  -- safe no-op and the cascade must remain able to complete.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION lock_active_workspace_for_child_write() RETURNS trigger AS $$
DECLARE
  child_workspace UUID;
  locked_workspace UUID;
BEGIN
  CASE TG_ARGV[0]
    WHEN 'direct' THEN
      child_workspace := NEW.workspace_id;
    WHEN 'page' THEN
      SELECT workspace_id INTO child_workspace
      FROM pages
      WHERE id = NEW.page_id;
    WHEN 'database' THEN
      SELECT workspace_id INTO child_workspace
      FROM databases
      WHERE id = NEW.database_id;
    WHEN 'row' THEN
      SELECT database_record.workspace_id INTO child_workspace
      FROM database_rows AS row_record
      JOIN databases AS database_record
        ON database_record.id = row_record.database_id
      WHERE row_record.id = NEW.row_id;
    WHEN 'run' THEN
      SELECT workspace_id INTO child_workspace
      FROM agent_runs
      WHERE id = NEW.run_id;
    ELSE
      RAISE EXCEPTION 'Unsupported workspace lock path % for table %', TG_ARGV[0], TG_TABLE_NAME;
  END CASE;

  IF child_workspace IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve workspace for write to %', TG_TABLE_NAME;
  END IF;

  SELECT id INTO locked_workspace
  FROM workspaces
  WHERE id = child_workspace
    AND archived_at IS NULL
  FOR SHARE;

  IF locked_workspace IS NULL THEN
    RAISE EXCEPTION 'Workspace % does not exist or is archived', child_workspace;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_page_scope() RETURNS trigger AS $$
DECLARE
  parent_workspace UUID;
  session_workspace UUID;
BEGIN
  IF NEW.parent_page_id IS NOT NULL THEN
    SELECT workspace_id INTO parent_workspace
    FROM pages
    WHERE id = NEW.parent_page_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Parent page % does not exist', NEW.parent_page_id;
    END IF;

    IF parent_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Nested page workspace_id must match parent workspace_id';
    END IF;
  END IF;

  IF NEW.session_id IS NOT NULL THEN
    SELECT workspace_id INTO session_workspace
    FROM sessions
    WHERE id = NEW.session_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Session % does not exist', NEW.session_id;
    END IF;

    IF session_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Page session_id must belong to the page workspace_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_database_parent_workspace() RETURNS trigger AS $$
DECLARE
  parent_workspace UUID;
BEGIN
  IF NEW.parent_page_id IS NOT NULL THEN
    SELECT workspace_id INTO parent_workspace
    FROM pages
    WHERE id = NEW.parent_page_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Parent page % does not exist', NEW.parent_page_id;
    END IF;

    IF parent_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Database workspace_id must match parent page workspace_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_database_row_value_property_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM database_rows AS row_record
    JOIN database_properties AS property_record
      ON property_record.database_id = row_record.database_id
    WHERE row_record.id = NEW.row_id
      AND property_record.id = NEW.property_id
  ) THEN
    RAISE EXCEPTION 'database_row_values row_id and property_id must belong to the same database';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_agent_run_scope() RETURNS trigger AS $$
DECLARE
  session_workspace UUID;
BEGIN
  IF NEW.session_id IS NOT NULL THEN
    SELECT workspace_id INTO session_workspace
    FROM sessions
    WHERE id = NEW.session_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Session % does not exist', NEW.session_id;
    END IF;

    IF session_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Run session_id must belong to the run workspace_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION allocate_issue_identity() RETURNS trigger AS $$
DECLARE
  project_record issue_projects%ROWTYPE;
BEGIN
  SELECT * INTO project_record
  FROM issue_projects
  WHERE id = NEW.project_id AND archived_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Issue Project % does not exist or is archived', NEW.project_id;
  END IF;

  IF NEW.issue_number IS NULL THEN
    NEW.issue_number := project_record.next_issue_number;
  END IF;
  NEW.issue_key := project_record.project_key || '-' || NEW.issue_number::text;

  UPDATE issue_projects
  SET next_issue_number = GREATEST(next_issue_number, NEW.issue_number + 1)
  WHERE id = NEW.project_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_issue_identity_immutability() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.issue_number IS DISTINCT FROM OLD.issue_number
     OR NEW.issue_key IS DISTINCT FROM OLD.issue_key THEN
    RAISE EXCEPTION 'Issue project, number, and key are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_issue_parent() RETURNS trigger AS $$
DECLARE
  parent_project UUID;
BEGIN
  IF NEW.parent_issue_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT project_id INTO parent_project
  FROM issues
  WHERE id = NEW.parent_issue_id AND archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Parent Issue % does not exist or is archived', NEW.parent_issue_id;
  END IF;
  IF parent_project IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'Subtask and parent must belong to the same Issue Project';
  END IF;
  IF NEW.id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors(id, parent_issue_id) AS (
      SELECT id, parent_issue_id FROM issues WHERE id = NEW.parent_issue_id
      UNION ALL
      SELECT candidate.id, candidate.parent_issue_id
      FROM issues candidate
      JOIN ancestors current ON candidate.id = current.parent_issue_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Issue parent relationship would create a cycle';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION lock_active_issue_project_for_write() RETURNS trigger AS $$
DECLARE
  resolved_project UUID;
BEGIN
  IF TG_TABLE_NAME = 'issues' THEN
    resolved_project := NEW.project_id;
  ELSIF TG_TABLE_NAME = 'issue_comments' THEN
    SELECT project_id INTO resolved_project FROM issues
    WHERE id = NEW.issue_id AND archived_at IS NULL;
  ELSE
    RAISE EXCEPTION 'Unsupported Issue Project child table %', TG_TABLE_NAME;
  END IF;

  IF resolved_project IS NULL OR NOT EXISTS (
    SELECT 1 FROM issue_projects
    WHERE id = resolved_project AND archived_at IS NULL
    FOR SHARE
  ) THEN
    RAISE EXCEPTION 'Cannot write % under an archived or missing Issue Project', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_project_archive_with_active_issues() RETURNS trigger AS $$
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM issues WHERE project_id = NEW.id AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Issue Project % still has active Issues', NEW.id;
  END IF;
  IF NEW.project_key IS DISTINCT FROM OLD.project_key THEN
    RAISE EXCEPTION 'Issue Project key is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_issue_dependency() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM issues
    WHERE id = NEW.blocking_issue_id AND archived_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM issues
    WHERE id = NEW.blocked_issue_id AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Issue dependency endpoints must be active Issues';
  END IF;

  IF EXISTS (
    WITH RECURSIVE downstream(id) AS (
      SELECT NEW.blocked_issue_id
      UNION
      SELECT dependency.blocked_issue_id
      FROM issue_dependencies dependency
      JOIN downstream current ON dependency.blocking_issue_id = current.id
      WHERE dependency.archived_at IS NULL
        AND dependency.id IS DISTINCT FROM NEW.id
    )
    SELECT 1 FROM downstream WHERE id = NEW.blocking_issue_id
  ) THEN
    RAISE EXCEPTION 'Issue dependency would create a cycle';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION link_endpoint_workspace(
  endpoint_type TEXT,
  endpoint_id UUID
) RETURNS UUID AS $$
DECLARE
  endpoint_workspace UUID;
BEGIN
  CASE endpoint_type
    WHEN 'workspace' THEN
      SELECT id INTO endpoint_workspace
      FROM workspaces
      WHERE id = endpoint_id;
    WHEN 'page' THEN
      SELECT workspace_id INTO endpoint_workspace
      FROM pages
      WHERE id = endpoint_id;
    WHEN 'database' THEN
      SELECT workspace_id INTO endpoint_workspace
      FROM databases
      WHERE id = endpoint_id;
    WHEN 'row' THEN
      SELECT database_record.workspace_id INTO endpoint_workspace
      FROM database_rows AS row_record
      JOIN databases AS database_record ON database_record.id = row_record.database_id
      WHERE row_record.id = endpoint_id;
    WHEN 'block' THEN
      SELECT page_record.workspace_id INTO endpoint_workspace
      FROM blocks AS block_record
      JOIN pages AS page_record ON page_record.id = block_record.page_id
      WHERE block_record.id = endpoint_id;
    ELSE
      RETURN NULL;
  END CASE;

  RETURN endpoint_workspace;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION link_endpoint_active(
  endpoint_type TEXT,
  endpoint_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  CASE endpoint_type
    WHEN 'workspace' THEN
      RETURN EXISTS (SELECT 1 FROM workspaces WHERE id = endpoint_id AND archived_at IS NULL);
    WHEN 'page' THEN
      RETURN EXISTS (SELECT 1 FROM pages WHERE id = endpoint_id AND archived_at IS NULL);
    WHEN 'database' THEN
      RETURN EXISTS (SELECT 1 FROM databases WHERE id = endpoint_id AND archived_at IS NULL);
    WHEN 'row' THEN
      RETURN EXISTS (SELECT 1 FROM database_rows WHERE id = endpoint_id AND archived_at IS NULL);
    WHEN 'block' THEN
      RETURN EXISTS (SELECT 1 FROM blocks WHERE id = endpoint_id AND archived_at IS NULL);
    WHEN 'issue_project' THEN
      RETURN EXISTS (SELECT 1 FROM issue_projects WHERE id = endpoint_id AND archived_at IS NULL);
    WHEN 'issue' THEN
      RETURN EXISTS (
        SELECT 1 FROM issues candidate
        JOIN issue_projects project ON project.id = candidate.project_id
        WHERE candidate.id = endpoint_id
          AND candidate.archived_at IS NULL
          AND project.archived_at IS NULL
      );
    ELSE
      RETURN FALSE;
  END CASE;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION validate_link_targets() RETURNS trigger AS $$
DECLARE
  from_workspace UUID;
  to_workspace UUID;
BEGIN
  IF NOT link_endpoint_active(NEW.from_type, NEW.from_id) THEN
    RAISE EXCEPTION 'Invalid or archived link source %:%', NEW.from_type, NEW.from_id;
  END IF;
  IF NOT link_endpoint_active(NEW.to_type, NEW.to_id) THEN
    RAISE EXCEPTION 'Invalid or archived link target %:%', NEW.to_type, NEW.to_id;
  END IF;

  from_workspace := link_endpoint_workspace(NEW.from_type, NEW.from_id);
  to_workspace := link_endpoint_workspace(NEW.to_type, NEW.to_id);

  IF from_workspace IS NOT NULL AND to_workspace IS NOT NULL
     AND from_workspace IS DISTINCT FROM to_workspace THEN
    RAISE EXCEPTION 'Link endpoints must belong to the same workspace';
  END IF;

  IF NEW.workspace_id IS NOT NULL
     AND COALESCE(from_workspace, to_workspace) IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'Knowledge endpoint must belong to the supplied workspace';
  END IF;

  IF NEW.workspace_id IS NULL AND COALESCE(from_workspace, to_workspace) IS NOT NULL THEN
    NEW.workspace_id := COALESCE(from_workspace, to_workspace);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_link_immutability() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.from_type IS DISTINCT FROM OLD.from_type
     OR NEW.from_id IS DISTINCT FROM OLD.from_id
     OR NEW.to_type IS DISTINCT FROM OLD.to_type
     OR NEW.to_id IS DISTINCT FROM OLD.to_id
     OR NEW.link_type IS DISTINCT FROM OLD.link_type THEN
    RAISE EXCEPTION 'Link endpoints, workspace, and type are immutable';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION delete_links_for_endpoint() RETURNS trigger AS $$
BEGIN
  DELETE FROM record_links
  WHERE (from_type = TG_ARGV[0] AND from_id = OLD.id)
     OR (to_type = TG_ARGV[0] AND to_id = OLD.id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_workspaces_revision_trigger ON workspaces;
CREATE TRIGGER bump_workspaces_revision_trigger
BEFORE UPDATE ON workspaces
FOR EACH ROW EXECUTE FUNCTION bump_knowledge_revision();

DROP TRIGGER IF EXISTS bump_pages_revision_trigger ON pages;
CREATE TRIGGER bump_pages_revision_trigger
BEFORE UPDATE ON pages
FOR EACH ROW EXECUTE FUNCTION bump_knowledge_revision();

DROP TRIGGER IF EXISTS bump_blocks_revision_trigger ON blocks;
CREATE TRIGGER bump_blocks_revision_trigger
BEFORE UPDATE ON blocks
FOR EACH ROW EXECUTE FUNCTION bump_knowledge_revision();

DROP TRIGGER IF EXISTS bump_databases_revision_trigger ON databases;
CREATE TRIGGER bump_databases_revision_trigger
BEFORE UPDATE ON databases
FOR EACH ROW EXECUTE FUNCTION bump_knowledge_revision();

DROP TRIGGER IF EXISTS bump_database_properties_revision_trigger ON database_properties;
CREATE TRIGGER bump_database_properties_revision_trigger
BEFORE UPDATE ON database_properties
FOR EACH ROW EXECUTE FUNCTION bump_knowledge_revision();

DROP TRIGGER IF EXISTS bump_database_rows_revision_trigger ON database_rows;
CREATE TRIGGER bump_database_rows_revision_trigger
BEFORE UPDATE ON database_rows
FOR EACH ROW EXECUTE FUNCTION bump_knowledge_revision();

DROP TRIGGER IF EXISTS bump_issue_projects_revision_trigger ON issue_projects;
CREATE TRIGGER bump_issue_projects_revision_trigger
BEFORE UPDATE ON issue_projects
FOR EACH ROW EXECUTE FUNCTION bump_knowledge_revision();

DROP TRIGGER IF EXISTS bump_issues_revision_trigger ON issues;
CREATE TRIGGER bump_issues_revision_trigger
BEFORE UPDATE ON issues
FOR EACH ROW EXECUTE FUNCTION bump_knowledge_revision();

DROP TRIGGER IF EXISTS bump_issue_dependencies_revision_trigger ON issue_dependencies;
CREATE TRIGGER bump_issue_dependencies_revision_trigger
BEFORE UPDATE ON issue_dependencies
FOR EACH ROW EXECUTE FUNCTION bump_knowledge_revision();

DROP TRIGGER IF EXISTS bump_record_links_revision_trigger ON record_links;
CREATE TRIGGER bump_record_links_revision_trigger
BEFORE UPDATE ON record_links
FOR EACH ROW EXECUTE FUNCTION bump_knowledge_revision();

DROP TRIGGER IF EXISTS record_workspace_search_change_pages_trigger ON pages;
CREATE TRIGGER record_workspace_search_change_pages_trigger
BEFORE INSERT OR UPDATE OR DELETE ON pages
FOR EACH ROW EXECUTE FUNCTION record_workspace_search_change('direct');

DROP TRIGGER IF EXISTS record_workspace_search_change_blocks_trigger ON blocks;
CREATE TRIGGER record_workspace_search_change_blocks_trigger
BEFORE INSERT OR UPDATE OR DELETE ON blocks
FOR EACH ROW EXECUTE FUNCTION record_workspace_search_change('page');

DROP TRIGGER IF EXISTS record_workspace_search_change_databases_trigger ON databases;
CREATE TRIGGER record_workspace_search_change_databases_trigger
BEFORE INSERT OR UPDATE OR DELETE ON databases
FOR EACH ROW EXECUTE FUNCTION record_workspace_search_change('direct');

DROP TRIGGER IF EXISTS record_workspace_search_change_database_properties_trigger
ON database_properties;
CREATE TRIGGER record_workspace_search_change_database_properties_trigger
BEFORE INSERT OR UPDATE OR DELETE ON database_properties
FOR EACH ROW EXECUTE FUNCTION record_workspace_search_change('database');

DROP TRIGGER IF EXISTS record_workspace_search_change_database_rows_trigger
ON database_rows;
CREATE TRIGGER record_workspace_search_change_database_rows_trigger
BEFORE INSERT OR UPDATE OR DELETE ON database_rows
FOR EACH ROW EXECUTE FUNCTION record_workspace_search_change('database');

DROP TRIGGER IF EXISTS record_workspace_search_change_database_row_values_trigger
ON database_row_values;
CREATE TRIGGER record_workspace_search_change_database_row_values_trigger
BEFORE INSERT OR UPDATE OR DELETE ON database_row_values
FOR EACH ROW EXECUTE FUNCTION record_workspace_search_change('row');

DROP TRIGGER IF EXISTS lock_active_workspace_sessions_trigger ON sessions;
CREATE TRIGGER lock_active_workspace_sessions_trigger
BEFORE INSERT OR UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION lock_active_workspace_for_child_write('direct');

DROP TRIGGER IF EXISTS lock_active_workspace_pages_trigger ON pages;
CREATE TRIGGER lock_active_workspace_pages_trigger
BEFORE INSERT OR UPDATE ON pages
FOR EACH ROW EXECUTE FUNCTION lock_active_workspace_for_child_write('direct');

DROP TRIGGER IF EXISTS lock_active_workspace_blocks_trigger ON blocks;
CREATE TRIGGER lock_active_workspace_blocks_trigger
BEFORE INSERT OR UPDATE ON blocks
FOR EACH ROW EXECUTE FUNCTION lock_active_workspace_for_child_write('page');

DROP TRIGGER IF EXISTS lock_active_workspace_databases_trigger ON databases;
CREATE TRIGGER lock_active_workspace_databases_trigger
BEFORE INSERT OR UPDATE ON databases
FOR EACH ROW EXECUTE FUNCTION lock_active_workspace_for_child_write('direct');

DROP TRIGGER IF EXISTS lock_active_workspace_database_properties_trigger ON database_properties;
CREATE TRIGGER lock_active_workspace_database_properties_trigger
BEFORE INSERT OR UPDATE ON database_properties
FOR EACH ROW EXECUTE FUNCTION lock_active_workspace_for_child_write('database');

DROP TRIGGER IF EXISTS lock_active_workspace_database_rows_trigger ON database_rows;
CREATE TRIGGER lock_active_workspace_database_rows_trigger
BEFORE INSERT OR UPDATE ON database_rows
FOR EACH ROW EXECUTE FUNCTION lock_active_workspace_for_child_write('database');

DROP TRIGGER IF EXISTS lock_active_workspace_database_row_values_trigger ON database_row_values;
CREATE TRIGGER lock_active_workspace_database_row_values_trigger
BEFORE INSERT OR UPDATE ON database_row_values
FOR EACH ROW EXECUTE FUNCTION lock_active_workspace_for_child_write('row');

DROP TRIGGER IF EXISTS lock_active_workspace_agent_runs_trigger ON agent_runs;
CREATE TRIGGER lock_active_workspace_agent_runs_trigger
BEFORE INSERT OR UPDATE ON agent_runs
FOR EACH ROW EXECUTE FUNCTION lock_active_workspace_for_child_write('direct');

DROP TRIGGER IF EXISTS lock_active_workspace_run_checkpoints_trigger ON run_checkpoints;
CREATE TRIGGER lock_active_workspace_run_checkpoints_trigger
BEFORE INSERT OR UPDATE ON run_checkpoints
FOR EACH ROW EXECUTE FUNCTION lock_active_workspace_for_child_write('run');

DROP TRIGGER IF EXISTS validate_page_scope_trigger ON pages;
CREATE TRIGGER validate_page_scope_trigger
BEFORE INSERT OR UPDATE OF workspace_id, session_id, parent_page_id ON pages
FOR EACH ROW EXECUTE FUNCTION validate_page_scope();

DROP TRIGGER IF EXISTS validate_database_parent_workspace_trigger ON databases;
CREATE TRIGGER validate_database_parent_workspace_trigger
BEFORE INSERT OR UPDATE OF workspace_id, parent_page_id ON databases
FOR EACH ROW EXECUTE FUNCTION validate_database_parent_workspace();

DROP TRIGGER IF EXISTS validate_database_row_value_property_scope_trigger ON database_row_values;
CREATE TRIGGER validate_database_row_value_property_scope_trigger
BEFORE INSERT OR UPDATE OF row_id, property_id ON database_row_values
FOR EACH ROW EXECUTE FUNCTION validate_database_row_value_property_scope();

DROP TRIGGER IF EXISTS validate_agent_run_scope_trigger ON agent_runs;
CREATE TRIGGER validate_agent_run_scope_trigger
BEFORE INSERT OR UPDATE OF workspace_id, session_id ON agent_runs
FOR EACH ROW EXECUTE FUNCTION validate_agent_run_scope();

DROP TRIGGER IF EXISTS allocate_issue_identity_trigger ON issues;
CREATE TRIGGER allocate_issue_identity_trigger
BEFORE INSERT ON issues
FOR EACH ROW EXECUTE FUNCTION allocate_issue_identity();

DROP TRIGGER IF EXISTS enforce_issue_identity_immutability_trigger ON issues;
CREATE TRIGGER enforce_issue_identity_immutability_trigger
BEFORE UPDATE ON issues
FOR EACH ROW EXECUTE FUNCTION enforce_issue_identity_immutability();

DROP TRIGGER IF EXISTS validate_issue_parent_trigger ON issues;
CREATE TRIGGER validate_issue_parent_trigger
BEFORE INSERT OR UPDATE OF project_id, parent_issue_id ON issues
FOR EACH ROW EXECUTE FUNCTION validate_issue_parent();

DROP TRIGGER IF EXISTS lock_active_issue_project_issues_trigger ON issues;
CREATE TRIGGER lock_active_issue_project_issues_trigger
BEFORE INSERT OR UPDATE ON issues
FOR EACH ROW EXECUTE FUNCTION lock_active_issue_project_for_write();

DROP TRIGGER IF EXISTS lock_active_issue_project_comments_trigger ON issue_comments;
CREATE TRIGGER lock_active_issue_project_comments_trigger
BEFORE INSERT ON issue_comments
FOR EACH ROW EXECUTE FUNCTION lock_active_issue_project_for_write();

DROP TRIGGER IF EXISTS prevent_project_archive_with_active_issues_trigger ON issue_projects;
CREATE TRIGGER prevent_project_archive_with_active_issues_trigger
BEFORE UPDATE OF archived_at, project_key ON issue_projects
FOR EACH ROW EXECUTE FUNCTION prevent_project_archive_with_active_issues();

DROP TRIGGER IF EXISTS validate_issue_dependency_trigger ON issue_dependencies;
CREATE TRIGGER validate_issue_dependency_trigger
BEFORE INSERT OR UPDATE OF blocking_issue_id, blocked_issue_id, archived_at ON issue_dependencies
FOR EACH ROW EXECUTE FUNCTION validate_issue_dependency();

DROP TRIGGER IF EXISTS validate_link_targets_trigger ON record_links;
CREATE TRIGGER validate_link_targets_trigger
BEFORE INSERT OR UPDATE OF workspace_id, from_type, from_id, to_type, to_id ON record_links
FOR EACH ROW EXECUTE FUNCTION validate_link_targets();

DROP TRIGGER IF EXISTS enforce_link_immutability_trigger ON record_links;
CREATE TRIGGER enforce_link_immutability_trigger
BEFORE UPDATE ON record_links
FOR EACH ROW EXECUTE FUNCTION enforce_link_immutability();

DROP TRIGGER IF EXISTS delete_workspace_links_trigger ON workspaces;
CREATE TRIGGER delete_workspace_links_trigger
AFTER DELETE ON workspaces
FOR EACH ROW EXECUTE FUNCTION delete_links_for_endpoint('workspace');

DROP TRIGGER IF EXISTS delete_page_links_trigger ON pages;
CREATE TRIGGER delete_page_links_trigger
AFTER DELETE ON pages
FOR EACH ROW EXECUTE FUNCTION delete_links_for_endpoint('page');

DROP TRIGGER IF EXISTS delete_database_links_trigger ON databases;
CREATE TRIGGER delete_database_links_trigger
AFTER DELETE ON databases
FOR EACH ROW EXECUTE FUNCTION delete_links_for_endpoint('database');

DROP TRIGGER IF EXISTS delete_row_links_trigger ON database_rows;
CREATE TRIGGER delete_row_links_trigger
AFTER DELETE ON database_rows
FOR EACH ROW EXECUTE FUNCTION delete_links_for_endpoint('row');

DROP TRIGGER IF EXISTS delete_block_links_trigger ON blocks;
CREATE TRIGGER delete_block_links_trigger
AFTER DELETE ON blocks
FOR EACH ROW EXECUTE FUNCTION delete_links_for_endpoint('block');

DROP TRIGGER IF EXISTS delete_issue_project_links_trigger ON issue_projects;
CREATE TRIGGER delete_issue_project_links_trigger
AFTER DELETE ON issue_projects
FOR EACH ROW EXECUTE FUNCTION delete_links_for_endpoint('issue_project');

DROP TRIGGER IF EXISTS delete_issue_links_trigger ON issues;
CREATE TRIGGER delete_issue_links_trigger
AFTER DELETE ON issues
FOR EACH ROW EXECUTE FUNCTION delete_links_for_endpoint('issue');

CREATE INDEX IF NOT EXISTS workspaces_created_idx
  ON workspaces(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_name_active_idx
  ON workspaces(LOWER(BTRIM(name)))
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS workspace_search_changes_workspace_idx
  ON workspace_search_changes(workspace_id);

CREATE INDEX IF NOT EXISTS sessions_workspace_last_activity_idx
  ON sessions(workspace_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS sessions_workspace_status_idx
  ON sessions(workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS pages_workspace_updated_idx
  ON pages(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS pages_session_updated_idx
  ON pages(session_id, updated_at DESC)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pages_parent_updated_idx
  ON pages(parent_page_id, updated_at DESC)
  WHERE parent_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pages_tags_gin_idx
  ON pages USING GIN(tags);
CREATE INDEX IF NOT EXISTS pages_title_fts_idx
  ON pages USING GIN(to_tsvector('simple', title));
CREATE INDEX IF NOT EXISTS pages_title_trgm_idx
  ON pages USING GIN(title gin_trgm_ops);

CREATE UNIQUE INDEX IF NOT EXISTS blocks_page_position_active_idx
  ON blocks(page_id, position)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS blocks_content_fts_idx
  ON blocks USING GIN(to_tsvector('simple', content));
CREATE INDEX IF NOT EXISTS blocks_content_trgm_idx
  ON blocks USING GIN(content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS databases_workspace_created_idx
  ON databases(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS databases_parent_idx
  ON databases(parent_page_id)
  WHERE parent_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS databases_tags_gin_idx
  ON databases USING GIN(tags);
CREATE INDEX IF NOT EXISTS databases_name_trgm_idx
  ON databases USING GIN(name gin_trgm_ops);

CREATE UNIQUE INDEX IF NOT EXISTS database_properties_name_active_idx
  ON database_properties(database_id, LOWER(BTRIM(name)))
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS database_properties_position_active_idx
  ON database_properties(database_id, position)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS database_properties_title_active_idx
  ON database_properties(database_id)
  WHERE archived_at IS NULL AND property_type = 'title';
CREATE INDEX IF NOT EXISTS database_properties_name_fts_idx
  ON database_properties USING GIN(to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS database_properties_name_trgm_idx
  ON database_properties USING GIN(name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS database_rows_database_created_idx
  ON database_rows(database_id, created_at DESC);
CREATE INDEX IF NOT EXISTS database_rows_database_updated_idx
  ON database_rows(database_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS database_rows_tags_gin_idx
  ON database_rows USING GIN(tags);
CREATE INDEX IF NOT EXISTS database_row_values_row_idx
  ON database_row_values(row_id);
CREATE INDEX IF NOT EXISTS database_row_values_property_idx
  ON database_row_values(property_id);
CREATE INDEX IF NOT EXISTS database_row_values_fts_idx
  ON database_row_values USING GIN(
    to_tsvector(
      'simple',
      database_row_value_search_text(
        value_text,
        value_json,
        value_number,
        value_date,
        value_bool
      )
    )
  );
CREATE INDEX IF NOT EXISTS database_row_values_text_trgm_idx
  ON database_row_values USING GIN(value_text gin_trgm_ops)
  WHERE value_text IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS issue_projects_key_idx
  ON issue_projects(project_key);
CREATE UNIQUE INDEX IF NOT EXISTS issue_projects_name_active_idx
  ON issue_projects(LOWER(BTRIM(name)))
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS issues_project_updated_idx
  ON issues(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS issues_project_status_idx
  ON issues(project_id, status, updated_at DESC)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS issues_parent_idx
  ON issues(parent_issue_id, updated_at DESC)
  WHERE parent_issue_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS issues_assignee_idx
  ON issues(assignee, updated_at DESC)
  WHERE assignee IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS issues_tags_gin_idx
  ON issues USING GIN(tags);
CREATE INDEX IF NOT EXISTS issues_text_fts_idx
  ON issues USING GIN(to_tsvector('simple', title || ' ' || COALESCE(description, '')));
CREATE INDEX IF NOT EXISTS issue_comments_issue_created_idx
  ON issue_comments(issue_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS issue_dependencies_active_idx
  ON issue_dependencies(blocking_issue_id, blocked_issue_id)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS issue_dependencies_blocked_idx
  ON issue_dependencies(blocked_issue_id, created_at DESC)
  WHERE archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS record_links_active_relation_idx
  ON record_links(from_type, from_id, to_type, to_id, link_type)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS record_links_workspace_created_idx
  ON record_links(workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS record_links_from_idx
  ON record_links(from_type, from_id, created_at DESC);
CREATE INDEX IF NOT EXISTS record_links_to_idx
  ON record_links(to_type, to_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_runs_workspace_started_idx
  ON agent_runs(workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_session_started_idx
  ON agent_runs(session_id, started_at DESC)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_runs_agent_status_idx
  ON agent_runs(workspace_id, agent_name, status, started_at DESC);

CREATE INDEX IF NOT EXISTS run_checkpoints_run_created_idx
  ON run_checkpoints(run_id, created_at DESC);
