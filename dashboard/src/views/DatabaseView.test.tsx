// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardApiError, type DashboardApiClient } from '../api';
import { DashboardViewContext, type DashboardViewContextValue } from '../shell/DashboardContext';
import type {
  DatabaseProperty,
  DatabaseRow,
  DatabaseWithProperties,
  Workspace,
} from '../types';
import { DatabaseView } from './DatabaseView';

const workspace: Workspace = {
  archived_at: null,
  created_at: '2026-07-16T16:00:00.000Z',
  description: null,
  icon: null,
  id: 'workspace-1',
  name: 'Agent knowledge',
  revision: 1,
  updated_at: '2026-07-16T16:00:00.000Z',
};

const titleProperty: DatabaseProperty = {
  archived_at: null,
  created_at: '2026-07-16T16:00:00.000Z',
  database_id: 'database-1',
  id: 'property-title',
  name: 'Name',
  options: {},
  position: 0,
  property_type: 'title',
  revision: 1,
  updated_at: '2026-07-16T16:00:00.000Z',
};

const scoreProperty: DatabaseProperty = {
  ...titleProperty,
  id: 'property-score',
  name: 'Score',
  position: 1,
  property_type: 'number',
};

const database: DatabaseWithProperties = {
  archived_at: null,
  created_at: '2026-07-16T16:00:00.000Z',
  description: 'Facts agents can act on.',
  id: 'database-1',
  name: 'Research',
  parent_page_id: null,
  properties: [titleProperty, scoreProperty],
  revision: 2,
  tags: ['shared'],
  updated_at: '2026-07-16T16:00:00.000Z',
  workspace_id: workspace.id,
};

const row: DatabaseRow = {
  archived_at: null,
  created_at: '2026-07-16T16:00:00.000Z',
  database_id: database.id,
  id: 'row-1',
  importance: 0.5,
  revision: 3,
  tags: ['source'],
  updated_at: '2026-07-16T16:00:00.000Z',
  values: { Name: 'Alpha', Score: 4 },
};

function success<Action extends string, Result>(action: Action, result: Result) {
  return { action, error: null, meta: {}, ok: true as const, result };
}

function mockApi(options: { rowUpdateError?: Error } = {}) {
  const databaseMethod = vi.fn(async (input: { action: string }) => {
    if (input.action === 'get') return success('get', database);
    if (input.action === 'property_add') {
      return success('property_add', {
        database_revision: 7,
        property: {
          ...scoreProperty,
          id: 'property-notes',
          name: 'Notes',
          position: 2,
          property_type: 'text' as const,
        },
      });
    }
    throw new Error(`Unexpected database action ${input.action}`);
  });
  const rowMethod = vi.fn(async (input: { action: string; values?: Record<string, unknown> }) => {
    if (input.action === 'query') {
      return success('query', {
        items: [row],
        page: { has_more: false, limit: 50, next_offset: null as number | null, offset: 0 },
        total: 1,
      });
    }
    if (input.action === 'get') return success('get', row);
    if (input.action === 'update') {
      if (options.rowUpdateError) throw options.rowUpdateError;
      return success('update', {
        ...row,
        revision: row.revision + 1,
        values: { ...row.values, ...input.values },
      });
    }
    throw new Error(`Unexpected row action ${input.action}`);
  });
  return {
    api: { database: databaseMethod, row: rowMethod } as unknown as DashboardApiClient,
    databaseMethod,
    rowMethod,
  };
}

function renderView({
  api,
  rowId,
}: {
  api: DashboardApiClient;
  rowId?: string;
}) {
  const context: DashboardViewContextValue = {
    api,
    navigate: vi.fn(),
    refreshWorkspaceData: vi.fn(async () => undefined),
    showToast: vi.fn(),
    workspace,
  };
  const renderTree = (nextRowId = rowId) => (
    <DashboardViewContext.Provider value={context}>
      <DatabaseView databaseId={database.id} rowId={nextRowId} />
    </DashboardViewContext.Provider>
  );
  const rendered = render(renderTree());
  return {
    ...context,
    rerenderView(nextRowId?: string) {
      rendered.rerender(renderTree(nextRowId));
    },
  };
}

afterEach(() => cleanup());

describe('DatabaseView', () => {
  it('loads the live schema and saves typed cells with the current row revision', async () => {
    const user = userEvent.setup();
    const { api, rowMethod } = mockApi();
    renderView({ api });

    expect(await screen.findByRole('heading', { name: 'Research' })).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Rows in Research' });
    const score = await within(table).findByLabelText('Score for Alpha');
    await user.clear(score);
    await user.type(score, '8');
    await user.tab();

    await waitFor(() => expect(rowMethod).toHaveBeenCalledWith({
      action: 'update',
      revision: 3,
      row_id: row.id,
      values: { Score: 8 },
    }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Saved' })).toBeTruthy());
  });

  it('uses the database revision returned by a property mutation', async () => {
    const user = userEvent.setup();
    const { api, databaseMethod } = mockApi();
    renderView({ api });
    await screen.findByRole('heading', { name: 'Research' });

    await user.click(screen.getByRole('button', { name: 'Schema' }));
    await user.click(screen.getByRole('button', { name: 'Add property' }));
    await user.type(screen.getByLabelText('Property name'), 'Notes');
    await user.click(screen.getByRole('button', { name: 'Add property' }));

    await waitFor(() => expect(databaseMethod).toHaveBeenCalledWith({
      action: 'property_add',
      database_id: database.id,
      property: { name: 'Notes', property_type: 'text' },
      revision: 2,
    }));
    expect(await screen.findByText('rev 7')).toBeTruthy();
  });

  it('lets keyboard users discard an inline draft with Escape', async () => {
    const user = userEvent.setup();
    const { api, rowMethod } = mockApi();
    renderView({ api });
    const table = await screen.findByRole('table', { name: 'Rows in Research' });
    const score = await within(table).findByLabelText('Score for Alpha') as HTMLInputElement;

    await user.clear(score);
    await user.type(score, '19');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(score.value).toBe('4'));
    expect(rowMethod.mock.calls.some(([input]) => input.action === 'update')).toBe(false);
  });

  it('reloads the latest data after a row revision conflict', async () => {
    const user = userEvent.setup();
    const conflict = new DashboardApiError('Row revision changed', {
      action: 'update',
      code: 'CONFLICT',
      endpoint: '/api/tools/row',
      status: 409,
    });
    const { api, rowMethod } = mockApi({ rowUpdateError: conflict });
    let queryCount = 0;
    rowMethod.mockImplementation(async (input) => {
      if (input.action === 'query') {
        queryCount += 1;
        const latest = queryCount > 1
          ? { ...row, revision: 4, values: { ...row.values, Score: 11 } }
          : row;
        return success('query', {
          items: [latest],
          page: { has_more: false, limit: 50, next_offset: null, offset: 0 },
          total: 1,
        });
      }
      if (input.action === 'get') return success('get', row);
      if (input.action === 'update') throw conflict;
      throw new Error(`Unexpected row action ${input.action}`);
    });
    const context = renderView({ api });
    await screen.findByRole('heading', { name: 'Research' });
    const table = screen.getByRole('table', { name: 'Rows in Research' });
    const score = await within(table).findByLabelText('Score for Alpha');
    await user.clear(score);
    await user.type(score, '9');
    await user.tab();

    await waitFor(() => expect(context.showToast).toHaveBeenCalledWith(
      'This changed elsewhere. The latest version is loading.',
      { tone: 'error' },
    ));
    await waitFor(() => {
      const queries = rowMethod.mock.calls.filter(([input]) => input.action === 'query');
      expect(queries.length).toBeGreaterThan(1);
    });
    await waitFor(() => expect((within(table).getByLabelText('Score for Alpha') as HTMLInputElement).value).toBe('11'));
    expect(screen.getByRole('status', { name: 'Changed elsewhere' })).toBeTruthy();
  });

  it('preserves a failed inline draft so it can be retried', async () => {
    const user = userEvent.setup();
    let updateCount = 0;
    const { api, rowMethod } = mockApi();
    rowMethod.mockImplementation(async (input) => {
      if (input.action === 'query') {
        return success('query', {
          items: [row],
          page: { has_more: false, limit: 50, next_offset: null, offset: 0 },
          total: 1,
        });
      }
      if (input.action === 'get') return success('get', row);
      if (input.action === 'update') {
        updateCount += 1;
        if (updateCount === 1) throw new Error('Temporary network failure');
        return success('update', {
          ...row,
          revision: 4,
          values: { ...row.values, ...input.values },
        });
      }
      throw new Error(`Unexpected row action ${input.action}`);
    });
    const context = renderView({ api });
    const table = await screen.findByRole('table', { name: 'Rows in Research' });
    const score = await within(table).findByLabelText('Score for Alpha') as HTMLInputElement;

    await user.clear(score);
    await user.type(score, '9');
    await user.tab();

    await waitFor(() => expect(context.showToast).toHaveBeenCalledWith(
      'Temporary network failure',
      { tone: 'error' },
    ));
    expect(score.value).toBe('9');
    expect(screen.getByRole('status', { name: 'Could not save' })).toBeTruthy();

    await user.click(score);
    await user.tab();

    await waitFor(() => expect(updateCount).toBe(2));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Saved' })).toBeTruthy());
    expect(score.value).toBe('9');
  });

  it('finishes queued edits from authoritative row state after pagination hides the row', async () => {
    const user = userEvent.setup();
    const secondRow: DatabaseRow = {
      ...row,
      id: 'row-2',
      values: { Name: 'Gamma', Score: 2 },
    };
    const firstResult = success('update', {
      ...row,
      revision: 4,
      values: { ...row.values, Score: 9 },
    });
    let resolveFirst!: (value: typeof firstResult) => void;
    const firstUpdate = new Promise<typeof firstResult>((resolve) => {
      resolveFirst = resolve;
    });
    let updateCount = 0;
    const { api, rowMethod } = mockApi();
    rowMethod.mockImplementation(async (input) => {
      if (input.action === 'query') {
        const nextPage = 'offset' in input && input.offset === 50;
        return success('query', {
          items: nextPage ? [secondRow] : [row],
          page: {
            has_more: !nextPage,
            limit: 50,
            next_offset: nextPage ? null : 50,
            offset: nextPage ? 50 : 0,
          },
          total: 51,
        });
      }
      if (input.action === 'get') return success('get', row);
      if (input.action === 'update') {
        updateCount += 1;
        if (updateCount === 1) return firstUpdate;
        return success('update', {
          ...row,
          revision: 5,
          values: { Name: 'Beta', Score: 9 },
        });
      }
      throw new Error(`Unexpected row action ${input.action}`);
    });
    renderView({ api });
    const table = await screen.findByRole('table', { name: 'Rows in Research' });
    const score = await within(table).findByLabelText('Score for Alpha');
    const title = within(table).getByLabelText('Name for Alpha');

    await user.clear(score);
    await user.type(score, '9');
    await user.tab();
    await user.clear(title);
    await user.type(title, 'Beta');
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText('Name for Gamma')).toBeTruthy();

    resolveFirst(firstResult);

    await waitFor(() => expect(updateCount).toBeGreaterThanOrEqual(2));
    const updates = rowMethod.mock.calls.filter(([input]) => input.action === 'update');
    const titleUpdate = updates.find(([input]) => input.values?.Name === 'Beta');
    expect(titleUpdate?.[0]).toMatchObject({
      revision: 4,
      row_id: row.id,
      values: { Name: 'Beta' },
    });
  });

  it('drops later writes that were queued behind a failed row revision', async () => {
    const user = userEvent.setup();
    let rejectFirst!: (error: unknown) => void;
    const firstUpdate = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const conflict = new DashboardApiError('Row revision changed', {
      action: 'update',
      code: 'CONFLICT',
      endpoint: '/api/tools/row',
      status: 409,
    });
    const { api, rowMethod } = mockApi();
    rowMethod.mockImplementation(async (input) => {
      if (input.action === 'query') {
        return success('query', {
          items: [row],
          page: { has_more: false, limit: 50, next_offset: null, offset: 0 },
          total: 1,
        });
      }
      if (input.action === 'get') return success('get', row);
      if (input.action === 'update') return firstUpdate;
      throw new Error(`Unexpected row action ${input.action}`);
    });
    const context = renderView({ api });
    const table = await screen.findByRole('table', { name: 'Rows in Research' });
    const score = await within(table).findByLabelText('Score for Alpha');
    const title = within(table).getByLabelText('Name for Alpha');

    await user.clear(score);
    await user.type(score, '9');
    await user.tab();
    await user.clear(title);
    await user.type(title, 'Beta');
    await user.tab();
    rejectFirst(conflict);

    await waitFor(() => expect(context.showToast).toHaveBeenCalledWith(
      'This changed elsewhere. The latest version is loading.',
      { tone: 'error' },
    ));
    const updates = rowMethod.mock.calls.filter(([input]) => input.action === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[0]).toMatchObject({ values: { Score: 9 } });
  });

  it('saves row values, tags, and importance together from routed row details', async () => {
    const user = userEvent.setup();
    const { api, rowMethod } = mockApi();
    renderView({ api, rowId: row.id });

    const dialog = await screen.findByRole('dialog', { name: 'Alpha' });
    const title = within(dialog).getByLabelText('Name');
    await user.clear(title);
    await user.type(title, 'Beta');
    const tags = within(dialog).getByLabelText('Tags');
    await user.clear(tags);
    await user.type(tags, 'source, verified');
    await user.click(within(dialog).getByRole('button', { name: 'Save details' }));

    await waitFor(() => expect(rowMethod).toHaveBeenCalledWith({
      action: 'update',
      importance: 0.5,
      revision: 3,
      row_id: row.id,
      tags: ['source', 'verified'],
      values: { Name: 'Beta', Score: 4 },
    }));
    expect(await screen.findByRole('dialog', { name: 'Beta' })).toBeTruthy();
  });

  it('shows a loading dialog instead of a previously selected row while a new row opens', async () => {
    const nextRow = {
      ...row,
      id: 'row-2',
      values: { ...row.values, Name: 'Beta' },
    };
    const nextEnvelope = success('get', nextRow);
    let resolveNext!: (value: typeof nextEnvelope) => void;
    const nextResponse = new Promise<typeof nextEnvelope>((resolve) => {
      resolveNext = resolve;
    });
    let getCount = 0;
    const { api, rowMethod } = mockApi();
    rowMethod.mockImplementation(async (input) => {
      if (input.action === 'query') {
        return success('query', {
          items: [row],
          page: { has_more: false, limit: 50, next_offset: null, offset: 0 },
          total: 1,
        });
      }
      if (input.action === 'get') {
        getCount += 1;
        return getCount === 1 ? success('get', row) : nextResponse;
      }
      throw new Error(`Unexpected row action ${input.action}`);
    });
    const view = renderView({ api, rowId: row.id });

    expect(await screen.findByRole('dialog', { name: 'Alpha' })).toBeTruthy();
    view.rerenderView(nextRow.id);

    expect(await screen.findByRole('dialog', { name: 'Opening record…' })).toBeTruthy();
    resolveNext(nextEnvelope);
    expect(await screen.findByRole('dialog', { name: 'Beta' })).toBeTruthy();
  });
});
