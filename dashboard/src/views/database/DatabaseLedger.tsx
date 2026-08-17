import { Icon } from '../../components/Icon';
import { useDashboard } from '../../shell/DashboardContext';
import type { DatabaseProperty, DatabaseWithProperties } from '../../types';
import { CellEditor } from './controls/CellEditor';
import {
  filterOperators,
  operatorLabel,
  propertyGlyph,
  titleForRow,
} from './controls/DatabaseControlUtils';
import { FilterValueField } from './controls/FilterValueField';
import type { useDatabaseRows } from './useDatabaseRows';

type RowEditor = ReturnType<typeof useDatabaseRows>;

export function DatabaseLedger({
  activeProperties,
  archived,
  compactRows,
  database,
  databaseId,
  editorEpoch,
  onCreateRow,
  rowEditor,
  visibleProperties,
}: {
  activeProperties: DatabaseProperty[];
  archived: boolean;
  compactRows: boolean;
  database: DatabaseWithProperties;
  databaseId: string;
  editorEpoch: number;
  onCreateRow(): void;
  rowEditor: RowEditor;
  visibleProperties: DatabaseProperty[];
}) {
  const { navigate } = useDashboard();
  const activeFilter = rowEditor.filters[0];
  const firstRowNumber = rowEditor.total === 0 ? 0 : rowEditor.offset + 1;
  const lastRowNumber = Math.min(rowEditor.offset + rowEditor.rows.length, rowEditor.total);

  return (
    <section className="database-ledger" aria-labelledby="database-rows-heading">
      <div className="database-toolbar">
        <div className="database-toolbar__left">
          <h2 id="database-rows-heading">Records</h2>
          <span>{rowEditor.total}</span>
          <span className="database-toolbar__stem" aria-hidden="true" />
          <label className="toolbar-select">
            <span>Sort</span>
            <select
              aria-label="Sort records by"
              onChange={(event) => {
                rowEditor.setSortBy(event.target.value);
                rowEditor.setOffset(0);
              }}
              value={rowEditor.sortBy}
            >
              <option value="">Recently changed</option>
              {activeProperties.filter((property) => property.property_type !== 'multi_select').map((property) => (
                <option key={property.id} value={property.name}>{property.name}</option>
              ))}
            </select>
          </label>
          {rowEditor.sortBy ? (
            <button
              aria-label={`Sort ${rowEditor.sortDirection === 'asc' ? 'descending' : 'ascending'}`}
              className="sort-direction"
              onClick={() => rowEditor.setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc')}
              type="button"
            >
              {rowEditor.sortDirection === 'asc' ? '↑' : '↓'}
            </button>
          ) : null}
          <button
            aria-expanded={rowEditor.filterOpen}
            className={`toolbar-action${activeFilter ? ' is-active' : ''}`}
            onClick={() => rowEditor.setFilterOpen((open) => !open)}
            type="button"
          >
            Filter{activeFilter ? ' · 1' : ''}
          </button>
        </div>
        <div className="database-toolbar__right">
          <label className="archive-toggle">
            <input
              checked={rowEditor.includeArchived || archived}
              disabled={archived}
              onChange={(event) => {
                rowEditor.setIncludeArchived(event.target.checked);
                rowEditor.setOffset(0);
              }}
              type="checkbox"
            />
            <span>Include archived</span>
          </label>
          {!archived ? (
            <button className="button button--primary" onClick={onCreateRow} type="button">
              <Icon name="plus" size={16} /> New record
            </button>
          ) : null}
        </div>
      </div>

      {rowEditor.filterOpen ? (
        <div className="filter-builder" aria-label="Filter records">
          <select
            aria-label="Filter property"
            onChange={(event) => rowEditor.selectFilterProperty(event.target.value)}
            value={rowEditor.filterPropertyName}
          >
            <option value="">Property</option>
            {activeProperties.map((property) => (
              <option key={property.id} value={property.name}>{property.name}</option>
            ))}
          </select>
          <select
            aria-label="Filter operator"
            disabled={!rowEditor.filterPropertyName}
            onChange={(event) => rowEditor.setFilterOperator(event.target.value as RowEditor['filterOperator'])}
            value={rowEditor.filterOperator}
          >
            {filterOperators(activeProperties.find((item) => item.name === rowEditor.filterPropertyName)).map((operator) => (
              <option key={operator} value={operator}>{operatorLabel(operator)}</option>
            ))}
          </select>
          {rowEditor.filterOperator !== 'is_empty' ? (
            <FilterValueField
              onChange={rowEditor.setFilterValue}
              property={activeProperties.find((item) => item.name === rowEditor.filterPropertyName)}
              value={rowEditor.filterValue}
            />
          ) : null}
          <button className="button button--primary" onClick={rowEditor.applyFilter} type="button">Apply</button>
          {activeFilter ? (
            <button className="text-button" onClick={rowEditor.clearFilter} type="button">
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {activeFilter ? (
        <div className="active-filter">
          <span aria-hidden="true">✣</span>
          {activeFilter.property} {operatorLabel(activeFilter.operator)}{'value' in activeFilter
            ? ` ${String(activeFilter.value)}`
            : ''}
          <button aria-label="Clear filter" onClick={rowEditor.clearFilter} type="button">×</button>
        </div>
      ) : null}

      {rowEditor.rowsError ? (
        <div className="ledger-message ledger-message--error">
          <span>{rowEditor.rowsError}</span>
          <button className="text-button" onClick={rowEditor.retryRows} type="button">Retry</button>
        </div>
      ) : null}

      <div className={`database-table-wrap${rowEditor.rowsLoading ? ' is-loading' : ''}`}>
        {!compactRows ? (
          <table className="database-table">
            <caption>Rows in {database.name}</caption>
            <thead>
              <tr>
                {visibleProperties.map((property) => (
                  <th className={property.property_type === 'title' ? 'is-title' : ''} key={property.id} scope="col">
                    <span className={`property-glyph property-glyph--${property.property_type}`} aria-hidden="true">
                      {propertyGlyph(property.property_type)}
                    </span>
                    <span>{property.name}</span>
                    {property.archived_at ? <small>Archived</small> : null}
                  </th>
                ))}
                <th className="database-table__actions" scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rowEditor.rows.map((row) => {
                const rowTitle = titleForRow(row, database.properties);
                const rowArchived = row.archived_at !== null;
                return (
                  <tr className={rowArchived ? 'is-archived' : ''} key={row.id}>
                    {visibleProperties.map((property) => (
                      <td className={property.property_type === 'title' ? 'is-title' : ''} key={property.id}>
                        <CellEditor
                          disabled={rowEditor.rowsLoading || archived || rowArchived || property.archived_at !== null}
                          key={`table-${row.id}-${property.id}-${editorEpoch}`}
                          onCommit={(value) => rowEditor.updateRowValue(row, property, value)}
                          property={property}
                          rowLabel={rowTitle}
                          value={row.values[property.name]}
                        />
                      </td>
                    ))}
                    <td className="database-table__actions">
                      <button
                        aria-label={`Open ${rowTitle}`}
                        className="row-open-button"
                        onClick={() => navigate({ name: 'database', databaseId, rowId: row.id })}
                        type="button"
                      >
                        <Icon name="more" size={17} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}

        {compactRows ? (
          <div className="database-cards">
            {rowEditor.rows.map((row) => {
              const rowTitle = titleForRow(row, database.properties);
              const rowArchived = row.archived_at !== null;
              return (
                <article className={`database-card${rowArchived ? ' is-archived' : ''}`} key={row.id}>
                  <header>
                    <span className="database-card__seed" aria-hidden="true" />
                    <strong>{rowTitle}</strong>
                    {rowArchived ? <span>Archived</span> : null}
                    <button
                      aria-label={`Open ${rowTitle}`}
                      className="row-open-button"
                      onClick={() => navigate({ name: 'database', databaseId, rowId: row.id })}
                      type="button"
                    >
                      <Icon name="more" size={18} />
                    </button>
                  </header>
                  <div className="database-card__fields">
                    {visibleProperties.map((property) => (
                      <div className="database-card__field" key={property.id}>
                        <span>{property.name}</span>
                        <CellEditor
                          disabled={rowEditor.rowsLoading || archived || rowArchived || property.archived_at !== null}
                          key={`card-${row.id}-${property.id}-${editorEpoch}`}
                          onCommit={(value) => rowEditor.updateRowValue(row, property, value)}
                          property={property}
                          rowLabel={rowTitle}
                          value={row.values[property.name]}
                        />
                      </div>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}

        {!rowEditor.rowsLoading && rowEditor.rows.length === 0 && !rowEditor.rowsError ? (
          <div className="ledger-empty">
            <span aria-hidden="true">✣</span>
            <h3>{activeFilter ? 'No records match this filter.' : 'This database is open ground.'}</h3>
            <p>{activeFilter ? 'Clear the filter or try another value.' : 'Add the first typed record for humans and agents to share.'}</p>
            {!archived && !activeFilter ? (
              <button className="button button--primary" onClick={onCreateRow} type="button">
                <Icon name="plus" size={16} /> New record
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {rowEditor.total > 0 ? (
        <footer className="database-pagination">
          <span>{firstRowNumber}–{lastRowNumber} of {rowEditor.total}</span>
          <div>
            <button
              className="button button--quiet"
              disabled={rowEditor.offset === 0 || rowEditor.rowsLoading}
              onClick={() => rowEditor.setOffset((value) => Math.max(0, value - rowEditor.rowLimit))}
              type="button"
            >
              Previous
            </button>
            <button
              className="button button--quiet"
              disabled={!rowEditor.hasMore || rowEditor.rowsLoading}
              onClick={() => rowEditor.setOffset((value) => value + rowEditor.rowLimit)}
              type="button"
            >
              Next
            </button>
          </div>
        </footer>
      ) : null}
    </section>
  );
}
