import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');

describe('clean schema contract', () => {
  it('defines the canonical knowledge tables directly', () => {
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS workspaces');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS pages');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS databases');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS agent_runs');
  });

  it('enforces normalized active workspace and property identities', () => {
    expect(schema).toContain('ON workspaces(LOWER(BTRIM(name)))');
    expect(schema).toContain('ON database_properties(database_id, LOWER(BTRIM(name)))');
    expect(schema).toMatch(
      /ON database_properties\(database_id\)\s+WHERE archived_at IS NULL AND property_type = 'title'/
    );
  });

  it('enforces the minimal typed-property and choice-option model', () => {
    const propertiesTable = schema.match(
      /CREATE TABLE IF NOT EXISTS database_properties \([\s\S]*?\n\);/
    )?.[0] ?? '';
    for (const type of ['title', 'text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url']) {
      expect(propertiesTable).toContain(`'${type}'`);
    }
    for (const removedType of ['email', 'phone', 'files', 'relation']) {
      expect(propertiesTable).not.toContain(`'${removedType}'`);
    }
    expect(propertiesTable).toContain('valid_database_property_options(property_type, options)');
    expect(propertiesTable).toContain("property_type IN (");
    expect(schema).toContain('jsonb_array_length(candidate_options -> \'choices\') > 100');
  });

  it('indexes every searchable row value and active property name', () => {
    const rowValueSearchFunction = schema.match(
      /CREATE OR REPLACE FUNCTION database_row_value_search_text\([\s\S]*?\$\$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;/
    )?.[0] ?? '';
    expect(rowValueSearchFunction).toContain("candidate_date AT TIME ZONE 'UTC'");
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS database_properties_name_fts_idx');
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS database_properties_name_trgm_idx');
    expect(schema).toMatch(
      /CREATE INDEX IF NOT EXISTS database_row_values_fts_idx[\s\S]*?database_row_value_search_text\([\s\S]*?value_date[\s\S]*?\)\s*\);/
    );
  });

  it('restricts block and link discriminants to the exported canonical values', () => {
    expect(schema).toContain("block_type IN ('text', 'heading', 'todo', 'callout', 'code')");
    expect(schema).toContain("from_type IN ('workspace', 'page', 'database', 'row', 'block')");
    expect(schema).toContain("to_type IN ('workspace', 'page', 'database', 'row', 'block')");
    const linksTable = schema.match(/CREATE TABLE IF NOT EXISTS links \([\s\S]*?\n\);/)?.[0] ?? '';
    expect(linksTable).not.toContain("'database_row'");
  });

  it('stores link scope, timestamps, and optimistic revisions', () => {
    const linksTable = schema.match(/CREATE TABLE IF NOT EXISTS links \([\s\S]*?\n\);/)?.[0] ?? '';
    expect(linksTable).toContain('workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE');
    expect(linksTable).toContain('revision    INTEGER NOT NULL DEFAULT 1');
    expect(linksTable).toContain('updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(schema).toContain('bump_links_revision_trigger');
    expect(schema).toContain('Link endpoints must belong to the supplied workspace');
    expect(schema).toContain('Link endpoints, workspace, and type are immutable');
    expect(schema).toContain('ON links(workspace_id, created_at DESC)');
  });

  it('journals canonical search changes without mutating workspace records', () => {
    const searchChangesTable = schema.match(
      /CREATE TABLE IF NOT EXISTS workspace_search_changes \([\s\S]*?\n\);/
    )?.[0] ?? '';
    expect(searchChangesTable).toContain(
      'change_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'
    );
    expect(searchChangesTable).toContain(
      'workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE'
    );
    expect(schema).toContain('CREATE OR REPLACE FUNCTION record_workspace_search_change()');
    expect(schema).toContain('workspace_search_changes_workspace_idx');
    expect(schema).not.toContain('search_generation BIGINT');

    const canonicalPaths = new Map([
      ['pages', 'direct'],
      ['blocks', 'page'],
      ['databases', 'direct'],
      ['database_properties', 'database'],
      ['database_rows', 'database'],
      ['database_row_values', 'row'],
    ]);
    for (const [table, path] of canonicalPaths) {
      expect(schema).toMatch(new RegExp(
        `CREATE TRIGGER record_workspace_search_change_${table}_trigger\\s+`
        + `BEFORE INSERT OR UPDATE OR DELETE ON ${table}\\s+`
        + `FOR EACH ROW EXECUTE FUNCTION record_workspace_search_change\\('${path}'\\)`
      ));
    }

    for (const operationalTable of ['sessions', 'links', 'agent_runs', 'run_checkpoints']) {
      expect(schema).not.toContain(
        `record_workspace_search_change_${operationalTable}_trigger`
      );
    }
    expect(schema).not.toContain('ALTER TABLE');
  });

  it('records cross-workspace changes transactionally without a shared counter lock', () => {
    const changeFunction = schema.match(
      /CREATE OR REPLACE FUNCTION record_workspace_search_change\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/
    )?.[0] ?? '';
    expect(changeFunction).toContain('to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD)');
    expect(changeFunction).toContain('INSERT INTO workspace_search_changes (workspace_id)');
    expect(changeFunction).toContain('ARRAY[old_workspace, new_workspace]');
    expect(changeFunction).toContain('JOIN workspaces w ON w.id = candidate.workspace_id');
    expect(changeFunction).toContain('ORDER BY candidate.workspace_id');
    expect(changeFunction).toContain('WHERE candidate.workspace_id IS NOT NULL');
    expect(changeFunction).not.toContain('UPDATE workspaces');

    // PostgreSQL runs same-kind triggers alphabetically: revision normalization
    // happens before the active-workspace guard and journal append.
    expect('bump_pages_revision_trigger' < 'lock_active_workspace_pages_trigger')
      .toBe(true);
    expect('lock_active_workspace_pages_trigger' < 'record_workspace_search_change_pages_trigger')
      .toBe(true);
  });

  it('serializes every child write with workspace archival', () => {
    expect(schema).toContain('CREATE OR REPLACE FUNCTION lock_active_workspace_for_child_write()');
    expect(schema).toMatch(
      /FROM workspaces\s+WHERE id = child_workspace\s+AND archived_at IS NULL\s+FOR SHARE/
    );

    for (const table of [
      'sessions',
      'pages',
      'blocks',
      'databases',
      'database_properties',
      'database_rows',
      'database_row_values',
      'links',
      'agent_runs',
      'run_checkpoints',
    ]) {
      expect(schema).toMatch(new RegExp(
        `CREATE TRIGGER lock_active_workspace_${table}_trigger\\s+`
        + `BEFORE INSERT OR UPDATE ON ${table}\\s+`
        + 'FOR EACH ROW EXECUTE FUNCTION lock_active_workspace_for_child_write'
      ));
    }
  });
});
