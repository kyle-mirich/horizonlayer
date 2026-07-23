import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { DashboardApiError } from '../api';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { RevisionRing, type RevisionState } from '../components/RevisionRing';
import { useDashboard } from '../shell/DashboardContext';
import type {
  DatabaseProperty,
  DatabasePropertyMutation,
  DatabaseRow,
  DatabaseWithProperties,
  JsonValue,
  RowFilter,
} from '../types';
import {
  AddPropertyDialog,
  CellEditor,
  CreateRowDialog,
  DatabaseDetailsDialog,
  FilterValueField,
  PropertyEditor,
  RowDetailsDialog,
  filterOperators,
  operatorLabel,
  propertyGlyph,
  titleForRow,
  type FilterOperator,
  type SortDirection,
} from './DatabaseControls';
import './DatabaseView.css';

const ROW_LIMIT = 50;
const COMPACT_ROWS_QUERY = '(max-width: 860px)';

function useCompactRows(): boolean {
  const [compact, setCompact] = useState(() => (
    typeof window.matchMedia === 'function'
      ? window.matchMedia(COMPACT_ROWS_QUERY).matches
      : false
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(COMPACT_ROWS_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setCompact(event.matches);
    };
    media.addEventListener('change', onChange);
    setCompact(media.matches);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return compact;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isConflict(error: unknown): boolean {
  return error instanceof DashboardApiError && error.code === 'CONFLICT';
}

export function DatabaseView({ databaseId, rowId }: { databaseId: string; rowId?: string }) {
  const { api, navigate, refreshWorkspaceData, showToast, workspace } = useDashboard();
  const [database, setDatabase] = useState<DatabaseWithProperties | null>(null);
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [selectedRow, setSelectedRow] = useState<DatabaseRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<RevisionState>('saved');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [sortBy, setSortBy] = useState('');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [filters, setFilters] = useState<RowFilter[]>([]);
  const [filterPropertyName, setFilterPropertyName] = useState('');
  const [filterOperator, setFilterOperator] = useState<FilterOperator>('contains');
  const [filterValue, setFilterValue] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [addPropertyOpen, setAddPropertyOpen] = useState(false);
  const [createRowOpen, setCreateRowOpen] = useState(false);
  const [archivePrompt, setArchivePrompt] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [rowsRefreshKey, setRowsRefreshKey] = useState(0);
  const [selectedRefreshKey, setSelectedRefreshKey] = useState(0);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const compactRows = useCompactRows();

  const databaseRef = useRef<DatabaseWithProperties | null>(null);
  const rowsRef = useRef<DatabaseRow[]>([]);
  const rowStateRef = useRef(new Map<string, DatabaseRow>());
  const selectedRowRef = useRef<DatabaseRow | null>(null);
  const pendingMutationsRef = useRef(0);
  const mutationIssueRef = useRef<RevisionState | null>(null);
  const rowQueuesRef = useRef(new Map<string, Promise<void>>());
  const rowQueueGenerationsRef = useRef(new Map<string, number>());

  const replaceDatabase = useCallback((next: DatabaseWithProperties | null) => {
    databaseRef.current = next;
    setDatabase(next);
  }, []);

  const replaceRows = useCallback((next: DatabaseRow[]) => {
    const authoritative = next.map((row) => {
      const pending = rowQueuesRef.current.has(row.id);
      const cached = rowStateRef.current.get(row.id);
      const resolved = pending && cached ? cached : row;
      rowStateRef.current.set(row.id, resolved);
      return resolved;
    });
    rowsRef.current = authoritative;
    setRows(authoritative);
  }, []);

  const replaceSelectedRow = useCallback((next: DatabaseRow | null) => {
    const cached = next && rowQueuesRef.current.has(next.id)
      ? rowStateRef.current.get(next.id)
      : undefined;
    const resolved = cached ?? next;
    if (resolved) rowStateRef.current.set(resolved.id, resolved);
    selectedRowRef.current = resolved;
    setSelectedRow(resolved);
  }, []);

  const reloadLatest = useCallback(() => {
    setRetryKey((key) => key + 1);
    setSelectedRefreshKey((key) => key + 1);
  }, []);

  const runMutation = useCallback(async <Result,>(
    operation: () => Promise<Result>,
  ): Promise<Result | undefined> => {
    if (pendingMutationsRef.current === 0) mutationIssueRef.current = null;
    pendingMutationsRef.current += 1;
    setSaveState('saving');
    try {
      return await operation();
    } catch (error) {
      const conflict = isConflict(error);
      const issue: RevisionState = conflict ? 'conflict' : 'error';
      mutationIssueRef.current = issue;
      setSaveState(issue);
      if (conflict) {
        setEditorEpoch((epoch) => epoch + 1);
        reloadLatest();
        showToast('This changed elsewhere. The latest version is loading.', { tone: 'error' });
      } else {
        showToast(errorMessage(error, 'The change could not be saved'), { tone: 'error' });
      }
      return undefined;
    } finally {
      pendingMutationsRef.current -= 1;
      if (pendingMutationsRef.current === 0) {
        setSaveState(mutationIssueRef.current ?? 'saved');
      }
    }
  }, [reloadLatest, showToast]);

  const applyRow = useCallback((next: DatabaseRow) => {
    rowStateRef.current.set(next.id, next);
    const nextRows = rowsRef.current.map((row) => row.id === next.id ? next : row);
    replaceRows(nextRows);
    if (selectedRowRef.current?.id === next.id) replaceSelectedRow(next);
  }, [replaceRows, replaceSelectedRow]);

  const currentRow = useCallback((id: string): DatabaseRow | null => {
    if (selectedRowRef.current?.id === id) return selectedRowRef.current;
    return rowsRef.current.find((row) => row.id === id)
      ?? rowStateRef.current.get(id)
      ?? null;
  }, []);

  const queueRowMutation = useCallback((
    id: string,
    operation: (row: DatabaseRow) => Promise<DatabaseRow>,
  ) => {
    const generation = rowQueueGenerationsRef.current.get(id) ?? 0;
    const prior = rowQueuesRef.current.get(id) ?? Promise.resolve();
    const next = prior.then(async () => {
      if ((rowQueueGenerationsRef.current.get(id) ?? 0) !== generation) return;
      const row = currentRow(id);
      if (!row) return;
      const result = await runMutation(() => operation(row));
      if (result) {
        applyRow(result);
      } else if ((rowQueueGenerationsRef.current.get(id) ?? 0) === generation) {
        rowQueueGenerationsRef.current.set(id, generation + 1);
        rowStateRef.current.delete(id);
        setRowsRefreshKey((key) => key + 1);
        if (selectedRowRef.current?.id === id) {
          setSelectedRefreshKey((key) => key + 1);
        }
      }
    });
    const settled = next.then(() => undefined, () => undefined);
    rowQueuesRef.current.set(id, settled);
    void settled.finally(() => {
      if (rowQueuesRef.current.get(id) === settled) {
        rowQueuesRef.current.delete(id);
        rowQueueGenerationsRef.current.delete(id);
      }
    });
  }, [applyRow, currentRow, runMutation]);

  useEffect(() => {
    const controller = new AbortController();
    if (databaseRef.current?.id !== databaseId) setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const response = await api.database({
          action: 'get',
          database_id: databaseId,
          include_archived: true,
        }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.result.workspace_id !== workspace.id) {
          throw new Error('This database belongs to a different workspace');
        }
        replaceDatabase({ ...response.result, properties: [...response.result.properties] });
      } catch (error) {
        if (!controller.signal.aborted) {
          replaceDatabase(null);
          setLoadError(errorMessage(error, 'The database could not be loaded'));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [api, databaseId, replaceDatabase, retryKey, workspace.id]);

  const activeProperties = useMemo(
    () => database?.properties.filter((property) => property.archived_at === null) ?? [],
    [database?.properties],
  );
  const visibleProperties = useMemo(
    () => database?.properties.filter((property) => includeArchived || property.archived_at === null) ?? [],
    [database?.properties, includeArchived],
  );

  useEffect(() => {
    if (!database) return;
    const propertyNames = new Set(activeProperties.map((property) => property.name));
    if (sortBy && !propertyNames.has(sortBy)) setSortBy('');
    if (filterPropertyName && !propertyNames.has(filterPropertyName)) {
      setFilterPropertyName('');
      setFilters([]);
    }
  }, [activeProperties, database, filterPropertyName, sortBy]);

  useEffect(() => {
    if (!database) return;
    const controller = new AbortController();
    setRowsLoading(true);
    setRowsError(null);
    const base = {
      action: 'query' as const,
      database_id: databaseId,
      filters: filters.length ? filters : undefined,
      include_archived: includeArchived || database.archived_at !== null,
      limit: ROW_LIMIT,
      offset,
    };
    void (async () => {
      try {
        const response = sortBy
          ? await api.row({
              ...base,
              sort_by: sortBy,
              sort_direction: sortDirection,
            }, { signal: controller.signal })
          : await api.row(base, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (offset > 0 && response.result.items.length === 0 && response.result.total <= offset) {
          replaceRows([]);
          setTotal(response.result.total);
          setOffset(response.result.total === 0
            ? 0
            : Math.floor((response.result.total - 1) / ROW_LIMIT) * ROW_LIMIT);
          return;
        }
        replaceRows(response.result.items);
        setTotal(response.result.total);
        setHasMore(response.result.page.has_more);
      } catch (error) {
        if (!controller.signal.aborted) {
          replaceRows([]);
          setRowsError(errorMessage(error, 'Rows could not be loaded'));
        }
      } finally {
        if (!controller.signal.aborted) setRowsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [
    api,
    database,
    databaseId,
    filters,
    includeArchived,
    offset,
    replaceRows,
    rowsRefreshKey,
    sortBy,
    sortDirection,
  ]);

  useEffect(() => {
    if (!rowId) {
      replaceSelectedRow(null);
      return;
    }
    const fromPage = rowsRef.current.find((row) => row.id === rowId);
    replaceSelectedRow(fromPage ?? null);
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await api.row({
          action: 'get',
          include_archived: true,
          row_id: rowId,
        }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.result.database_id !== databaseId) {
          throw new Error('This row belongs to a different database');
        }
        replaceSelectedRow(response.result);
      } catch (error) {
        if (!controller.signal.aborted) {
          showToast(errorMessage(error, 'The row could not be opened'), { tone: 'error' });
          navigate({ name: 'database', databaseId });
        }
      }
    })();
    return () => controller.abort();
  }, [api, databaseId, navigate, replaceSelectedRow, rowId, selectedRefreshKey, showToast]);

  const updateRowValue = useCallback((row: DatabaseRow, property: DatabaseProperty, value: JsonValue) => {
    if (databaseRef.current?.archived_at || row.archived_at) return;
    queueRowMutation(row.id, async (live) => {
      const response = await api.row({
        action: 'update',
        revision: live.revision,
        row_id: live.id,
        values: { [property.name]: value },
      });
      return response.result;
    });
  }, [api, queueRowMutation]);

  const updateRowDetails = useCallback((
    row: DatabaseRow,
    values: Record<string, JsonValue>,
    tags: string[],
    importance: number,
  ) => {
    queueRowMutation(row.id, async (live) => {
      const response = await api.row({
        action: 'update',
        importance,
        revision: live.revision,
        row_id: live.id,
        tags,
        values,
      });
      showToast('Record details saved');
      return response.result;
    });
  }, [api, queueRowMutation, showToast]);

  const setRowArchived = useCallback((row: DatabaseRow, restore: boolean) => {
    queueRowMutation(row.id, async (live) => {
      const response = await api.row({
        action: restore ? 'restore' : 'archive',
        revision: live.revision,
        row_id: live.id,
      });
      showToast(restore ? 'Record restored' : 'Record archived');
      if (!includeArchived && !restore) {
        setRowsRefreshKey((key) => key + 1);
        if (rowId === live.id) navigate({ name: 'database', databaseId });
      }
      return response.result;
    });
  }, [api, databaseId, includeArchived, navigate, queueRowMutation, rowId, showToast]);

  const applyPropertyMutation = useCallback((mutation: DatabasePropertyMutation) => {
    const current = databaseRef.current;
    if (!current) return;
    const exists = current.properties.some((property) => property.id === mutation.property.id);
    const properties = (exists
      ? current.properties.map((property) => property.id === mutation.property.id
        ? mutation.property
        : property)
      : [...current.properties, mutation.property]
    ).sort((left, right) => left.position - right.position);
    replaceDatabase({ ...current, properties, revision: mutation.database_revision });
    setRowsRefreshKey((key) => key + 1);
  }, [replaceDatabase]);

  const updateProperty = useCallback((
    property: DatabaseProperty,
    update: { name?: string; options?: { choices: string[] } },
  ) => {
    void runMutation(async () => {
      const response = update.name !== undefined
        ? await api.database({
            action: 'property_update',
            name: update.name,
            ...(update.options === undefined ? {} : { options: update.options }),
            property_id: property.id,
            revision: property.revision,
          })
        : await api.database({
            action: 'property_update',
            options: update.options ?? { choices: [] },
            property_id: property.id,
            revision: property.revision,
          });
      applyPropertyMutation(response.result);
      await refreshWorkspaceData();
      showToast('Property saved');
      return response.result;
    });
  }, [api, applyPropertyMutation, refreshWorkspaceData, runMutation, showToast]);

  const setPropertyArchived = useCallback((property: DatabaseProperty, restore: boolean) => {
    void runMutation(async () => {
      const response = await api.database({
        action: restore ? 'property_restore' : 'property_archive',
        property_id: property.id,
        revision: property.revision,
      });
      applyPropertyMutation(response.result);
      await refreshWorkspaceData();
      showToast(restore ? 'Property restored' : 'Property archived');
      return response.result;
    });
  }, [api, applyPropertyMutation, refreshWorkspaceData, runMutation, showToast]);

  const applyFilter = () => {
    const property = activeProperties.find((item) => item.name === filterPropertyName);
    if (!property) {
      showToast('Choose a property to filter', { tone: 'error' });
      return;
    }
    let filter: RowFilter;
    if (filterOperator === 'is_empty') {
      filter = { property: property.name, operator: 'is_empty' };
    } else {
      if (property.property_type !== 'checkbox' && filterValue.trim() === '') {
        showToast('Enter a filter value, or choose “is empty”', { tone: 'error' });
        return;
      }
      let value: JsonValue = filterValue;
      if (property.property_type === 'number') {
        if (filterValue.trim() === '' || !Number.isFinite(Number(filterValue))) {
          showToast('Enter a valid number', { tone: 'error' });
          return;
        }
        value = Number(filterValue);
      } else if (property.property_type === 'checkbox') {
        value = filterValue !== 'false';
      }
      filter = { property: property.name, operator: filterOperator, value } as RowFilter;
    }
    setFilters([filter]);
    setOffset(0);
    setFilterOpen(false);
  };

  if (loading) {
    return (
      <main className="database-view database-view--loading" aria-busy="true" id="main-content">
        <div className="database-skeleton database-skeleton--crumb" />
        <div className="database-skeleton database-skeleton--title" />
        <div className="database-skeleton database-skeleton--table" />
      </main>
    );
  }

  if (!database || loadError) {
    return (
      <main className="database-view database-view--error" id="main-content">
        <div className="view-message">
          <span className="view-message__mark"><Icon name="warning" /></span>
          <p className="eyebrow">Database unavailable</p>
          <h1>We couldn’t open this database.</h1>
          <p>{loadError ?? 'The database no longer exists.'}</p>
          <div className="view-message__actions">
            <button className="button button--primary" onClick={reloadLatest} type="button">
              <Icon name="refresh" /> Retry
            </button>
            <button className="button" onClick={() => navigate({ name: 'home' })} type="button">
              Back to workspace
            </button>
          </div>
        </div>
      </main>
    );
  }

  const archived = database.archived_at !== null;
  const firstRowNumber = total === 0 ? 0 : offset + 1;
  const lastRowNumber = Math.min(offset + rows.length, total);
  const activeFilter = filters[0];

  return (
    <main className="database-view" id="main-content">
      {archived ? (
        <div className="archive-banner database-archive-banner">
          <span>This database is archived and read-only.</span>
          <button
            className="text-button"
            onClick={() => {
              void runMutation(async () => {
                const live = databaseRef.current;
                if (!live) return;
                const response = await api.database({
                  action: 'restore',
                  database_id: databaseId,
                  revision: live.revision,
                });
                replaceDatabase({ ...response.result, properties: live.properties });
                await refreshWorkspaceData();
                showToast('Database restored');
              });
            }}
            type="button"
          >
            Restore database
          </button>
        </div>
      ) : null}

      <header className="database-view__header">
        <div className="database-view__breadcrumbs">
          <button className="breadcrumb-button" onClick={() => navigate({ name: 'home' })} type="button">
            Database
          </button>
          <span aria-hidden="true">/</span>
          <span>rev {database.revision}</span>
        </div>
        <div className="database-view__tools">
          <RevisionRing state={saveState} />
          <button className="button button--quiet" onClick={() => setSchemaOpen(true)} type="button">
            Schema
          </button>
          <button className="button button--quiet" onClick={() => setDetailsOpen(true)} type="button">
            Details
          </button>
          {!archived ? (
            <button
              aria-label="Archive database"
              className="icon-button"
              onClick={() => setArchivePrompt(true)}
              type="button"
            >
              <Icon name="archive" />
            </button>
          ) : null}
        </div>
      </header>

      <section className="database-intro">
        <div className="database-intro__mark" aria-hidden="true"><Icon name="database" size={20} /></div>
        <div className="database-intro__copy">
          <div className="database-intro__tags">
            {database.tags.length ? database.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>) : (
              <span>Structured knowledge</span>
            )}
          </div>
          <h1>{database.name}</h1>
          {database.description ? <p>{database.description}</p> : null}
        </div>
      </section>

      <section className="database-ledger" aria-labelledby="database-rows-heading">
        <div className="database-toolbar">
          <div className="database-toolbar__left">
            <h2 id="database-rows-heading">Records</h2>
            <span>{total}</span>
            <span className="database-toolbar__stem" aria-hidden="true" />
            <label className="toolbar-select">
              <span>Sort</span>
              <select
                aria-label="Sort records by"
                onChange={(event) => {
                  setSortBy(event.target.value);
                  setOffset(0);
                }}
                value={sortBy}
              >
                <option value="">Recently changed</option>
                {activeProperties.filter((property) => property.property_type !== 'multi_select').map((property) => (
                  <option key={property.id} value={property.name}>{property.name}</option>
                ))}
              </select>
            </label>
            {sortBy ? (
              <button
                aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
                className="sort-direction"
                onClick={() => setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc')}
                type="button"
              >
                {sortDirection === 'asc' ? '↑' : '↓'}
              </button>
            ) : null}
            <button
              aria-expanded={filterOpen}
              className={`toolbar-action${activeFilter ? ' is-active' : ''}`}
              onClick={() => setFilterOpen((open) => !open)}
              type="button"
            >
              Filter{activeFilter ? ' · 1' : ''}
            </button>
          </div>
          <div className="database-toolbar__right">
            <label className="archive-toggle">
              <input
                checked={includeArchived || archived}
                disabled={archived}
                onChange={(event) => {
                  setIncludeArchived(event.target.checked);
                  setOffset(0);
                }}
                type="checkbox"
              />
              <span>Include archived</span>
            </label>
            {!archived ? (
              <button className="button button--primary" onClick={() => setCreateRowOpen(true)} type="button">
                <Icon name="plus" size={16} /> New record
              </button>
            ) : null}
          </div>
        </div>

        {filterOpen ? (
          <div className="filter-builder" aria-label="Filter records">
            <select
              aria-label="Filter property"
              onChange={(event) => {
                const nextName = event.target.value;
                const property = activeProperties.find((item) => item.name === nextName);
                const nextOperator = filterOperators(property)[0] ?? 'contains';
                setFilterPropertyName(nextName);
                setFilterOperator(nextOperator);
                setFilterValue(property?.property_type === 'checkbox' ? 'true' : '');
              }}
              value={filterPropertyName}
            >
              <option value="">Property</option>
              {activeProperties.map((property) => (
                <option key={property.id} value={property.name}>{property.name}</option>
              ))}
            </select>
            <select
              aria-label="Filter operator"
              disabled={!filterPropertyName}
              onChange={(event) => setFilterOperator(event.target.value as FilterOperator)}
              value={filterOperator}
            >
              {filterOperators(activeProperties.find((item) => item.name === filterPropertyName)).map((operator) => (
                <option key={operator} value={operator}>{operatorLabel(operator)}</option>
              ))}
            </select>
            {filterOperator !== 'is_empty' ? (
              <FilterValueField
                onChange={setFilterValue}
                property={activeProperties.find((item) => item.name === filterPropertyName)}
                value={filterValue}
              />
            ) : null}
            <button className="button button--primary" onClick={applyFilter} type="button">Apply</button>
            {activeFilter ? (
              <button
                className="text-button"
                onClick={() => {
                  setFilters([]);
                  setFilterPropertyName('');
                  setFilterValue('');
                  setOffset(0);
                }}
                type="button"
              >
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
            <button
              aria-label="Clear filter"
              onClick={() => {
                setFilters([]);
                setFilterPropertyName('');
                setFilterValue('');
                setOffset(0);
              }}
              type="button"
            >
              ×
            </button>
          </div>
        ) : null}

        {rowsError ? (
          <div className="ledger-message ledger-message--error">
            <span>{rowsError}</span>
            <button className="text-button" onClick={() => setRowsRefreshKey((key) => key + 1)} type="button">
              Retry
            </button>
          </div>
        ) : null}

        <div className={`database-table-wrap${rowsLoading ? ' is-loading' : ''}`}>
          {!compactRows ? <table className="database-table">
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
              {rows.map((row) => {
                const rowTitle = titleForRow(row, database.properties);
                const rowArchived = row.archived_at !== null;
                return (
                  <tr className={rowArchived ? 'is-archived' : ''} key={row.id}>
                    {visibleProperties.map((property) => (
                      <td className={property.property_type === 'title' ? 'is-title' : ''} key={property.id}>
                        <CellEditor
                          disabled={rowsLoading || archived || rowArchived || property.archived_at !== null}
                          key={`table-${row.id}-${property.id}-${editorEpoch}`}
                          onCommit={(value) => updateRowValue(row, property, value)}
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
          </table> : null}

          {compactRows ? <div className="database-cards">
            {rows.map((row) => {
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
                          disabled={rowsLoading || archived || rowArchived || property.archived_at !== null}
                          key={`card-${row.id}-${property.id}-${editorEpoch}`}
                          onCommit={(value) => updateRowValue(row, property, value)}
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
          </div> : null}

          {!rowsLoading && rows.length === 0 && !rowsError ? (
            <div className="ledger-empty">
              <span aria-hidden="true">✣</span>
              <h3>{activeFilter ? 'No records match this filter.' : 'This database is open ground.'}</h3>
              <p>{activeFilter ? 'Clear the filter or try another value.' : 'Add the first typed record for humans and agents to share.'}</p>
              {!archived && !activeFilter ? (
                <button className="button button--primary" onClick={() => setCreateRowOpen(true)} type="button">
                  <Icon name="plus" size={16} /> New record
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {total > 0 ? (
          <footer className="database-pagination">
            <span>{firstRowNumber}–{lastRowNumber} of {total}</span>
            <div>
              <button
                className="button button--quiet"
                disabled={offset === 0 || rowsLoading}
                onClick={() => setOffset((value) => Math.max(0, value - ROW_LIMIT))}
                type="button"
              >
                Previous
              </button>
              <button
                className="button button--quiet"
                disabled={!hasMore || rowsLoading}
                onClick={() => setOffset((value) => value + ROW_LIMIT)}
                type="button"
              >
                Next
              </button>
            </div>
          </footer>
        ) : null}
      </section>

      {detailsOpen ? (
        <DatabaseDetailsDialog
          database={database}
          disabled={archived || saveState === 'saving'}
          onArchive={() => {
            setDetailsOpen(false);
            setArchivePrompt(true);
          }}
          onClose={() => setDetailsOpen(false)}
          onSave={(update) => {
            void runMutation(async () => {
              const live = databaseRef.current;
              if (!live) return;
              const response = await api.database({
                action: 'update',
                database_id: live.id,
                revision: live.revision,
                ...update,
              });
              replaceDatabase({ ...response.result, properties: live.properties });
              setDetailsOpen(false);
              await refreshWorkspaceData();
              showToast('Database details saved');
            });
          }}
        />
      ) : null}

      {schemaOpen ? (
        <Modal
          description="Property types stay fixed so every agent sees a stable schema. Names and select choices can evolve."
          onClose={() => setSchemaOpen(false)}
          title="Database schema"
        >
          <div className="schema-dialog">
            <div className="schema-dialog__heading">
              <span>{database.properties.filter((property) => !property.archived_at).length} active properties</span>
              {!archived ? (
                <button
                  className="button button--primary"
                  disabled={database.properties.filter((property) => !property.archived_at).length >= 100}
                  onClick={() => {
                    setSchemaOpen(false);
                    setAddPropertyOpen(true);
                  }}
                  type="button"
                >
                  <Icon name="plus" size={16} /> Add property
                </button>
              ) : null}
            </div>
            <div className="property-list">
              {database.properties.map((property) => (
                <PropertyEditor
                  disabled={archived || saveState === 'saving'}
                  key={property.id}
                  onArchive={() => setPropertyArchived(property, false)}
                  onRestore={() => setPropertyArchived(property, true)}
                  onSave={(update) => updateProperty(property, update)}
                  property={property}
                />
              ))}
            </div>
          </div>
        </Modal>
      ) : null}

      {addPropertyOpen ? (
        <AddPropertyDialog
          disabled={saveState === 'saving'}
          onClose={() => setAddPropertyOpen(false)}
          onCreate={(property) => {
            void runMutation(async () => {
              const live = databaseRef.current;
              if (!live) return;
              const response = await api.database({
                action: 'property_add',
                database_id: live.id,
                property,
                revision: live.revision,
              });
              applyPropertyMutation(response.result);
              setAddPropertyOpen(false);
              await refreshWorkspaceData();
              showToast('Property added');
            });
          }}
        />
      ) : null}

      {createRowOpen ? (
        <CreateRowDialog
          disabled={saveState === 'saving'}
          onClose={() => setCreateRowOpen(false)}
          onCreate={(values, tags, importance) => {
            void runMutation(async () => {
              const response = await api.row({
                action: 'create',
                database_id: databaseId,
                importance,
                tags,
                values,
              });
              setCreateRowOpen(false);
              setOffset(0);
              setRowsRefreshKey((key) => key + 1);
              showToast('Record created');
              navigate({ name: 'database', databaseId, rowId: response.result.id });
            });
          }}
          properties={activeProperties}
        />
      ) : null}

      {rowId ? (
        <RowDetailsDialog
          databaseArchived={archived}
          disabled={saveState === 'saving'}
          onArchive={(row) => setRowArchived(row, false)}
          onClose={() => navigate({ name: 'database', databaseId })}
          onRestore={(row) => setRowArchived(row, true)}
          onSaveDetails={updateRowDetails}
          properties={visibleProperties}
          row={selectedRow}
          key={`row-details-${selectedRow?.id ?? 'loading'}`}
        />
      ) : null}

      {archivePrompt ? (
        <Modal
          description="Normal reads and search will stop returning it. You can restore it from Archive."
          onClose={() => setArchivePrompt(false)}
          title="Archive this database?"
        >
          <div className="modal-actions">
            <button className="button" onClick={() => setArchivePrompt(false)} type="button">Keep database</button>
            <button
              className="button button--danger"
              onClick={() => {
                void runMutation(async () => {
                  const live = databaseRef.current;
                  if (!live) return;
                  const response = await api.database({
                    action: 'archive',
                    database_id: live.id,
                    revision: live.revision,
                  });
                  replaceDatabase({ ...response.result, properties: live.properties });
                  setArchivePrompt(false);
                  await refreshWorkspaceData();
                  showToast('Database moved to archive');
                });
              }}
              type="button"
            >
              Archive database
            </button>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}
