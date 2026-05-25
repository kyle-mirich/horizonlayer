DO $$
BEGIN
  IF EXISTS (
    SELECT database_id, LOWER(name)
    FROM database_properties
    GROUP BY database_id, LOWER(name)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add database_properties unique name index while duplicate property names exist';
  END IF;

  IF EXISTS (
    SELECT database_id, position
    FROM database_properties
    GROUP BY database_id, position
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add database_properties unique position index while duplicate positions exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS database_properties_database_id_lower_name_idx
  ON database_properties (database_id, LOWER(name));

CREATE UNIQUE INDEX IF NOT EXISTS database_properties_database_id_position_idx
  ON database_properties (database_id, position);
