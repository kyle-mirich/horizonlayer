// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardApiError, type DashboardApiClient } from '../../api';
import { DashboardViewContext, type DashboardViewContextValue } from '../../shell/DashboardContext';
import type {
  DatabaseProperty,
  DatabaseRow,
  DatabaseWithProperties,
  PropertyType,
  Workspace,
} from '../../types';
import { DatabaseSchemaDialog } from './DatabaseSchemaDialog';
import {
  cellDraftValue,
  choicesFrom,
  dateInputValue,
  emptyRowDraft,
  multiValue,
  rowDraft,
  sameJsonValue,
  textInputValue,
  titleProperty,
  uniqueTags,
  valuesFromDraft,
} from './controls/DatabaseControlUtils';
import { DraftValueField } from './controls/DraftValueField';
import { useCompactRows } from './useCompactRows';
import { useDatabaseEditor } from './useDatabaseEditor';

const NOW = '2026-07-01T00:00:00.000Z';

function property(
  propertyType: PropertyType,
  overrides: Partial<DatabaseProperty> = {},
): DatabaseProperty {
  return {
    archived_at: null,
    created_at: NOW,
    database_id: 'database-1',
    id: `property-${propertyType}`,
    name: propertyType === 'title' ? 'Name' : propertyType,
    options: {},
    position: 0,
    property_type: propertyType,
    revision: 1,
    updated_at: NOW,
    ...overrides,
  };
}

const properties = [
  property('title'),
  property('number'),
  property('checkbox'),
  property('multi_select'),
  property('date'),
  property('select'),
  property('text'),
  property('url'),
];

const row: DatabaseRow = {
  archived_at: null,
  created_at: NOW,
  database_id: 'database-1',
  id: 'row-1',
  importance: 0.5,
  revision: 1,
  tags: [],
  updated_at: NOW,
  values: {
    Name: 'Alpha',
    checkbox: true,
    date: '2026-07-20T12:00:00.000Z',
    multi_select: ['Red', 1, 'Blue'],
    number: 7,
    select: 'Planned',
    text: 'Notes',
    url: 'https://example.test',
  },
};

function success<Action extends string, Result>(action: Action, result: Result) {
  return { action, error: null, meta: {}, ok: true as const, result };
}

afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('database control utility edge cases', () => {
  it('normalizes draft values for every property type and ignores archived fields', () => {
    const archived = property('text', { archived_at: NOW, id: 'archived', name: 'Archived' });
    const allProperties = [...properties, archived];

    expect(uniqueTags(' agent, ,agent, mcp ')).toEqual(['agent', 'mcp']);
    expect(choicesFrom(' Planned, planned, ,DONE, Done ')).toEqual(['Planned', 'DONE']);
    expect(titleProperty([property('title', { archived_at: NOW }), properties[0]!]))
      .toBe(properties[0]);
    expect(titleProperty([property('text')])).toBeUndefined();
    expect(dateInputValue('2026-07-20T12:00:00.000Z')).toBe('2026-07-20');
    expect(dateInputValue(7)).toBe('');
    expect(textInputValue('text')).toBe('text');
    expect(textInputValue(7)).toBe('7');
    expect(textInputValue(true)).toBe('');
    expect(multiValue(['Red', 1, 'Blue'])).toEqual(['Red', 'Blue']);
    expect(multiValue('Red')).toEqual([]);
    expect(cellDraftValue('multi_select', ['Red', 'Blue'])).toBe('Red, Blue');
    expect(cellDraftValue('date', '2026-07-20T12:00:00.000Z')).toBe('2026-07-20');
    expect(cellDraftValue('number', 7)).toBe('7');
    expect(sameJsonValue(undefined, null)).toBe(true);
    expect(sameJsonValue(['Red'], ['Blue'])).toBe(false);

    expect(emptyRowDraft(allProperties)).toEqual({
      Name: '',
      checkbox: false,
      date: '',
      multi_select: [],
      number: '',
      select: '',
      text: '',
      url: '',
    });
    expect(rowDraft(allProperties, row)).toEqual({
      Name: 'Alpha',
      checkbox: true,
      date: '2026-07-20',
      multi_select: ['Red', 'Blue'],
      number: '7',
      select: 'Planned',
      text: 'Notes',
      url: 'https://example.test',
    });

    expect(valuesFromDraft(allProperties, {
      Name: '  Beta  ',
      checkbox: false,
      date: '',
      multi_select: ['Blue'],
      number: '',
      select: '',
      text: 'Updated',
      url: '',
    })).toEqual({
      Name: 'Beta',
      checkbox: false,
      date: null,
      multi_select: ['Blue'],
      number: null,
      select: null,
      text: 'Updated',
      url: null,
    });
    expect(valuesFromDraft(properties, {
      Name: [],
      checkbox: 'true',
      date: [],
      multi_select: 'Blue',
      number: '8',
      select: [],
      text: [],
      url: [],
    })).toEqual({
      Name: '',
      checkbox: false,
      date: null,
      multi_select: [],
      number: 8,
      select: null,
      text: null,
      url: null,
    });
  });
});

describe('extracted database UI helpers', () => {
  it('renders and updates every draft field shape', () => {
    const onChange = vi.fn();
    const checkbox = property('checkbox');
    const configuredMulti = property('multi_select', { options: { choices: ['Red', 'Blue'] } });
    const configuredSelect = property('select', { options: { choices: ['Planned', 'Done'] } });
    const { rerender } = render(
      <DraftValueField onChange={onChange} property={checkbox} value={false} />,
    );

    fireEvent.click(screen.getByLabelText('checkbox'));
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(<DraftValueField onChange={onChange} property={configuredMulti} value="bad" />);
    fireEvent.click(screen.getByLabelText('multi_select: Red'));
    expect(onChange).toHaveBeenLastCalledWith(['Red']);
    rerender(<DraftValueField onChange={onChange} property={configuredMulti} value={['Red']} />);
    fireEvent.click(screen.getByLabelText('multi_select: Red'));
    expect(onChange).toHaveBeenLastCalledWith([]);

    rerender(<DraftValueField onChange={onChange} property={configuredSelect} value={[]} />);
    fireEvent.change(screen.getByLabelText('select'), { target: { value: 'Done' } });
    expect(onChange).toHaveBeenLastCalledWith('Done');

    rerender(<DraftValueField onChange={onChange} property={property('multi_select')} value="bad" />);
    fireEvent.change(screen.getByLabelText('multi_select'), { target: { value: 'Red, red, Blue' } });
    expect(onChange).toHaveBeenLastCalledWith(['Red', 'Blue']);

    for (const [type, label, expected] of [
      ['title', 'Name', 'text'],
      ['number', 'number', 'number'],
      ['date', 'date', 'date'],
      ['url', 'url', 'url'],
      ['text', 'text', 'text'],
    ] as const) {
      rerender(<DraftValueField onChange={onChange} property={property(type)} value={[]} />);
      expect(screen.getByLabelText(label).getAttribute('type')).toBe(expected);
      fireEvent.change(screen.getByLabelText(label), { target: { value: 'next' } });
      expect(onChange).toHaveBeenLastCalledWith('next');
    }
  });

  it('tracks compact layout changes, blurs focus, and removes its listener', () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: (_name: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.add(listener);
        },
        matches: false,
        removeEventListener: (_name: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener);
        },
      })),
    });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const { result, unmount } = renderHook(() => useCompactRows());

    expect(result.current).toBe(false);
    act(() => {
      for (const listener of listeners) listener({ matches: true } as MediaQueryListEvent);
    });
    expect(result.current).toBe(true);
    expect(document.activeElement).not.toBe(input);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('hides schema creation for archived databases and caps active schemas', () => {
    const database = (overrides: Partial<DatabaseWithProperties>): DatabaseWithProperties => ({
      archived_at: null,
      created_at: NOW,
      description: null,
      id: 'database-1',
      name: 'Research',
      parent_page_id: null,
      properties: [],
      revision: 1,
      tags: [],
      updated_at: NOW,
      workspace_id: 'workspace-1',
      ...overrides,
    });
    const callbacks = {
      onAddProperty: vi.fn(),
      onArchive: vi.fn(),
      onClose: vi.fn(),
      onRestore: vi.fn(),
      onSave: vi.fn(),
    };
    const { rerender } = render(
      <DatabaseSchemaDialog database={database({ archived_at: NOW })} saveState="saved" {...callbacks} />,
    );
    expect(screen.queryByRole('button', { name: 'Add property' })).toBeNull();

    const cappedProperties = Array.from({ length: 100 }, (_, index) => property('text', {
      id: `property-${index}`,
      name: `Property ${index}`,
      position: index,
    }));
    rerender(
      <DatabaseSchemaDialog database={database({ properties: cappedProperties })} saveState="saving" {...callbacks} />,
    );
    expect(screen.getByRole('button', { name: 'Add property' })).toHaveProperty('disabled', true);
    expect(screen.getByText('100 active properties')).toBeTruthy();
  });
});

describe('useDatabaseEditor error recovery', () => {
  it('reloads after property conflicts and preserves fallback messages for unknown failures', async () => {
    const database: DatabaseWithProperties = {
      archived_at: null,
      created_at: NOW,
      description: null,
      id: 'database-1',
      name: 'Research',
      parent_page_id: null,
      properties: [properties[0]!],
      revision: 1,
      tags: [],
      updated_at: NOW,
      workspace_id: 'workspace-1',
    };
    const workspace: Workspace = {
      archived_at: null,
      created_at: NOW,
      description: null,
      icon: null,
      id: 'workspace-1',
      name: 'Workspace',
      revision: 1,
      updated_at: NOW,
    };
    const conflict = new DashboardApiError('Property revision changed', {
      action: 'property_update',
      code: 'CONFLICT',
      endpoint: '/api/tools/database',
      status: 409,
    });
    let updateCount = 0;
    const databaseMethod = vi.fn(async (input: Record<string, unknown>) => {
      if (input.action === 'get') return success('get', database);
      if (input.action === 'property_update') {
        updateCount += 1;
        if (updateCount === 1) throw conflict;
        throw 'unknown property failure';
      }
      throw new Error(`Unexpected database action ${String(input.action)}`);
    });
    const rowMethod = vi.fn(async (input: Record<string, unknown>) => {
      if (input.action === 'query') {
        return success('query', {
          items: [],
          page: { has_more: false, limit: 50, next_offset: null, offset: 0 },
          total: 0,
        });
      }
      throw new Error(`Unexpected row action ${String(input.action)}`);
    });
    const showToast = vi.fn();
    const context: DashboardViewContextValue = {
      api: { database: databaseMethod, row: rowMethod } as unknown as DashboardApiClient,
      navigate: vi.fn(),
      refreshWorkspaceData: vi.fn(async () => undefined),
      showToast,
      workspace,
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DashboardViewContext.Provider value={context}>{children}</DashboardViewContext.Provider>
    );
    const { result } = renderHook(() => useDatabaseEditor(database.id), { wrapper });

    await waitFor(() => expect(result.current.database?.id).toBe(database.id));
    act(() => result.current.updateProperty(properties[0]!, { name: 'Renamed' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'This changed elsewhere. The latest version is loading.',
      { tone: 'error' },
    ));
    expect(result.current.editorEpoch).toBeGreaterThan(0);
    await waitFor(() => expect(databaseMethod.mock.calls.filter(([input]) => input.action === 'get').length)
      .toBeGreaterThan(1));

    act(() => result.current.updateProperty(
      property('text', { id: 'missing-property' }),
      { options: { choices: [] } },
    ));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'The change could not be saved',
      { tone: 'error' },
    ));
    expect(updateCount).toBe(2);
  });
});
