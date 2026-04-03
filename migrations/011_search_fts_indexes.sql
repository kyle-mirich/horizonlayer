CREATE INDEX IF NOT EXISTS blocks_content_fts_idx
  ON blocks USING GIN (to_tsvector('english', content));

CREATE INDEX IF NOT EXISTS database_row_values_fts_idx
  ON database_row_values USING GIN (
    to_tsvector(
      'english',
      COALESCE(value_text, value_json::text, value_number::text, value_bool::text, '')
    )
  );
