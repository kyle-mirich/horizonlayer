// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseProperty, DatabaseRow, DatabaseWithProperties, PropertyType } from '../types';
import {
  AddPropertyDialog,
  CellEditor,
  CreateRowDialog,
  DatabaseDetailsDialog,
  FilterValueField,
  filterOperators,
  operatorLabel,
  propertyGlyph,
  PropertyEditor,
  RowDetailsDialog,
  titleForRow,
} from './DatabaseControls';

const NOW = '2026-07-01T00:00:00.000Z';

function property(type: PropertyType, overrides: Partial<DatabaseProperty> = {}): DatabaseProperty {
  return {
    archived_at: null,
    created_at: NOW,
    database_id: 'database-1',
    id: `property-${type}`,
    name: type === 'title' ? 'Name' : type,
    options: {},
    position: 0,
    property_type: type,
    revision: 1,
    updated_at: NOW,
    ...overrides,
  };
}

const title = property('title');
const number = property('number');
const checkbox = property('checkbox');
const select = property('select', { options: { choices: ['Planned', 'Done'] } });
const multi = property('multi_select', { options: { choices: ['Red', 'Blue'] } });
const text = property('text');
const date = property('date');
const url = property('url');
const database: DatabaseWithProperties = {
  archived_at: null,
  created_at: NOW,
  description: 'A database',
  id: 'database-1',
  name: 'Research',
  parent_page_id: null,
  properties: [title, number, checkbox, select, multi, text, date, url],
  revision: 2,
  tags: ['agent'],
  updated_at: NOW,
  workspace_id: 'workspace-1',
};
const row: DatabaseRow = {
  archived_at: null,
  created_at: NOW,
  database_id: database.id,
  id: 'row-1',
  importance: 0.5,
  revision: 3,
  tags: ['agent'],
  updated_at: NOW,
  values: {
    Name: 'Alpha', checkbox: true, date: '2026-07-01T00:00:00.000Z', multi_select: ['Red'], number: 3,
    select: 'Planned', text: 'Description', url: 'https://example.test',
  },
};

afterEach(() => cleanup());

describe('DatabaseControls helpers', () => {
  it('maps titles, filter operators, labels, and glyphs across the schema types', () => {
    expect(titleForRow(row, [title])).toBe('Alpha');
    expect(titleForRow({ ...row, values: { Name: '  ' } }, [title])).toBe('Untitled record');
    expect(titleForRow(row, [])).toBe('Untitled record');
    expect(filterOperators(undefined)).toEqual([]);
    expect(filterOperators(number)).toEqual(['eq', 'neq', 'gt', 'lt', 'is_empty']);
    expect(filterOperators(checkbox)).toEqual(['eq', 'neq', 'is_empty']);
    expect(filterOperators(multi)).toEqual(['contains', 'is_empty']);
    expect(filterOperators(text)).toEqual(['contains', 'eq', 'neq', 'is_empty']);
    expect((['contains', 'eq', 'neq', 'gt', 'lt', 'is_empty'] as const).map(operatorLabel)).toEqual([
      'contains', 'is', 'is not', 'is greater than', 'is less than', 'is empty',
    ]);
    expect((['title', 'text', 'number', 'date', 'checkbox', 'url', 'select', 'multi_select'] as PropertyType[])
      .map(propertyGlyph)).toEqual(['Aa', 'T', '#', '◷', '✓', '↗', '◆', '✣']);
  });
});

describe('CellEditor', () => {
  it('commits checkbox, configured select, and configured multi-select values', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const { rerender } = render(<CellEditor disabled={false} onCommit={onCommit} property={checkbox} rowLabel="Alpha" value={false} />);
    await user.click(screen.getByLabelText('checkbox for Alpha'));
    expect(onCommit).toHaveBeenLastCalledWith(true);

    rerender(<CellEditor disabled={false} onCommit={onCommit} property={select} rowLabel="Alpha" value="Planned" />);
    await user.selectOptions(screen.getByLabelText('select for Alpha'), 'Done');
    expect(onCommit).toHaveBeenLastCalledWith('Done');

    rerender(<CellEditor disabled={false} onCommit={onCommit} property={multi} rowLabel="Alpha" value={['Red']} />);
    await user.click(screen.getByRole('button', { name: 'Remove Red from multi_select' }));
    expect(onCommit).toHaveBeenLastCalledWith([]);
    await user.selectOptions(screen.getByLabelText('Add multi_select choice for Alpha'), 'Blue');
    expect(onCommit).toHaveBeenLastCalledWith(['Red', 'Blue']);
  });

  it('normalizes text and multi-select drafts, rejects invalid numbers, and supports Escape', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const noChoicesMulti = property('multi_select', { options: {} });
    const { rerender } = render(<CellEditor disabled={false} onCommit={onCommit} property={title} rowLabel="Alpha" value="Alpha" />);
    const input = screen.getByLabelText('Name for Alpha');
    await user.clear(input);
    await user.type(input, ' Beta ');
    await user.tab();
    expect(onCommit).toHaveBeenLastCalledWith('Beta');

    rerender(<CellEditor disabled={false} onCommit={onCommit} property={number} rowLabel="Alpha" value={3} />);
    const score = screen.getByLabelText('number for Alpha');
    await user.clear(score);
    await user.type(score, 'Infinity');
    await user.tab();
    expect(onCommit).toHaveBeenCalledTimes(2);
    await user.clear(score);
    await user.type(score, '8');
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenLastCalledWith(8);
    await user.clear(score);
    await user.type(score, '12');
    await user.keyboard('{Escape}');
    expect((score as HTMLInputElement).value).toBe('3');

    rerender(<CellEditor disabled={false} onCommit={onCommit} property={noChoicesMulti} rowLabel="Alpha" value={['Red']} />);
    const choices = screen.getByLabelText('multi_select for Alpha');
    await user.clear(choices);
    await user.type(choices, ' Red, blue, RED ');
    await user.tab();
    expect(onCommit).toHaveBeenLastCalledWith(['Red', 'blue']);
  });
});

describe('property and filter controls', () => {
  it('saves choice edits, archives active properties, and restores archived ones', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    const onRestore = vi.fn();
    const onSave = vi.fn();
    const { rerender } = render(
      <PropertyEditor disabled={false} onArchive={onArchive} onRestore={onRestore} onSave={onSave} property={select} />,
    );
    await user.clear(screen.getByLabelText('Name for select property'));
    await user.type(screen.getByLabelText('Name for select property'), ' Stage ');
    await user.clear(screen.getByLabelText('Choices for select property'));
    await user.type(screen.getByLabelText('Choices for select property'), 'Planned, planned, Active, Done');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ name: 'Stage', options: { choices: ['Planned', 'Active', 'Done'] } });
    await user.click(screen.getByRole('button', { name: 'Archive select property' }));
    expect(onArchive).toHaveBeenCalledTimes(1);

    rerender(<PropertyEditor disabled={false} onArchive={onArchive} onRestore={onRestore} onSave={onSave} property={{ ...select, archived_at: NOW }} />);
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Archive/ })).toBeNull();
  });

  it('renders all filter field forms and reports their changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<FilterValueField onChange={onChange} property={checkbox} value="" />);
    await user.selectOptions(screen.getByLabelText('Filter value'), 'false');
    expect(onChange).toHaveBeenLastCalledWith('false');
    rerender(<FilterValueField onChange={onChange} property={select} value="" />);
    await user.selectOptions(screen.getByLabelText('Filter value'), 'Done');
    expect(onChange).toHaveBeenLastCalledWith('Done');
    rerender(<FilterValueField onChange={onChange} property={number} value="3" />);
    expect(screen.getByLabelText('Filter value').getAttribute('type')).toBe('number');
    fireEvent.change(screen.getByLabelText('Filter value'), { target: { value: '4' } });
    expect(onChange).toHaveBeenLastCalledWith('4');
  });
});

describe('database dialogs', () => {
  it('saves trimmed database details and exposes archive/cancel controls', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    const onClose = vi.fn();
    const onSave = vi.fn();
    render(<DatabaseDetailsDialog database={database} disabled={false} onArchive={onArchive} onClose={onClose} onSave={onSave} />);
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), ' Updated ');
    await user.clear(screen.getByLabelText('Description'));
    await user.type(screen.getByLabelText('Description'), ' Details ');
    await user.clear(screen.getByLabelText('Tags'));
    await user.type(screen.getByLabelText('Tags'), ' agent, agent, mcp ');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    expect(onSave).toHaveBeenCalledWith({ description: 'Details', name: 'Updated', tags: ['agent', 'mcp'] });
    await user.click(screen.getByRole('button', { name: 'Archive database' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('creates typed properties and records from all draft value kinds', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCreateProperty = vi.fn();
    render(<AddPropertyDialog disabled={false} onClose={onClose} onCreate={onCreateProperty} />);
    await user.type(screen.getByLabelText('Property name'), 'Stage');
    await user.selectOptions(screen.getByLabelText('Type'), 'select');
    const add = screen.getByRole('button', { name: 'Add property' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await user.type(screen.getByLabelText('Choices'), ' Planned, planned, Done ');
    await user.click(add);
    expect(onCreateProperty).toHaveBeenCalledWith({
      name: 'Stage', options: { choices: ['Planned', 'Done'] }, property_type: 'select',
    });

    cleanup();
    const onCreateRow = vi.fn();
    render(<CreateRowDialog disabled={false} onClose={vi.fn()} onCreate={onCreateRow} properties={[title, number, checkbox, select, multi, date, url]} />);
    await user.type(screen.getByLabelText('Name'), ' Alpha ');
    await user.type(screen.getByLabelText('number'), '7');
    await user.click(screen.getByLabelText('checkbox'));
    await user.selectOptions(screen.getByLabelText('select'), 'Done');
    await user.click(screen.getByLabelText('multi_select: Blue'));
    fireEvent.change(screen.getByLabelText('date'), { target: { value: '2026-07-02' } });
    await user.type(screen.getByLabelText('url'), 'https://example.test');
    await user.type(screen.getByLabelText('Tags'), ' red, red, blue ');
    fireEvent.change(screen.getByLabelText('Importance'), { target: { value: '0.8', valueAsNumber: 0.8 } });
    await user.click(screen.getByRole('button', { name: 'Create record' }));
    expect(onCreateRow).toHaveBeenCalledWith({
      Name: 'Alpha', checkbox: true, date: '2026-07-02', multi_select: ['Blue'], number: 7,
      select: 'Done', url: 'https://example.test',
    }, ['red', 'blue'], 0.8);
  });

  it('covers row loading, normal edits/archiving, and archived restore behavior', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    const onClose = vi.fn();
    const onRestore = vi.fn();
    const onSaveDetails = vi.fn();
    const { rerender } = render(
      <RowDetailsDialog databaseArchived={false} disabled={false} onArchive={onArchive} onClose={onClose}
        onRestore={onRestore} onSaveDetails={onSaveDetails} properties={[title, number, checkbox, multi]} row={null} />,
    );
    expect(screen.getByRole('dialog', { name: 'Opening record…' })).toBeTruthy();
    rerender(
      <RowDetailsDialog databaseArchived={false} disabled={false} onArchive={onArchive} onClose={onClose}
        onRestore={onRestore} onSaveDetails={onSaveDetails} properties={[title, number, checkbox, multi]} row={row} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Alpha' });
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Beta');
    await user.clear(within(dialog).getByLabelText('Tags'));
    await user.type(within(dialog).getByLabelText('Tags'), 'one, two');
    await user.click(within(dialog).getByRole('button', { name: 'Save details' }));
    expect(onSaveDetails).toHaveBeenCalledWith(row, {
      Name: 'Beta', checkbox: true, multi_select: ['Red'], number: 3,
    }, ['one', 'two'], 0.5);
    await user.click(within(dialog).getByRole('button', { name: 'Archive record' }));
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onArchive).toHaveBeenCalledWith(row);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <RowDetailsDialog databaseArchived={false} disabled={false} onArchive={onArchive} onClose={onClose}
        onRestore={onRestore} onSaveDetails={onSaveDetails} properties={[title]} row={{ ...row, archived_at: NOW }} />,
    );
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onRestore).toHaveBeenCalledWith({ ...row, archived_at: NOW });
  });

  it('covers remaining editor variants, title safeguards, and disabled archived details', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const { rerender } = render(<CellEditor disabled={false} onCommit={onCommit} property={multi} rowLabel="Alpha" value={['Red', 'Blue']} />);
    expect(screen.queryByLabelText('Add multi_select choice for Alpha')).toBeNull();
    rerender(<CellEditor disabled={false} onCommit={onCommit} property={date} rowLabel="Alpha" value="2026-07-01T00:00:00.000Z" />);
    expect(screen.getByLabelText('date for Alpha').getAttribute('type')).toBe('date');
    rerender(<CellEditor disabled={false} onCommit={onCommit} property={url} rowLabel="Alpha" value="https://example.test" />);
    expect(screen.getByLabelText('url for Alpha').getAttribute('type')).toBe('url');

    cleanup();
    const onArchive = vi.fn();
    render(<PropertyEditor disabled={false} onArchive={onArchive} onRestore={vi.fn()} onSave={vi.fn()} property={title} />);
    expect(screen.queryByRole('button', { name: /Archive/ })).toBeNull();

    cleanup();
    const onCreate = vi.fn();
    render(<AddPropertyDialog disabled={false} onClose={vi.fn()} onCreate={onCreate} />);
    await user.type(screen.getByLabelText('Property name'), 'Date added');
    await user.selectOptions(screen.getByLabelText('Type'), 'date');
    await user.click(screen.getByRole('button', { name: 'Add property' }));
    expect(onCreate).toHaveBeenCalledWith({ name: 'Date added', property_type: 'date' });

    cleanup();
    render(<RowDetailsDialog databaseArchived disabled={false} onArchive={vi.fn()} onClose={vi.fn()} onRestore={vi.fn()}
      onSaveDetails={vi.fn()} properties={[title]} row={{ ...row, archived_at: NOW }} />);
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(screen.getByLabelText('Name')).toHaveProperty('disabled', true);
  });
});
