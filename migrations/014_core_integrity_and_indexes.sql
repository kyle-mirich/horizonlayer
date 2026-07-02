UPDATE pages SET tags = '{}' WHERE tags IS NULL;
UPDATE databases SET tags = '{}' WHERE tags IS NULL;
UPDATE database_rows SET tags = '{}' WHERE tags IS NULL;
UPDATE blocks SET metadata = '{}'::jsonb WHERE metadata IS NULL;
UPDATE database_properties SET options = '{}'::jsonb WHERE options IS NULL;

ALTER TABLE pages
  ALTER COLUMN tags SET NOT NULL;

ALTER TABLE databases
  ALTER COLUMN tags SET NOT NULL;

ALTER TABLE database_rows
  ALTER COLUMN tags SET NOT NULL;

ALTER TABLE blocks
  ALTER COLUMN metadata SET NOT NULL;

ALTER TABLE database_properties
  ALTER COLUMN options SET NOT NULL;

ALTER TABLE pages
  DROP CONSTRAINT IF EXISTS pages_tags_no_nulls_check,
  ADD CONSTRAINT pages_tags_no_nulls_check
  CHECK (array_position(tags, NULL) IS NULL) NOT VALID;

ALTER TABLE databases
  DROP CONSTRAINT IF EXISTS databases_tags_no_nulls_check,
  ADD CONSTRAINT databases_tags_no_nulls_check
  CHECK (array_position(tags, NULL) IS NULL) NOT VALID;

ALTER TABLE database_rows
  DROP CONSTRAINT IF EXISTS database_rows_tags_no_nulls_check,
  ADD CONSTRAINT database_rows_tags_no_nulls_check
  CHECK (array_position(tags, NULL) IS NULL) NOT VALID;

ALTER TABLE blocks
  DROP CONSTRAINT IF EXISTS blocks_position_check,
  ADD CONSTRAINT blocks_position_check
  CHECK (position >= 0) NOT VALID,
  DROP CONSTRAINT IF EXISTS blocks_metadata_object_check,
  ADD CONSTRAINT blocks_metadata_object_check
  CHECK (jsonb_typeof(metadata) = 'object') NOT VALID;

ALTER TABLE database_properties
  DROP CONSTRAINT IF EXISTS database_properties_position_check,
  ADD CONSTRAINT database_properties_position_check
  CHECK (position >= 0) NOT VALID,
  DROP CONSTRAINT IF EXISTS database_properties_options_object_check,
  ADD CONSTRAINT database_properties_options_object_check
  CHECK (jsonb_typeof(options) = 'object') NOT VALID;

ALTER TABLE database_row_values
  DROP CONSTRAINT IF EXISTS database_row_values_single_typed_value_check,
  ADD CONSTRAINT database_row_values_single_typed_value_check
  CHECK (
    ((value_text IS NOT NULL)::int
      + (value_number IS NOT NULL)::int
      + (value_date IS NOT NULL)::int
      + (value_bool IS NOT NULL)::int
      + (value_json IS NOT NULL)::int) <= 1
  ) NOT VALID;

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_metadata_object_check,
  ADD CONSTRAINT sessions_metadata_object_check
  CHECK (jsonb_typeof(metadata) = 'object') NOT VALID,
  DROP CONSTRAINT IF EXISTS sessions_closed_ended_at_check,
  ADD CONSTRAINT sessions_closed_ended_at_check
  CHECK (status <> 'closed' OR ended_at IS NOT NULL) NOT VALID;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_revision_check,
  ADD CONSTRAINT tasks_revision_check
  CHECK (revision >= 1) NOT VALID,
  DROP CONSTRAINT IF EXISTS tasks_metadata_object_check,
  ADD CONSTRAINT tasks_metadata_object_check
  CHECK (jsonb_typeof(metadata) = 'object') NOT VALID,
  DROP CONSTRAINT IF EXISTS tasks_required_ack_no_nulls_check,
  ADD CONSTRAINT tasks_required_ack_no_nulls_check
  CHECK (array_position(required_ack_agent_names, NULL) IS NULL) NOT VALID,
  DROP CONSTRAINT IF EXISTS tasks_claimed_lease_check,
  ADD CONSTRAINT tasks_claimed_lease_check
  CHECK (
    status <> 'claimed'
    OR (
      lease_owner_agent_name IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND heartbeat_at IS NOT NULL
    )
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS tasks_terminal_timestamp_check,
  ADD CONSTRAINT tasks_terminal_timestamp_check
  CHECK (
    (status <> 'done' OR completed_at IS NOT NULL)
    AND (status <> 'failed' OR failed_at IS NOT NULL)
    AND (status <> 'cancelled' OR cancelled_at IS NOT NULL)
  ) NOT VALID;

ALTER TABLE task_events
  DROP CONSTRAINT IF EXISTS task_events_payload_object_check,
  ADD CONSTRAINT task_events_payload_object_check
  CHECK (jsonb_typeof(payload) = 'object') NOT VALID;

ALTER TABLE task_acknowledgements
  DROP CONSTRAINT IF EXISTS task_acknowledgements_payload_object_check,
  ADD CONSTRAINT task_acknowledgements_payload_object_check
  CHECK (jsonb_typeof(payload) = 'object') NOT VALID;

ALTER TABLE agent_inbox
  DROP CONSTRAINT IF EXISTS agent_inbox_payload_object_check,
  ADD CONSTRAINT agent_inbox_payload_object_check
  CHECK (jsonb_typeof(payload) = 'object') NOT VALID;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_latest_checkpoint_sequence_check,
  ADD CONSTRAINT agent_runs_latest_checkpoint_sequence_check
  CHECK (latest_checkpoint_sequence >= 0) NOT VALID,
  DROP CONSTRAINT IF EXISTS agent_runs_metadata_object_check,
  ADD CONSTRAINT agent_runs_metadata_object_check
  CHECK (jsonb_typeof(metadata) = 'object') NOT VALID,
  DROP CONSTRAINT IF EXISTS agent_runs_result_object_check,
  ADD CONSTRAINT agent_runs_result_object_check
  CHECK (jsonb_typeof(result) = 'object') NOT VALID,
  DROP CONSTRAINT IF EXISTS agent_runs_finished_status_check,
  ADD CONSTRAINT agent_runs_finished_status_check
  CHECK (
    (status = 'running' AND finished_at IS NULL)
    OR (status <> 'running' AND finished_at IS NOT NULL)
  ) NOT VALID;

ALTER TABLE run_checkpoints
  DROP CONSTRAINT IF EXISTS run_checkpoints_sequence_check,
  ADD CONSTRAINT run_checkpoints_sequence_check
  CHECK (sequence > 0) NOT VALID,
  DROP CONSTRAINT IF EXISTS run_checkpoints_state_object_check,
  ADD CONSTRAINT run_checkpoints_state_object_check
  CHECK (jsonb_typeof(state) = 'object') NOT VALID,
  DROP CONSTRAINT IF EXISTS run_checkpoints_metadata_object_check,
  ADD CONSTRAINT run_checkpoints_metadata_object_check
  CHECK (jsonb_typeof(metadata) = 'object') NOT VALID;

CREATE OR REPLACE FUNCTION validate_page_session_workspace() RETURNS trigger AS $$
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

    IF NEW.workspace_id IS NULL THEN
      RAISE EXCEPTION 'Session-scoped pages must have a workspace_id';
    END IF;

    IF session_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Page session_id must belong to the page workspace_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_page_session_workspace_trigger ON pages;
CREATE TRIGGER validate_page_session_workspace_trigger
BEFORE INSERT OR UPDATE ON pages
FOR EACH ROW
EXECUTE FUNCTION validate_page_session_workspace();

CREATE OR REPLACE FUNCTION validate_task_session_workspace() RETURNS trigger AS $$
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
      RAISE EXCEPTION 'Task session_id must belong to the task workspace_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_task_session_workspace_trigger ON tasks;
CREATE TRIGGER validate_task_session_workspace_trigger
BEFORE INSERT OR UPDATE ON tasks
FOR EACH ROW
EXECUTE FUNCTION validate_task_session_workspace();

CREATE OR REPLACE FUNCTION validate_task_dependency_workspace() RETURNS trigger AS $$
DECLARE
  task_workspace UUID;
  dependency_workspace UUID;
BEGIN
  SELECT workspace_id INTO task_workspace FROM tasks WHERE id = NEW.task_id;
  SELECT workspace_id INTO dependency_workspace FROM tasks WHERE id = NEW.depends_on_task_id;

  IF task_workspace IS DISTINCT FROM dependency_workspace THEN
    RAISE EXCEPTION 'Task dependencies must stay within a single workspace';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_task_dependency_workspace_trigger ON task_dependencies;
CREATE TRIGGER validate_task_dependency_workspace_trigger
BEFORE INSERT OR UPDATE ON task_dependencies
FOR EACH ROW
EXECUTE FUNCTION validate_task_dependency_workspace();

CREATE OR REPLACE FUNCTION validate_task_event_workspace() RETURNS trigger AS $$
DECLARE
  task_workspace UUID;
BEGIN
  IF NEW.task_id IS NOT NULL THEN
    SELECT workspace_id INTO task_workspace
    FROM tasks
    WHERE id = NEW.task_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Task % does not exist', NEW.task_id;
    END IF;

    IF task_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Task event workspace_id must match task workspace_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_task_event_workspace_trigger ON task_events;
CREATE TRIGGER validate_task_event_workspace_trigger
BEFORE INSERT OR UPDATE ON task_events
FOR EACH ROW
EXECUTE FUNCTION validate_task_event_workspace();

CREATE OR REPLACE FUNCTION validate_agent_inbox_workspace() RETURNS trigger AS $$
DECLARE
  task_workspace UUID;
BEGIN
  IF NEW.task_id IS NOT NULL THEN
    SELECT workspace_id INTO task_workspace
    FROM tasks
    WHERE id = NEW.task_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Task % does not exist', NEW.task_id;
    END IF;

    IF task_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Inbox workspace_id must match task workspace_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_agent_inbox_workspace_trigger ON agent_inbox;
CREATE TRIGGER validate_agent_inbox_workspace_trigger
BEFORE INSERT OR UPDATE ON agent_inbox
FOR EACH ROW
EXECUTE FUNCTION validate_agent_inbox_workspace();

CREATE OR REPLACE FUNCTION validate_agent_run_scope() RETURNS trigger AS $$
DECLARE
  session_workspace UUID;
  task_workspace UUID;
  task_session UUID;
  parent_workspace UUID;
  parent_session UUID;
BEGIN
  IF NEW.parent_run_id IS NOT NULL AND NEW.parent_run_id = NEW.id THEN
    RAISE EXCEPTION 'Agent runs cannot parent themselves';
  END IF;

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

  IF NEW.task_id IS NOT NULL THEN
    SELECT workspace_id, session_id INTO task_workspace, task_session
    FROM tasks
    WHERE id = NEW.task_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Task % does not exist', NEW.task_id;
    END IF;

    IF task_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Run task_id must belong to the run workspace_id';
    END IF;

    IF task_session IS DISTINCT FROM NEW.session_id THEN
      RAISE EXCEPTION 'Run task_id must belong to the run session_id';
    END IF;
  END IF;

  IF NEW.parent_run_id IS NOT NULL THEN
    SELECT workspace_id, session_id INTO parent_workspace, parent_session
    FROM agent_runs
    WHERE id = NEW.parent_run_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Parent run % does not exist', NEW.parent_run_id;
    END IF;

    IF parent_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Parent run must belong to the run workspace_id';
    END IF;

    IF parent_session IS DISTINCT FROM NEW.session_id THEN
      RAISE EXCEPTION 'Parent run must belong to the run session_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_agent_run_scope_trigger ON agent_runs;
CREATE TRIGGER validate_agent_run_scope_trigger
BEFORE INSERT OR UPDATE ON agent_runs
FOR EACH ROW
EXECUTE FUNCTION validate_agent_run_scope();

CREATE INDEX IF NOT EXISTS pages_workspace_updated_idx
  ON pages(workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS pages_session_updated_idx
  ON pages(session_id, updated_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pages_tags_gin_idx
  ON pages USING GIN (tags);

CREATE INDEX IF NOT EXISTS databases_workspace_created_idx
  ON databases(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS databases_tags_gin_idx
  ON databases USING GIN (tags);

CREATE INDEX IF NOT EXISTS database_rows_tags_gin_idx
  ON database_rows USING GIN (tags);

CREATE INDEX IF NOT EXISTS tasks_session_status_priority_idx
  ON tasks(session_id, status, priority, created_at)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_workspace_last_event_idx
  ON tasks(workspace_id, last_event_at DESC);

CREATE INDEX IF NOT EXISTS tasks_session_last_event_idx
  ON tasks(session_id, last_event_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_runs_workspace_started_idx
  ON agent_runs(workspace_id, started_at DESC);

CREATE INDEX IF NOT EXISTS agent_runs_session_started_idx
  ON agent_runs(session_id, started_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS run_checkpoints_run_sequence_desc_idx
  ON run_checkpoints(run_id, sequence DESC);
