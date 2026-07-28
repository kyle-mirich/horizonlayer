import { useCallback, useEffect, useRef, useState } from 'react';

import { DashboardApiError } from '../../api';
import { useKeyedMutationQueue } from '../../hooks/editor/useKeyedMutationQueue';
import type { MutationIssue, MutationStateController } from '../../hooks/editor/useMutationState';
import { useDashboard } from '../../shell/DashboardContext';
import type {
  DatabaseProperty,
  DatabaseRow,
  DatabaseWithProperties,
  JsonValue,
  RowFilter,
} from '../../types';
import {
  filterOperators,
  type FilterOperator,
  type SortDirection,
} from './controls/DatabaseControlUtils';

const ROW_LIMIT = 50;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function classifyError(error: unknown): MutationIssue {
  return error instanceof DashboardApiError && error.code === 'CONFLICT'
    ? 'conflict'
    : 'error';
}

export function useDatabaseRows({
  activeProperties,
  database,
  databaseId,
  mutationState,
  onConflict,
  rowId,
}: {
  activeProperties: DatabaseProperty[];
  database: DatabaseWithProperties | null;
  databaseId: string;
  mutationState: MutationStateController;
  onConflict(): void;
  rowId?: string;
}) {
  const { api, navigate, showToast } = useDashboard();
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [selectedRow, setSelectedRow] = useState<DatabaseRow | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);
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
  const [rowsRefreshKey, setRowsRefreshKey] = useState(0);
  const [selectedRefreshKey, setSelectedRefreshKey] = useState(0);

  const rowsRef = useRef<DatabaseRow[]>([]);
  const rowStateRef = useRef(new Map<string, DatabaseRow>());
  const selectedRowRef = useRef<DatabaseRow | null>(null);

  const applyRow = useCallback((next: DatabaseRow) => {
    rowStateRef.current.set(next.id, next);
    const nextRows = rowsRef.current.map((row) => row.id === next.id ? next : row);
    rowsRef.current = nextRows;
    setRows(nextRows);
    if (selectedRowRef.current?.id === next.id) {
      selectedRowRef.current = next;
      setSelectedRow(next);
    }
  }, []);

  const currentRow = useCallback((id: string): DatabaseRow | null => {
    if (selectedRowRef.current?.id === id) return selectedRowRef.current;
    return rowsRef.current.find((row) => row.id === id)
      ?? rowStateRef.current.get(id)
      ?? null;
  }, []);

  const handleRowError = useCallback((error: unknown, issue: MutationIssue) => {
    if (issue === 'conflict') {
      onConflict();
      showToast('This changed elsewhere. The latest version is loading.', { tone: 'error' });
    } else {
      showToast(errorMessage(error, 'The change could not be saved'), { tone: 'error' });
    }
  }, [onConflict, showToast]);

  const handleRowFailure = useCallback((id: string) => {
    rowStateRef.current.delete(id);
    setRowsRefreshKey((key) => key + 1);
    if (selectedRowRef.current?.id === id) {
      setSelectedRefreshKey((key) => key + 1);
    }
  }, []);

  const { enqueue: enqueueRowMutation, hasPending: hasPendingRowMutation } = useKeyedMutationQueue<DatabaseRow>({
    apply: applyRow,
    classifyError,
    clearIssuesWhenIdle: true,
    getCurrent: currentRow,
    mutationState,
    onError: handleRowError,
    onFailure: handleRowFailure,
    statusKey: (id) => `row:${id}`,
  });

  const replaceRows = useCallback((next: DatabaseRow[]) => {
    const authoritative = next.map((row) => {
      const cached = hasPendingRowMutation(row.id) ? rowStateRef.current.get(row.id) : undefined;
      const resolved = cached ?? row;
      rowStateRef.current.set(row.id, resolved);
      return resolved;
    });
    rowsRef.current = authoritative;
    setRows(authoritative);
  }, [hasPendingRowMutation]);

  const replaceSelectedRow = useCallback((next: DatabaseRow | null) => {
    const cached = next && hasPendingRowMutation(next.id)
      ? rowStateRef.current.get(next.id)
      : undefined;
    const resolved = cached ?? next;
    if (resolved) rowStateRef.current.set(resolved.id, resolved);
    selectedRowRef.current = resolved;
    setSelectedRow(resolved);
  }, [hasPendingRowMutation]);

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
    if (database?.archived_at || row.archived_at) return;
    enqueueRowMutation(row.id, async (live, signal) => {
      const response = await api.row({
        action: 'update',
        revision: live.revision,
        row_id: live.id,
        values: { [property.name]: value },
      }, { signal });
      return response.result;
    });
  }, [api, database?.archived_at, enqueueRowMutation]);

  const updateRowDetails = useCallback((
    row: DatabaseRow,
    values: Record<string, JsonValue>,
    tags: string[],
    importance: number,
  ) => {
    enqueueRowMutation(row.id, async (live, signal) => {
      const response = await api.row({
        action: 'update',
        importance,
        revision: live.revision,
        row_id: live.id,
        tags,
        values,
      }, { signal });
      signal.throwIfAborted();
      showToast('Record details saved');
      return response.result;
    });
  }, [api, enqueueRowMutation, showToast]);

  const setRowArchived = useCallback((row: DatabaseRow, restore: boolean) => {
    enqueueRowMutation(row.id, async (live, signal) => {
      const response = await api.row({
        action: restore ? 'restore' : 'archive',
        revision: live.revision,
        row_id: live.id,
      }, { signal });
      signal.throwIfAborted();
      showToast(restore ? 'Record restored' : 'Record archived');
      if (!includeArchived && !restore) {
        setRowsRefreshKey((key) => key + 1);
        if (rowId === live.id) navigate({ name: 'database', databaseId });
      }
      return response.result;
    });
  }, [api, databaseId, enqueueRowMutation, includeArchived, navigate, rowId, showToast]);

  const applyFilter = useCallback(() => {
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
  }, [activeProperties, filterOperator, filterPropertyName, filterValue, showToast]);

  const clearFilter = useCallback(() => {
    setFilters([]);
    setFilterPropertyName('');
    setFilterValue('');
    setOffset(0);
  }, []);

  const selectFilterProperty = useCallback((name: string) => {
    const property = activeProperties.find((item) => item.name === name);
    setFilterPropertyName(name);
    setFilterOperator(filterOperators(property)[0] ?? 'contains');
    setFilterValue(property?.property_type === 'checkbox' ? 'true' : '');
  }, [activeProperties]);

  const retryRows = useCallback(() => setRowsRefreshKey((key) => key + 1), []);
  const retrySelectedRow = useCallback(() => setSelectedRefreshKey((key) => key + 1), []);

  return {
    applyFilter,
    clearFilter,
    filterOpen,
    filterOperator,
    filterPropertyName,
    filters,
    filterValue,
    hasMore,
    includeArchived,
    offset,
    retryRows,
    retrySelectedRow,
    rowLimit: ROW_LIMIT,
    rows,
    rowsError,
    rowsLoading,
    selectFilterProperty,
    selectedRow,
    setFilterOpen,
    setFilterOperator,
    setFilterValue,
    setIncludeArchived,
    setOffset,
    setRowArchived,
    setSortBy,
    setSortDirection,
    sortBy,
    sortDirection,
    total,
    updateRowDetails,
    updateRowValue,
  };
}
