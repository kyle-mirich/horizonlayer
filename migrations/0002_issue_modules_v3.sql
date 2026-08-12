CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY CHECK (version > 0),
  name       TEXT NOT NULL CHECK (BTRIM(name) <> ''),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF to_regclass('record_links') IS NULL AND to_regclass('links') IS NOT NULL THEN
    ALTER TABLE links RENAME TO record_links;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS bump_links_revision_trigger ON record_links;
DROP TRIGGER IF EXISTS lock_active_workspace_links_trigger ON record_links;
DROP TRIGGER IF EXISTS validate_link_targets_trigger ON record_links;
DROP TRIGGER IF EXISTS enforce_link_immutability_trigger ON record_links;

ALTER TABLE record_links ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE record_links DROP CONSTRAINT IF EXISTS links_from_type_check;
ALTER TABLE record_links DROP CONSTRAINT IF EXISTS links_to_type_check;
ALTER TABLE record_links ADD CONSTRAINT record_links_from_type_check CHECK (
  from_type IN ('workspace', 'page', 'database', 'row', 'block', 'issue_project', 'issue')
);
ALTER TABLE record_links ADD CONSTRAINT record_links_to_type_check CHECK (
  to_type IN ('workspace', 'page', 'database', 'row', 'block', 'issue_project', 'issue')
);

INSERT INTO schema_migrations (version, name)
VALUES (1, 'canonical-knowledge-v2')
ON CONFLICT (version) DO NOTHING;
