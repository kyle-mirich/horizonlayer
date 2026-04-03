CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(500) NOT NULL,
  description TEXT,
  icon        VARCHAR(100),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pages (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id     UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  parent_page_id   UUID REFERENCES pages(id) ON DELETE SET NULL,
  title            VARCHAR(500) NOT NULL DEFAULT 'Untitled',
  icon             VARCHAR(100),
  cover_url        TEXT,
  tags             TEXT[] DEFAULT '{}',
  source           VARCHAR(500),
  importance       FLOAT DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  expires_at       TIMESTAMPTZ,
  embedding        vector(384),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blocks (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  page_id    UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_type VARCHAR(50) NOT NULL,
  content    TEXT DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  metadata   JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS databases (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id   UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  parent_page_id UUID REFERENCES pages(id) ON DELETE SET NULL,
  name           VARCHAR(500) NOT NULL,
  description    TEXT,
  icon           VARCHAR(100),
  tags           TEXT[] DEFAULT '{}',
  source         VARCHAR(500),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS database_properties (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  database_id   UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  property_type VARCHAR(50) NOT NULL,
  options       JSONB DEFAULT '{}',
  position      INTEGER NOT NULL DEFAULT 0,
  is_required   BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS database_rows (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  database_id      UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  tags             TEXT[] DEFAULT '{}',
  source           VARCHAR(500),
  importance       FLOAT DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  expires_at       TIMESTAMPTZ,
  embedding        vector(384),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS database_row_values (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  row_id       UUID NOT NULL REFERENCES database_rows(id) ON DELETE CASCADE,
  property_id  UUID NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
  value_text   TEXT,
  value_number FLOAT,
  value_date   TIMESTAMPTZ,
  value_bool   BOOLEAN,
  value_json   JSONB,
  UNIQUE(row_id, property_id)
);

CREATE TABLE IF NOT EXISTS links (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_type  VARCHAR(20) NOT NULL,
  from_id    UUID NOT NULL,
  to_type    VARCHAR(20) NOT NULL,
  to_id      UUID NOT NULL,
  link_type  VARCHAR(100) DEFAULT 'related',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vector similarity indexes
CREATE INDEX IF NOT EXISTS pages_embedding_idx ON pages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS database_rows_embedding_idx ON database_rows USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Full-text search
CREATE INDEX IF NOT EXISTS pages_fts_idx ON pages USING GIN (to_tsvector('english', title));

-- Common query patterns
CREATE INDEX IF NOT EXISTS blocks_page_position_idx ON blocks(page_id, position);
CREATE INDEX IF NOT EXISTS db_props_db_position_idx ON database_properties(database_id, position);
CREATE INDEX IF NOT EXISTS row_values_row_idx ON database_row_values(row_id);
CREATE INDEX IF NOT EXISTS row_values_property_idx ON database_row_values(property_id);
CREATE INDEX IF NOT EXISTS links_from_idx ON links(from_type, from_id);
CREATE INDEX IF NOT EXISTS links_to_idx ON links(to_type, to_id);
CREATE INDEX IF NOT EXISTS pages_workspace_idx ON pages(workspace_id);
CREATE INDEX IF NOT EXISTS pages_parent_idx ON pages(parent_page_id);
CREATE INDEX IF NOT EXISTS pages_expires_idx ON pages(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS db_rows_database_idx ON database_rows(database_id);
CREATE INDEX IF NOT EXISTS db_rows_expires_idx ON database_rows(expires_at) WHERE expires_at IS NOT NULL;
