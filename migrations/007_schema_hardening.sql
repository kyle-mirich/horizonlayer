-- Normalize users so OAuth identity columns are always populated.
UPDATE users
SET oidc_issuer = COALESCE(
      oidc_issuer,
      (
        SELECT i.provider_issuer
        FROM identities i
        WHERE i.user_id = users.id
          AND i.provider_subject IS NOT NULL
        ORDER BY i.created_at ASC
        LIMIT 1
      ),
      'system://migrated'
    ),
    oidc_subject = COALESCE(
      oidc_subject,
      (
        SELECT i.provider_subject
        FROM identities i
        WHERE i.user_id = users.id
          AND i.provider_subject IS NOT NULL
        ORDER BY i.created_at ASC
        LIMIT 1
      ),
      users.id::text
    )
WHERE oidc_issuer IS NULL OR oidc_subject IS NULL;

INSERT INTO users (
  email,
  primary_email,
  display_name,
  avatar_url,
  picture_url,
  status,
  last_login_at,
  oidc_issuer,
  oidc_subject
)
VALUES (
  NULL,
  NULL,
  'Legacy System Owner',
  NULL,
  NULL,
  'active',
  NOW(),
  'system://legacy',
  'workspace-owner'
)
ON CONFLICT (oidc_issuer, oidc_subject) DO NOTHING;

UPDATE workspaces
SET owner_user_id = (
  SELECT id
  FROM users
  WHERE oidc_issuer = 'system://legacy'
    AND oidc_subject = 'workspace-owner'
)
WHERE owner_user_id IS NULL;

ALTER TABLE users
  ALTER COLUMN oidc_issuer SET NOT NULL,
  ALTER COLUMN oidc_subject SET NOT NULL;

ALTER TABLE workspaces
  ALTER COLUMN owner_user_id SET NOT NULL;

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_owner_user_id_fkey;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE pages
  DROP CONSTRAINT IF EXISTS pages_parent_page_self_check;

ALTER TABLE pages
  ADD CONSTRAINT pages_parent_page_self_check
  CHECK (parent_page_id IS NULL OR parent_page_id <> id);

ALTER TABLE databases
  DROP CONSTRAINT IF EXISTS databases_parent_page_requires_workspace_check;

ALTER TABLE databases
  ADD CONSTRAINT databases_parent_page_requires_workspace_check
  CHECK (parent_page_id IS NULL OR workspace_id IS NOT NULL);

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY position, created_at, id) - 1 AS new_position
  FROM blocks
)
UPDATE blocks b
SET position = ranked.new_position
FROM ranked
WHERE b.id = ranked.id
  AND b.position IS DISTINCT FROM ranked.new_position;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY database_id ORDER BY position, created_at, id) - 1 AS new_position
  FROM database_properties
)
UPDATE database_properties p
SET position = ranked.new_position
FROM ranked
WHERE p.id = ranked.id
  AND p.position IS DISTINCT FROM ranked.new_position;

CREATE UNIQUE INDEX IF NOT EXISTS blocks_page_position_unique_idx
  ON blocks(page_id, position);

CREATE UNIQUE INDEX IF NOT EXISTS database_properties_db_position_unique_idx
  ON database_properties(database_id, position);

CREATE UNIQUE INDEX IF NOT EXISTS links_unique_relation_idx
  ON links(from_type, from_id, to_type, to_id, link_type);

ALTER TABLE links
  DROP CONSTRAINT IF EXISTS links_from_type_check;

ALTER TABLE links
  ADD CONSTRAINT links_from_type_check
  CHECK (from_type IN ('workspace', 'page', 'row', 'database', 'block', 'database_row'));

ALTER TABLE links
  DROP CONSTRAINT IF EXISTS links_to_type_check;

ALTER TABLE links
  ADD CONSTRAINT links_to_type_check
  CHECK (to_type IN ('workspace', 'page', 'row', 'database', 'block', 'database_row'));

CREATE OR REPLACE FUNCTION validate_page_workspace_consistency() RETURNS trigger AS $$
DECLARE
  parent_workspace UUID;
BEGIN
  IF NEW.parent_page_id IS NOT NULL THEN
    SELECT workspace_id
      INTO parent_workspace
      FROM pages
     WHERE id = NEW.parent_page_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Parent page % does not exist', NEW.parent_page_id;
    END IF;

    IF NEW.workspace_id IS NULL THEN
      RAISE EXCEPTION 'Nested pages must have a workspace_id';
    END IF;

    IF parent_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Nested page workspace_id must match parent workspace_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_page_workspace_consistency_trigger ON pages;
CREATE TRIGGER validate_page_workspace_consistency_trigger
BEFORE INSERT OR UPDATE ON pages
FOR EACH ROW
EXECUTE FUNCTION validate_page_workspace_consistency();

CREATE OR REPLACE FUNCTION validate_database_parent_workspace() RETURNS trigger AS $$
DECLARE
  parent_workspace UUID;
BEGIN
  IF NEW.parent_page_id IS NOT NULL THEN
    SELECT workspace_id
      INTO parent_workspace
      FROM pages
     WHERE id = NEW.parent_page_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Parent page % does not exist', NEW.parent_page_id;
    END IF;

    IF NEW.workspace_id IS NULL THEN
      RAISE EXCEPTION 'Databases attached to pages must have a workspace_id';
    END IF;

    IF parent_workspace IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'Database workspace_id must match parent page workspace_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_database_parent_workspace_trigger ON databases;
CREATE TRIGGER validate_database_parent_workspace_trigger
BEFORE INSERT OR UPDATE ON databases
FOR EACH ROW
EXECUTE FUNCTION validate_database_parent_workspace();

CREATE OR REPLACE FUNCTION validate_database_row_value_property_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM database_rows r
      JOIN database_properties p
        ON p.database_id = r.database_id
     WHERE r.id = NEW.row_id
       AND p.id = NEW.property_id
  ) THEN
    RAISE EXCEPTION 'database_row_values row_id and property_id must belong to the same database';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_database_row_value_property_scope_trigger ON database_row_values;
CREATE TRIGGER validate_database_row_value_property_scope_trigger
BEFORE INSERT OR UPDATE ON database_row_values
FOR EACH ROW
EXECUTE FUNCTION validate_database_row_value_property_scope();

CREATE OR REPLACE FUNCTION validate_link_endpoint_exists(item_type TEXT, item_id UUID) RETURNS BOOLEAN AS $$
BEGIN
  CASE item_type
    WHEN 'workspace' THEN
      RETURN EXISTS (SELECT 1 FROM workspaces WHERE id = item_id);
    WHEN 'page' THEN
      RETURN EXISTS (SELECT 1 FROM pages WHERE id = item_id);
    WHEN 'database' THEN
      RETURN EXISTS (SELECT 1 FROM databases WHERE id = item_id);
    WHEN 'row' THEN
      RETURN EXISTS (SELECT 1 FROM database_rows WHERE id = item_id);
    WHEN 'database_row' THEN
      RETURN EXISTS (SELECT 1 FROM database_rows WHERE id = item_id);
    WHEN 'block' THEN
      RETURN EXISTS (SELECT 1 FROM blocks WHERE id = item_id);
    ELSE
      RETURN FALSE;
  END CASE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_link_targets() RETURNS trigger AS $$
BEGIN
  IF NOT validate_link_endpoint_exists(NEW.from_type, NEW.from_id) THEN
    RAISE EXCEPTION 'Invalid link source %:%', NEW.from_type, NEW.from_id;
  END IF;

  IF NOT validate_link_endpoint_exists(NEW.to_type, NEW.to_id) THEN
    RAISE EXCEPTION 'Invalid link target %:%', NEW.to_type, NEW.to_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_link_targets_trigger ON links;
CREATE TRIGGER validate_link_targets_trigger
BEFORE INSERT OR UPDATE ON links
FOR EACH ROW
EXECUTE FUNCTION validate_link_targets();
