import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DashboardApiError } from '../../api';
import { useMutationState, type MutationIssue } from '../../hooks/editor/useMutationState';
import { useSerializedMutationQueue } from '../../hooks/editor/useSerializedMutationQueue';
import { useDashboard } from '../../shell/DashboardContext';
import type {
  DatabaseProperty,
  DatabasePropertyInput,
  DatabasePropertyMutation,
  DatabaseWithProperties,
  JsonObject,
} from '../../types';
import { useCompactRows } from './useCompactRows';
import { useDatabaseRows } from './useDatabaseRows';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function classifyError(error: unknown): MutationIssue {
  return error instanceof DashboardApiError && error.code === 'CONFLICT'
    ? 'conflict'
    : 'error';
}

export function useDatabaseEditor(databaseId: string, rowId?: string) {
  const { api, navigate, refreshWorkspaceData, showToast, workspace } = useDashboard();
  const [database, setDatabase] = useState<DatabaseWithProperties | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [addPropertyOpen, setAddPropertyOpen] = useState(false);
  const [createRowOpen, setCreateRowOpen] = useState(false);
  const [archivePrompt, setArchivePrompt] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const compactRows = useCompactRows();
  const databaseRef = useRef<DatabaseWithProperties | null>(null);
  const mutationState = useMutationState();

  const replaceDatabase = useCallback((next: DatabaseWithProperties | null) => {
    databaseRef.current = next;
    setDatabase(next);
  }, []);

  const reloadDatabase = useCallback(() => setRetryKey((key) => key + 1), []);
  const handleRowConflict = useCallback(() => {
    setEditorEpoch((epoch) => epoch + 1);
    reloadDatabase();
  }, [reloadDatabase]);

  const activeProperties = useMemo(
    () => database?.properties.filter((property) => property.archived_at === null) ?? [],
    [database?.properties],
  );
  const rowEditor = useDatabaseRows({
    activeProperties,
    database,
    databaseId,
    mutationState,
    onConflict: handleRowConflict,
    rowId,
  });
  const visibleProperties = useMemo(
    () => database?.properties.filter((property) => (
      rowEditor.includeArchived || property.archived_at === null
    )) ?? [],
    [database?.properties, rowEditor.includeArchived],
  );

  const handleMutationError = useCallback((error: unknown, issue: MutationIssue) => {
    if (issue === 'conflict') {
      setEditorEpoch((epoch) => epoch + 1);
      reloadDatabase();
      rowEditor.retrySelectedRow();
      showToast('This changed elsewhere. The latest version is loading.', { tone: 'error' });
    } else {
      showToast(errorMessage(error, 'The change could not be saved'), { tone: 'error' });
    }
  }, [reloadDatabase, rowEditor, showToast]);
  const { run: runMutation } = useSerializedMutationQueue({
    cancelOnError: true,
    classifyError,
    clearIssuesWhenIdle: true,
    mutationState,
    onError: handleMutationError,
  });

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
    rowEditor.retryRows();
  }, [replaceDatabase, rowEditor]);

  const updateProperty = useCallback((
    property: DatabaseProperty,
    update: { name?: string; options?: { choices: string[] } },
  ) => {
    void runMutation(async (signal) => {
      const live = databaseRef.current?.properties.find((item) => item.id === property.id) ?? property;
      return update.name !== undefined
        ? api.database({
            action: 'property_update',
            name: update.name,
            ...(update.options === undefined ? {} : { options: update.options }),
            property_id: live.id,
            revision: live.revision,
          }, { signal })
        : api.database({
            action: 'property_update',
            options: update.options ?? { choices: [] },
            property_id: live.id,
            revision: live.revision,
          }, { signal });
    }, {
      onSuccess: async (response) => {
        applyPropertyMutation(response.result);
        await refreshWorkspaceData();
        showToast('Property saved');
      },
    });
  }, [api, applyPropertyMutation, refreshWorkspaceData, runMutation, showToast]);

  const setPropertyArchived = useCallback((property: DatabaseProperty, restore: boolean) => {
    void runMutation(async (signal) => {
      const live = databaseRef.current?.properties.find((item) => item.id === property.id) ?? property;
      return api.database({
        action: restore ? 'property_restore' : 'property_archive',
        property_id: live.id,
        revision: live.revision,
      }, { signal });
    }, {
      onSuccess: async (response) => {
        applyPropertyMutation(response.result);
        await refreshWorkspaceData();
        showToast(restore ? 'Property restored' : 'Property archived');
      },
    });
  }, [api, applyPropertyMutation, refreshWorkspaceData, runMutation, showToast]);

  const restoreDatabase = useCallback(() => {
    void runMutation(async (signal) => {
      const live = databaseRef.current;
      if (!live) return null;
      return api.database({
        action: 'restore',
        database_id: databaseId,
        revision: live.revision,
      }, { signal });
    }, {
      onSuccess: async (response) => {
        if (!response) return;
        const live = databaseRef.current;
        if (!live) return;
        replaceDatabase({ ...response.result, properties: live.properties });
        await refreshWorkspaceData();
        showToast('Database restored');
      },
    });
  }, [api, databaseId, refreshWorkspaceData, replaceDatabase, runMutation, showToast]);

  const saveDatabaseDetails = useCallback((update: {
    description: string | null;
    name: string;
    tags: string[];
  }) => {
    void runMutation(async (signal) => {
      const live = databaseRef.current;
      if (!live) return null;
      return api.database({
        action: 'update',
        database_id: live.id,
        revision: live.revision,
        ...update,
      }, { signal });
    }, {
      onSuccess: async (response) => {
        if (!response) return;
        const live = databaseRef.current;
        if (!live) return;
        replaceDatabase({ ...response.result, properties: live.properties });
        setDetailsOpen(false);
        await refreshWorkspaceData();
        showToast('Database details saved');
      },
    });
  }, [api, refreshWorkspaceData, replaceDatabase, runMutation, showToast]);

  const addProperty = useCallback((property: DatabasePropertyInput) => {
    void runMutation(async (signal) => {
      const live = databaseRef.current;
      if (!live) return null;
      return api.database({
        action: 'property_add',
        database_id: live.id,
        property,
        revision: live.revision,
      }, { signal });
    }, {
      onSuccess: async (response) => {
        if (!response) return;
        applyPropertyMutation(response.result);
        setAddPropertyOpen(false);
        await refreshWorkspaceData();
        showToast('Property added');
      },
    });
  }, [api, applyPropertyMutation, refreshWorkspaceData, runMutation, showToast]);

  const createRow = useCallback((values: JsonObject, tags: string[], importance: number) => {
    void runMutation((signal) => api.row({
      action: 'create',
      database_id: databaseId,
      importance,
      tags,
      values,
    }, { signal }), {
      onSuccess: (response) => {
        setCreateRowOpen(false);
        rowEditor.setOffset(0);
        rowEditor.retryRows();
        showToast('Record created');
        navigate({ name: 'database', databaseId, rowId: response.result.id });
      },
    });
  }, [api, databaseId, navigate, rowEditor, runMutation, showToast]);

  const archiveDatabase = useCallback(() => {
    void runMutation(async (signal) => {
      const live = databaseRef.current;
      if (!live) return null;
      return api.database({
        action: 'archive',
        database_id: live.id,
        revision: live.revision,
      }, { signal });
    }, {
      onSuccess: async (response) => {
        if (!response) return;
        const live = databaseRef.current;
        if (!live) return;
        replaceDatabase({ ...response.result, properties: live.properties });
        setArchivePrompt(false);
        await refreshWorkspaceData();
        showToast('Database moved to archive');
      },
    });
  }, [api, refreshWorkspaceData, replaceDatabase, runMutation, showToast]);

  const showArchivePromptFromDetails = useCallback(() => {
    setDetailsOpen(false);
    setArchivePrompt(true);
  }, []);
  const showAddProperty = useCallback(() => {
    setSchemaOpen(false);
    setAddPropertyOpen(true);
  }, []);

  return {
    activeProperties,
    addProperty,
    addPropertyOpen,
    archiveDatabase,
    archivePrompt,
    compactRows,
    createRow,
    createRowOpen,
    database,
    detailsOpen,
    editorEpoch,
    loadError,
    loading,
    reloadDatabase,
    restoreDatabase,
    rowEditor,
    saveDatabaseDetails,
    saveState: mutationState.saveState,
    schemaOpen,
    setAddPropertyOpen,
    setArchivePrompt,
    setCreateRowOpen,
    setDetailsOpen,
    setPropertyArchived,
    setSchemaOpen,
    showAddProperty,
    showArchivePromptFromDetails,
    updateProperty,
    visibleProperties,
  };
}
