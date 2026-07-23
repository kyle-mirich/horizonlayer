import { useEffect, useRef, useState } from 'react';

import type { DashboardApiClient } from '../api';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import type { RagChunk, SearchRecord, Workspace } from '../types';
import type { DashboardRouteTarget } from './routing';

type SearchMode = 'rag' | 'records';
type PaletteResult =
  | { kind: 'rag'; value: RagChunk }
  | { kind: 'record'; value: SearchRecord };

function resultKey(result: PaletteResult): string {
  if (result.kind === 'record') return `record-${result.value.type}-${result.value.id}`;
  const citation = result.value.citation;
  return `rag-${citation.type}-${citation.id}-${result.value.rank}`;
}

function resultTitle(result: PaletteResult): string {
  if (result.kind === 'record') return result.value.title;
  const citation = result.value.citation;
  return citation.type === 'row' ? citation.title : citation.title;
}

function resultContext(result: PaletteResult): string {
  if (result.kind === 'record') {
    return result.value.type === 'page' ? 'Page' : 'Database row';
  }
  const citation = result.value.citation;
  if (citation.type === 'row') return `${citation.database_name} · row passage`;
  return citation.part === 'title' ? 'Page title' : `Page block · ${citation.block_type}`;
}

function resultSnippet(result: PaletteResult): string {
  return result.kind === 'record' ? result.value.snippet : result.value.text;
}

function resultRoute(result: PaletteResult): DashboardRouteTarget | null {
  if (result.kind === 'record') {
    if (result.value.type === 'page') return { name: 'page', pageId: result.value.id };
    return result.value.database_id
      ? { name: 'database', databaseId: result.value.database_id, rowId: result.value.id }
      : null;
  }
  const citation = result.value.citation;
  return citation.type === 'page'
    ? { name: 'page', pageId: citation.id }
    : { name: 'database', databaseId: citation.database_id, rowId: citation.id };
}

export function SearchPalette({
  api,
  onClose,
  onNavigate,
  ragEnabled,
  workspace,
}: {
  api: DashboardApiClient;
  onClose(): void;
  onNavigate(route: DashboardRouteTarget): void;
  ragEnabled: boolean;
  workspace: Workspace;
}) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('records');
  const [results, setResults] = useState<PaletteResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const search = query.trim();
    if (!search) {
      setResults([]);
      setError(null);
      setLoading(false);
      setSelected(0);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void api.search({
        limit: mode === 'records' ? 15 : 10,
        mode,
        query: search,
        scope: { kind: 'workspace', workspace_id: workspace.id },
      }, { signal: controller.signal }).then((envelope) => {
        if (sequence !== requestSequence.current) return;
        setResults(envelope.result.mode === 'records'
          ? envelope.result.records.map((value) => ({ kind: 'record' as const, value }))
          : envelope.result.chunks.map((value) => ({ kind: 'rag' as const, value })));
        setSelected(0);
      }).catch((caught: unknown) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setResults([]);
        setError(caught instanceof Error ? caught.message : 'Search could not be completed.');
      }).finally(() => {
        if (!controller.signal.aborted && sequence === requestSequence.current) setLoading(false);
      });
    }, 220);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, mode, query, workspace.id]);

  const selectedResult = results[selected] ?? null;

  function changeMode(nextMode: SearchMode) {
    requestSequence.current += 1;
    setMode(nextMode);
    setResults([]);
    setSelected(0);
    setError(null);
    setLoading(Boolean(query.trim()));
  }

  function choose(result: PaletteResult) {
    const route = resultRoute(result);
    if (!route) return;
    onNavigate(route);
    onClose();
  }

  return (
    <Modal
      description={`Search pages and rows in ${workspace.name}.`}
      onClose={onClose}
      title="Search knowledge"
    >
      <div className="search-palette">
        <div className="search-palette__input">
          <Icon name="search" size={19} />
          <input
            aria-controls="search-results"
            aria-activedescendant={selectedResult ? `search-result-${selected}` : undefined}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-label="Search query"
            autoComplete="off"
            onChange={(event) => {
              const nextQuery = event.target.value;
              requestSequence.current += 1;
              setQuery(nextQuery);
              setResults([]);
              setSelected(0);
              setError(null);
              setLoading(Boolean(nextQuery.trim()));
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelected((value) => results.length === 0 ? 0 : (value + 1) % results.length);
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected((value) => results.length === 0 ? 0 : (value - 1 + results.length) % results.length);
              }
              if (event.key === 'Enter' && selectedResult) {
                event.preventDefault();
                choose(selectedResult);
              }
            }}
            placeholder={mode === 'records' ? 'Find a page or row…' : 'Describe what you need to retrieve…'}
            role="combobox"
            value={query}
          />
          {loading ? <span className="search-palette__spinner" aria-label="Searching" /> : <kbd>↵</kbd>}
        </div>

        <div className="search-modes" aria-label="Search mode">
          <button
            aria-pressed={mode === 'records'}
            onClick={() => changeMode('records')}
            type="button"
          ><Icon name="search" size={15} /> Records <small>Pages + rows</small></button>
          <button
            aria-pressed={mode === 'rag'}
            disabled={!ragEnabled}
            onClick={() => changeMode('rag')}
            title={ragEnabled ? 'Semantic RAG retrieval' : 'Start local vector search to use passages'}
            type="button"
          ><Icon name="spark" size={15} /> Passages <small>{ragEnabled ? 'Local RAG' : 'Unavailable'}</small></button>
        </div>

        <div className="search-results" id="search-results" role="listbox" aria-label="Search results">
          {!query.trim() ? (
            <div className="search-guidance">
              <span className="search-guidance__ring" aria-hidden="true"><i /><i /><i /></span>
              <p><strong>Search the real records.</strong> Switch to Passages when you want semantic retrieval across every block and row.</p>
            </div>
          ) : null}
          {error ? (
            <div className="search-message search-message--error" role="alert">
              <Icon name="warning" size={18} /><span><strong>Search stopped</strong>{error}</span>
            </div>
          ) : null}
          {!loading && !error && query.trim() && results.length === 0 ? (
            <div className="search-message"><span><strong>No matches</strong>Try a different word or search mode.</span></div>
          ) : null}
          {results.map((result, index) => (
            <button
              aria-selected={index === selected}
              className={`search-result${index === selected ? ' search-result--selected' : ''}`}
              id={`search-result-${index}`}
              key={resultKey(result)}
              onClick={() => choose(result)}
              onMouseEnter={() => setSelected(index)}
              role="option"
              type="button"
            >
              <span className={`entity-glyph entity-glyph--${result.kind === 'rag' ? 'rag' : result.value.type}`}>
                <Icon name={result.kind === 'rag' ? 'spark' : result.value.type === 'page' ? 'page' : 'database'} size={16} />
              </span>
              <span className="search-result__copy">
                <span><strong>{resultTitle(result)}</strong><small>{resultContext(result)}</small></span>
                <p>{resultSnippet(result)}</p>
              </span>
              <Icon name="chevron-right" size={15} />
            </button>
          ))}
        </div>
        <footer className="search-palette__footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span>
        </footer>
      </div>
    </Modal>
  );
}
