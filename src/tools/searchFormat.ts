import type { SearchRecordsResult } from '../db/queries/search.js';
import { compactReference } from '../references.js';
import type {
  RagPageCitation,
  RagRowCitation,
  RagSearchResult,
} from '../search/rag.js';

export type SearchFormat = 'compact' | 'full';

function compactDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Search result contained an invalid timestamp');
  return date.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function compactScore(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function compactSnippet(value: string): string {
  const maximum = 280;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function compactSource(citation: RagPageCitation | RagRowCitation) {
  if (citation.type === 'page') {
    return {
      ref: compactReference('page', citation.id),
      title: citation.title,
      rev: citation.revision,
      updated: compactDate(citation.updated_at),
    };
  }
  return {
    ref: compactReference('row', citation.id),
    title: citation.title,
    rev: citation.revision,
    updated: compactDate(citation.updated_at),
    database_ref: compactReference('database', citation.database_id),
    database: citation.database_name,
  };
}

function compactPageCitation(citation: RagPageCitation, source: number) {
  const base = {
    source,
    part: citation.part,
  };
  if (citation.part === 'title') return base;
  return {
    ...base,
    block_ref: compactReference('block', citation.block_id),
    block_rev: citation.block_revision,
    block_type: citation.block_type,
    block_pos: citation.block_position,
    chars: [citation.char_start, citation.char_end],
  };
}

function compactRowCitation(citation: RagRowCitation, source: number) {
  return {
    source,
    properties: citation.properties.map((property) => ({
      ref: compactReference('property', property.id),
      name: property.name,
    })),
  };
}

function sourceKey(citation: RagPageCitation | RagRowCitation): string {
  return `${citation.type}:${citation.id}`;
}

export function formatRecordSearch(result: SearchRecordsResult, format: SearchFormat) {
  if (format === 'full') return { mode: 'records' as const, format, ...result };
  return {
    mode: 'records' as const,
    format,
    records: result.records.map((record) => ({
      ref: compactReference(record.type, record.id),
      title: record.title,
      score: compactScore(record.score),
      snippet: compactSnippet(record.snippet),
      rev: record.revision,
      updated: compactDate(record.updated_at),
      ...(record.database_id
        ? { database_ref: compactReference('database', record.database_id) }
        : {}),
    })),
    truncated: result.truncated,
  };
}

export function formatRagSearch(result: RagSearchResult, format: SearchFormat) {
  if (format === 'full') return { mode: 'rag' as const, format, ...result };

  const sourceIndexes = new Map<string, number>();
  const sources: Array<ReturnType<typeof compactSource>> = [];
  const chunks = result.chunks.map((chunk) => {
    const key = sourceKey(chunk.citation);
    let source = sourceIndexes.get(key);
    if (source === undefined) {
      source = sources.length;
      sourceIndexes.set(key, source);
      sources.push(compactSource(chunk.citation));
    }
    return {
      rank: chunk.rank,
      score: compactScore(chunk.score),
      text: chunk.text,
      citation: chunk.citation.type === 'page'
        ? compactPageCitation(chunk.citation, source)
        : compactRowCitation(chunk.citation, source),
    };
  });

  return {
    mode: 'rag' as const,
    format,
    sources,
    chunks,
    truncated: result.truncated,
    ...(result.stale !== undefined ? { stale: result.stale } : {}),
  };
}
