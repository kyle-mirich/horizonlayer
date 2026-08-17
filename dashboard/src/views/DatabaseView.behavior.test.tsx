// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DashboardApiClient } from '../api';
import { DashboardViewContext, type DashboardViewContextValue } from '../shell/DashboardContext';
import type { DatabaseProperty, DatabaseRow, DatabaseWithProperties, Workspace } from '../types';
import { DatabaseView } from './DatabaseView';

const NOW = '2026-07-22T00:00:00.000Z';
const workspace: Workspace = {
  archived_at: null, created_at: NOW, description: null, icon: null, id: 'workspace-1',
  name: 'Research', revision: 1, updated_at: NOW,
};
function property(overrides: Partial<DatabaseProperty>): DatabaseProperty {
  return {
    archived_at: null, created_at: NOW, database_id: 'database-1', id: 'property', name: 'Name', options: {},
    position: 0, property_type: 'title', revision: 1, updated_at: NOW, ...overrides,
  };
}
const nameProperty = property({ id: 'property-name' });
const scoreProperty = property({ id: 'property-score', name: 'Score', position: 1, property_type: 'number' });
const stageProperty = property({ id: 'property-stage', name: 'Stage', options: { choices: ['Planned', 'Done'] }, position: 2, property_type: 'select' });
const archivedProperty = property({ archived_at: NOW, id: 'property-old', name: 'Old', position: 3, property_type: 'text' });
const database: DatabaseWithProperties = {
  archived_at: null, created_at: NOW, description: 'Facts for agents', id: 'database-1', name: 'Research',
  parent_page_id: null, properties: [nameProperty, scoreProperty, stageProperty, archivedProperty], revision: 2,
  tags: ['shared'], updated_at: NOW, workspace_id: workspace.id,
};
const row: DatabaseRow = {
  archived_at: null, created_at: NOW, database_id: database.id, id: 'row-1', importance: 0.5, revision: 3,
  tags: ['source'], updated_at: NOW, values: { Name: 'Alpha', Score: 4, Stage: 'Planned' },
};
function success(action: string, result: unknown) {
  return { action, error: null, meta: {}, ok: true as const, result };
}

function deferred<Result>() {
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function renderView(options: {
  databaseImpl?: (input: Record<string, unknown>) => Promise<unknown>;
  databaseId?: string;
  rowId?: string;
  rowImpl?: (input: Record<string, unknown>) => Promise<unknown>;
  workspaceOverride?: Workspace;
} = {}) {
  let latestDatabase = database;
  const databaseMethod = vi.fn(options.databaseImpl ?? (async (input) => {
    switch (input.action) {
      case 'get': return success('get', latestDatabase);
      case 'update': {
        latestDatabase = { ...latestDatabase, ...input, properties: latestDatabase.properties, revision: latestDatabase.revision + 1 } as DatabaseWithProperties;
        return success('update', latestDatabase);
      }
      case 'archive': return success('archive', { ...latestDatabase, archived_at: NOW, revision: 10 });
      case 'restore': return success('restore', { ...latestDatabase, archived_at: null, revision: 11 });
      case 'property_add': return success('property_add', {
        database_revision: 4,
        property: property({ ...(input.property as Record<string, unknown>), id: 'property-added', position: 4 }),
      });
      case 'property_update': return success('property_update', {
        database_revision: 5,
        property: { ...scoreProperty, ...(input.name ? { name: input.name } : {}), ...(input.options ? { options: input.options } : {}) },
      });
      case 'property_archive': return success('property_archive', { database_revision: 6, property: { ...scoreProperty, archived_at: NOW } });
      case 'property_restore': return success('property_restore', { database_revision: 7, property: { ...archivedProperty, archived_at: null } });
      default: throw new Error(`Unexpected database ${String(input.action)}`);
    }
  }));
  const rowMethod = vi.fn(options.rowImpl ?? (async (input) => {
    if (input.action === 'query') {
      const offset = Number(input.offset ?? 0);
      return success('query', {
        items: offset === 0 ? [row] : [{ ...row, id: 'row-2', values: { ...row.values, Name: 'Beta' } }],
        page: { has_more: offset === 0, limit: 50, next_offset: offset === 0 ? 50 : null, offset },
        total: 51,
      });
    }
    if (input.action === 'get') return success('get', row);
    if (input.action === 'create') return success('create', { ...row, id: 'row-created', values: input.values });
    if (input.action === 'update') return success('update', { ...row, ...input, revision: row.revision + 1, values: { ...row.values, ...(input.values as object) } });
    if (input.action === 'archive') return success('archive', { ...row, archived_at: NOW, revision: 4 });
    if (input.action === 'restore') return success('restore', { ...row, archived_at: null, revision: 5 });
    throw new Error(`Unexpected row ${String(input.action)}`);
  }));
  const navigate = vi.fn();
  const refreshWorkspaceData = vi.fn(async () => undefined);
  const showToast = vi.fn();
  const context: DashboardViewContextValue = {
    api: { database: databaseMethod, row: rowMethod } as unknown as DashboardApiClient,
    navigate,
    refreshWorkspaceData,
    showToast,
    workspace: options.workspaceOverride ?? workspace,
  };
  const rendered = render(
    <DashboardViewContext.Provider value={context}>
      <DatabaseView databaseId={options.databaseId ?? database.id} rowId={options.rowId} />
    </DashboardViewContext.Provider>,
  );
  return { ...rendered, databaseMethod, navigate, refreshWorkspaceData, rowMethod, showToast };
}

afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('DatabaseView behavior', () => {
  it('handles sorting, filtering, pagination, schema, details, row creation, and archival', async () => {
    const user = userEvent.setup();
    const { databaseMethod, navigate, refreshWorkspaceData, rowMethod, showToast } = renderView();
    expect(await screen.findByRole('heading', { name: 'Research' })).toBeTruthy();
    expect(await screen.findByLabelText('Name for Alpha')).toBeTruthy();
    expect(document.querySelector('.database-pagination')?.textContent).toContain('1–1 of 51');

    await user.selectOptions(screen.getByLabelText('Sort records by'), 'Score');
    await waitFor(() => expect(rowMethod).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'query', sort_by: 'Score', sort_direction: 'asc',
    }), expect.anything()));
    await user.click(screen.getByRole('button', { name: 'Sort descending' }));
    await waitFor(() => expect(rowMethod).toHaveBeenLastCalledWith(expect.objectContaining({ sort_direction: 'desc' }), expect.anything()));
    await user.click(screen.getByRole('button', { name: /^Filter/ }));
    await user.selectOptions(screen.getByLabelText('Filter property'), 'Score');
    await user.type(screen.getByLabelText('Filter value'), '7');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(rowMethod).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: [{ operator: 'eq', property: 'Score', value: 7 }],
    }), expect.anything()));
    expect(screen.getByText('Score is 7')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filter' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(rowMethod).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 }), expect.anything()));
    expect(await screen.findByLabelText('Name for Beta')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Previous' }));

    await user.click(screen.getByRole('button', { name: 'Details' }));
    const detailDialog = await screen.findByRole('dialog', { name: 'Database details' });
    await user.clear(within(detailDialog).getByLabelText('Name'));
    await user.type(within(detailDialog).getByLabelText('Name'), 'Updated research');
    await user.click(within(detailDialog).getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(databaseMethod).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'update', name: 'Updated research' }), expect.anything(),
    ));
    expect(showToast).toHaveBeenCalledWith('Database details saved');

    await user.click(screen.getByRole('button', { name: 'Schema' }));
    const schema = await screen.findByRole('dialog', { name: 'Database schema' });
    await user.click(within(schema).getByRole('button', { name: 'Archive Score property' }));
    await waitFor(() => expect(databaseMethod).toHaveBeenCalledWith(
      { action: 'property_archive', property_id: scoreProperty.id, revision: scoreProperty.revision }, expect.anything(),
    ));
    expect(refreshWorkspaceData).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Add property' }));
    const add = await screen.findByRole('dialog', { name: 'Add a property' });
    await user.type(within(add).getByLabelText('Property name'), 'Notes');
    await user.click(within(add).getByRole('button', { name: 'Add property' }));
    await waitFor(() => expect(databaseMethod).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'property_add' }), expect.anything(),
    ));
    expect(showToast).toHaveBeenCalledWith('Property added');

    await user.click(screen.getByRole('button', { name: 'New record' }));
    const create = await screen.findByRole('dialog', { name: 'New record' });
    await user.type(within(create).getByLabelText('Name'), 'New record');
    await user.click(within(create).getByRole('button', { name: 'Create record' }));
    await waitFor(() => expect(rowMethod).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create', database_id: database.id }), expect.anything(),
    ));
    expect(navigate).toHaveBeenCalledWith({ name: 'database', databaseId: database.id, rowId: 'row-created' });

    await user.click(screen.getByRole('button', { name: 'Archive database' }));
    const prompt = await screen.findByRole('dialog', { name: 'Archive this database?' });
    await user.click(within(prompt).getByRole('button', { name: 'Keep database' }));
    expect(screen.queryByRole('dialog', { name: 'Archive this database?' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Archive database' }));
    const secondPrompt = await screen.findByRole('dialog', { name: 'Archive this database?' });
    await user.click(within(secondPrompt).getByRole('button', { name: 'Archive database' }));
    await waitFor(() => expect(databaseMethod).toHaveBeenCalledWith(
      { action: 'archive', database_id: database.id, revision: expect.any(Number) }, expect.anything(),
    ));
    expect(await screen.findByText('This database is archived and read-only.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restore database' }));
    await waitFor(() => expect(databaseMethod).toHaveBeenCalledWith(
      { action: 'restore', database_id: database.id, revision: expect.any(Number) }, expect.anything(),
    ));
  });

  it('shows database and row failure recovery states', async () => {
    const user = userEvent.setup();
    let getCalls = 0;
    const { databaseMethod, navigate } = renderView({
      databaseImpl: async (input) => {
        if (input.action === 'get') {
          getCalls += 1;
          if (getCalls === 1) throw new Error('database offline');
          return success('get', database);
        }
        throw new Error('unexpected');
      },
    });
    expect(await screen.findByRole('heading', { name: 'We couldn’t open this database.' })).toBeTruthy();
    expect(screen.getByText('database offline')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back to workspace' }));
    expect(navigate).toHaveBeenCalledWith({ name: 'home' });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Research' })).toBeTruthy();
    expect(databaseMethod).toHaveBeenCalledTimes(2);

    cleanup();
    let queryCalls = 0;
    const { rowMethod } = renderView({
      rowImpl: async (input) => {
        if (input.action !== 'query') throw new Error('unexpected');
        queryCalls += 1;
        if (queryCalls === 1) throw new Error('rows offline');
        return success('query', { items: [], page: { has_more: false, limit: 50, next_offset: null, offset: 0 }, total: 0 });
      },
    });
    expect(await screen.findByRole('heading', { name: 'Research' })).toBeTruthy();
    expect(await screen.findByText('rows offline')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(rowMethod).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: 'This database is open ground.' })).toBeTruthy();
  });

  it('rejects foreign databases and rows, and renders the compact card layout', async () => {
    const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: (_name: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
        matches: true,
        removeEventListener: (_name: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener),
      })),
    });
    const { navigate, showToast } = renderView({ rowId: row.id,
      rowImpl: async (input) => input.action === 'query'
        ? success('query', { items: [row], page: { has_more: false, limit: 50, next_offset: null, offset: 0 }, total: 1 })
        : success('get', { ...row, database_id: 'other-database' }),
    });
    expect(await screen.findByRole('heading', { name: 'Research' })).toBeTruthy();
    expect(await screen.findByText('Alpha')).toBeTruthy();
    expect(document.querySelector('.database-cards')).toBeTruthy();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('This row belongs to a different database', { tone: 'error' }));
    expect(navigate).toHaveBeenCalledWith({ name: 'database', databaseId: database.id });
    act(() => {
      for (const listener of mediaListeners) listener({ matches: false } as MediaQueryListEvent);
    });
    await waitFor(() => expect(screen.getByRole('table', { name: 'Rows in Research' })).toBeTruthy());
  });

  it('validates filter drafts, applies empty filters, and reloads when archived rows are included', async () => {
    const user = userEvent.setup();
    const { rowMethod, showToast } = renderView();
    expect(await screen.findByLabelText('Name for Alpha')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Filter/ }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(showToast).toHaveBeenCalledWith('Choose a property to filter', { tone: 'error' });
    await user.selectOptions(screen.getByLabelText('Filter property'), 'Score');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(showToast).toHaveBeenCalledWith('Enter a filter value, or choose “is empty”', { tone: 'error' });
    await user.selectOptions(screen.getByLabelText('Filter operator'), 'is_empty');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(rowMethod).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: [{ operator: 'is_empty', property: 'Score' }],
    }), expect.anything()));
    await user.click(screen.getByRole('checkbox', { name: 'Include archived' }));
    await waitFor(() => expect(rowMethod).toHaveBeenLastCalledWith(expect.objectContaining({ include_archived: true }), expect.anything()));
  });

  it('renders archived and foreign database cases and corrects an emptied later page', async () => {
    const user = userEvent.setup();
    const offsetCalls: number[] = [];
    const { databaseMethod, rowMethod } = renderView({
      databaseImpl: async (input) => {
        if (input.action === 'get') return success('get', { ...database, archived_at: NOW, description: null, tags: [] });
        if (input.action === 'restore') return success('restore', { ...database, archived_at: null, revision: 4 });
        throw new Error('unexpected database mutation');
      },
      rowImpl: async (input) => {
        if (input.action !== 'query') throw new Error('unexpected row');
        const offset = Number(input.offset ?? 0);
        offsetCalls.push(offset);
        return success('query', { items: offset === 0 ? [row] : [], page: { has_more: offset === 0, limit: 50, next_offset: offset === 0 ? 50 : null, offset }, total: offset === 0 ? 51 : 1 });
      },
    });
    expect(await screen.findByText('This database is archived and read-only.')).toBeTruthy();
    expect(screen.getByText('Structured knowledge')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New record' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Include archived' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Restore database' }));
    await waitFor(() => expect(databaseMethod).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'restore' }), expect.anything(),
    ));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(offsetCalls).toContain(50));
    await waitFor(() => expect(offsetCalls.filter((offset) => offset === 0).length).toBeGreaterThan(1));
    expect(rowMethod).toHaveBeenCalled();

    cleanup();
    const foreign = renderView({
      databaseImpl: async (input) => {
        if (input.action === 'get') return success('get', { ...database, workspace_id: 'other-workspace' });
        throw new Error('unexpected');
      },
    });
    expect(await screen.findByRole('heading', { name: 'We couldn’t open this database.' })).toBeTruthy();
    expect(screen.getByText('This database belongs to a different workspace')).toBeTruthy();
    expect(foreign.databaseMethod).toHaveBeenCalled();
  });

  it('updates and restores schema properties, then archives and restores routed rows', async () => {
    const user = userEvent.setup();
    const schemaCase = renderView();
    expect(await screen.findByRole('heading', { name: 'Research' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Schema' }));
    const schema = await screen.findByRole('dialog', { name: 'Database schema' });
    const scoreName = within(schema).getByLabelText('Name for Score property');
    await user.clear(scoreName);
    await user.type(scoreName, 'Score updated');
    const scoreEditor = scoreName.closest('article');
    if (!scoreEditor) throw new Error('Score property editor was not rendered');
    await user.click(within(scoreEditor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(schemaCase.databaseMethod).toHaveBeenCalledWith(expect.objectContaining({
      action: 'property_update', name: 'Score updated', property_id: scoreProperty.id,
    }), expect.anything()));
    const stageChoices = within(schema).getByLabelText('Choices for Stage property');
    await user.clear(stageChoices);
    await user.type(stageChoices, 'Planned, Active, Done');
    const stageEditor = stageChoices.closest('article');
    if (!stageEditor) throw new Error('Stage property editor was not rendered');
    await user.click(within(stageEditor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(schemaCase.databaseMethod).toHaveBeenCalledWith(expect.objectContaining({
      action: 'property_update', options: { choices: ['Planned', 'Active', 'Done'] }, property_id: stageProperty.id,
    }), expect.anything()));
    await user.click(within(schema).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(schemaCase.databaseMethod).toHaveBeenCalledWith({
      action: 'property_restore', property_id: archivedProperty.id, revision: archivedProperty.revision,
    }, expect.anything()));

    cleanup();
    const rowCase = renderView({ rowId: row.id });
    const dialog = await screen.findByRole('dialog', { name: 'Alpha' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive record' }));
    await waitFor(() => expect(rowCase.rowMethod).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'archive', row_id: row.id }), expect.anything(),
    ));
    expect(rowCase.navigate).toHaveBeenCalledWith({ name: 'database', databaseId: database.id });
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(rowCase.rowMethod).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'restore', row_id: row.id }), expect.anything(),
    ));
  });

  it('filters checkbox values and renders the empty filtered state', async () => {
    const user = userEvent.setup();
    const doneProperty = property({ id: 'property-done', name: 'Done', position: 4, property_type: 'checkbox' });
    const checkboxDatabase = { ...database, properties: [...database.properties, doneProperty] };
    const { rowMethod } = renderView({
      databaseImpl: async (input) => {
        if (input.action === 'get') return success('get', checkboxDatabase);
        throw new Error(`Unexpected database ${String(input.action)}`);
      },
      rowImpl: async (input) => {
        if (input.action !== 'query') throw new Error(`Unexpected row ${String(input.action)}`);
        const filtered = Array.isArray(input.filters) && input.filters.length > 0;
        return success('query', {
          items: filtered ? [] : [row],
          page: { has_more: false, limit: 50, next_offset: null, offset: 0 },
          total: filtered ? 0 : 1,
        });
      },
    });
    expect(await screen.findByRole('heading', { name: 'Research' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Filter/ }));
    await user.selectOptions(screen.getByLabelText('Filter property'), 'Done');
    expect((screen.getByLabelText('Filter value') as HTMLSelectElement).value).toBe('true');
    await user.selectOptions(screen.getByLabelText('Filter value'), 'false');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(rowMethod).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: [{ operator: 'eq', property: 'Done', value: false }],
    }), expect.anything()));
    expect(await screen.findByRole('heading', { name: 'No records match this filter.' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Filter/ }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(rowMethod).toHaveBeenLastCalledWith(expect.objectContaining({ filters: undefined }), expect.anything()));
  });

  it('marks archived rows in both compact cards and the table', async () => {
    const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: (_name: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
        matches: true,
        removeEventListener: (_name: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener),
      })),
    });
    const archivedRow = { ...row, archived_at: NOW };
    renderView({
      rowImpl: async (input) => {
        if (input.action !== 'query') throw new Error(`Unexpected row ${String(input.action)}`);
        return success('query', {
          items: [archivedRow],
          page: { has_more: false, limit: 50, next_offset: null, offset: 0 },
          total: 1,
        });
      },
    });
    expect(await screen.findByRole('heading', { name: 'Research' })).toBeTruthy();
    expect(await screen.findByText('Alpha')).toBeTruthy();
    const card = document.querySelector('.database-card');
    expect(card?.classList.contains('is-archived')).toBe(true);
    expect(within(card as HTMLElement).getByText('Archived')).toBeTruthy();
    act(() => {
      for (const listener of mediaListeners) listener({ matches: false } as MediaQueryListEvent);
    });
    const table = await screen.findByRole('table', { name: 'Rows in Research' });
    expect(table.querySelector('tbody tr')?.classList.contains('is-archived')).toBe(true);
  });

  it('ignores an out-of-order row query after the sort changes', async () => {
    const user = userEvent.setup();
    const firstQuery = deferred<unknown>();
    const latestRow = { ...row, revision: 4, values: { ...row.values, Score: 22 } };
    let queryCount = 0;
    renderView({
      rowImpl: async (input) => {
        if (input.action !== 'query') throw new Error('unexpected row action');
        queryCount += 1;
        if (queryCount === 1) return firstQuery.promise;
        return success('query', {
          items: [latestRow],
          page: { has_more: false, limit: 50, next_offset: null, offset: 0 },
          total: 1,
        });
      },
    });
    expect(await screen.findByRole('heading', { name: 'Research' })).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Sort records by'), 'Score');
    const latestScore = await screen.findByLabelText<HTMLInputElement>('Score for Alpha');
    await waitFor(() => expect(latestScore.value).toBe('22'));

    await act(async () => {
      firstQuery.resolve(success('query', {
        items: [row],
        page: { has_more: false, limit: 50, next_offset: null, offset: 0 },
        total: 1,
      }));
      await firstQuery.promise;
    });
    expect(screen.getByLabelText<HTMLInputElement>('Score for Alpha').value).toBe('22');
  });
});
