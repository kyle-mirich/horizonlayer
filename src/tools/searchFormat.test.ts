import { describe, expect, it } from 'vitest';
import type { SearchRecordsResult } from '../db/queries/search.js';
import type { RagSearchResult } from '../search/rag.js';
import { formatRagSearch, formatRecordSearch } from './searchFormat.js';

const ids = {
  workspace: 'b4899176-74dd-4a7e-852a-d41e80be7d36',
  page: 'c2b12324-eb92-4d55-a884-2b61d0b4fd30',
  block: '782aa321-7380-45c5-8b7d-6dbdbec8877a',
  database: '45d401c2-c722-4d18-b14c-5864653cc84c',
  row: 'effb8d7a-41ae-45f1-bca5-8bd649535ef8',
  property: 'd7d4919a-4a30-4ddd-b2d2-a6751cbb7eaf',
};

describe('compact search formatting', () => {
  const records: SearchRecordsResult = {
    records: [{
      id: ids.page,
      type: 'page',
      title: 'Native macOS product direction',
      score: 0.6475000014901161,
      snippet: 'A concise product decision.',
      workspace_id: ids.workspace,
      session_id: null,
      parent_page_id: null,
      database_id: null,
      tags: ['product'],
      importance: 0.95,
      revision: 3,
      created_at: '2026-07-22T23:45:29.811Z',
      updated_at: '2026-07-23T04:45:29.811Z',
    }],
    truncated: false,
  };

  it('removes repeated scope metadata and shortens scores, dates, and IDs', () => {
    expect(formatRecordSearch(records, 'compact')).toEqual({
      mode: 'records',
      format: 'compact',
      records: [{
        ref: 'p_wrEjJOuSTVWohCth0LT9MA',
        title: 'Native macOS product direction',
        score: 0.648,
        snippet: 'A concise product decision.',
        rev: 3,
        updated: '2026-07-23T04:45:29Z',
      }],
      truncated: false,
    });
  });

  it('preserves the canonical response on request', () => {
    expect(formatRecordSearch(records, 'full')).toEqual({
      mode: 'records',
      format: 'full',
      ...records,
    });
  });

  it('keeps row database identity and a bounded excerpt in compact record results', () => {
    const rowResult: SearchRecordsResult = {
      records: [{
        ...records.records[0]!,
        id: ids.row,
        type: 'row',
        database_id: ids.database,
        score: 0.12349,
        snippet: 'x'.repeat(300),
      }],
      truncated: true,
    };

    expect(formatRecordSearch(rowResult, 'compact')).toMatchObject({
      truncated: true,
      records: [{
        ref: expect.stringMatching(/^r_/u),
        database_ref: expect.stringMatching(/^d_/u),
        score: 0.123,
        snippet: `${'x'.repeat(279)}…`,
      }],
    });
  });

  it('compacts block citations without losing actionable coordinates', () => {
    const rag: RagSearchResult = {
      chunks: [{
        rank: 1,
        score: 0.8777861,
        text: 'Product decision',
        citation: {
          type: 'page',
          part: 'block',
          id: ids.page,
          workspace_id: ids.workspace,
          title: 'Native macOS product direction',
          revision: 3,
          updated_at: '2026-07-23T04:45:29.811Z',
          block_id: ids.block,
          block_revision: 2,
          block_type: 'heading',
          block_position: 0,
          char_start: 0,
          char_end: 16,
        },
      }],
      truncated: false,
    };

    const formatted = formatRagSearch(rag, 'compact');
    expect(formatted).toMatchObject({
      mode: 'rag',
      format: 'compact',
      sources: [{
        ref: 'p_wrEjJOuSTVWohCth0LT9MA',
        title: 'Native macOS product direction',
        rev: 3,
        updated: '2026-07-23T04:45:29Z',
      }],
      chunks: [{
        score: 0.878,
        citation: {
          source: 0,
          block_ref: 'b_eCqjIXOARcWLfW29vsiHeg',
          block_rev: 2,
          block_pos: 0,
          chars: [0, 16],
        },
      }],
    });
    expect('sources' in formatted && formatted.sources).toHaveLength(1);
  });

  it('keeps row database and property references in the deduplicated citation map', () => {
    const rag: RagSearchResult = {
      chunks: [{
        rank: 1,
        score: 0.75,
        text: 'Status: approved',
        citation: {
          type: 'row',
          id: ids.row,
          workspace_id: ids.workspace,
          database_id: ids.database,
          database_name: 'Decisions',
          database_description: 'Product decisions',
          title: 'Desktop packaging',
          revision: 2,
          updated_at: '2026-07-23T04:45:29.811Z',
          properties: [{ id: ids.property, name: 'Status' }],
        },
      }],
      truncated: false,
    };

    expect(formatRagSearch(rag, 'compact')).toMatchObject({
      sources: [{
        ref: expect.stringMatching(/^r_/u),
        database_ref: expect.stringMatching(/^d_/u),
        database: 'Decisions',
      }],
      chunks: [{
        citation: {
          source: 0,
          properties: [{ ref: expect.stringMatching(/^f_/u), name: 'Status' }],
        },
      }],
    });
  });

  it('deduplicates title citations, preserves full RAG responses, and rejects invalid timestamps', () => {
    const titleCitation = {
      type: 'page' as const,
      part: 'title' as const,
      id: ids.page,
      workspace_id: ids.workspace,
      title: 'Native macOS product direction',
      revision: 3,
      updated_at: '2026-07-23T04:45:29.811Z',
    };
    const rag: RagSearchResult = {
      chunks: [
        { rank: 1, score: 0.5, text: 'title one', citation: titleCitation },
        { rank: 2, score: 0.4, text: 'title two', citation: titleCitation },
      ],
      truncated: true,
    };

    expect(formatRagSearch(rag, 'compact')).toMatchObject({
      sources: [{ ref: expect.stringMatching(/^p_/u) }],
      chunks: [
        { citation: { source: 0, part: 'title' } },
        { citation: { source: 0, part: 'title' } },
      ],
      truncated: true,
    });
    expect(formatRagSearch(rag, 'full')).toEqual({ mode: 'rag', format: 'full', ...rag });
    expect(() => formatRagSearch({
      ...rag,
      chunks: [{ ...rag.chunks[0]!, citation: { ...titleCitation, updated_at: 'invalid' } }],
    }, 'compact')).toThrow('Search result contained an invalid timestamp');
  });
});
