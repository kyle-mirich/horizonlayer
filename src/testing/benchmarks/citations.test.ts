import { describe, expect, it } from 'vitest';
import type { RagChunk, RagPageCitation, RagRowCitation } from '../../search/rag.js';
import { validateCanonicalHit, type CanonicalHitRow, type Hit } from './citations.js';

type TitleCitation = Extract<RagPageCitation, { part: 'title' }>;
type BlockCitation = Extract<RagPageCitation, { part: 'block' }>;
type BlockRow = Extract<CanonicalHitRow, { block_id: string }>;

const workspaceId = 'primary-workspace';
const pageId = 'canonical-page';
const title = 'Canonical page title';
const updatedAt = '2026-01-01T00:00:00.000Z';
const evidence = 'canonical evidence';
const snippet = `${evidence}\nPage: ${title}`;
const content = `before ${evidence} after`;
const charStart = 'before '.length;
const charEnd = charStart + evidence.length;

function titleCitation(overrides: Partial<TitleCitation> = {}): TitleCitation {
  return { type: 'page', id: pageId, workspace_id: workspaceId, revision: 7, title,
    updated_at: updatedAt, part: 'title', ...overrides };
}

function blockCitation(overrides: Partial<BlockCitation> = {}): BlockCitation {
  return { ...titleCitation(), part: 'block', block_id: 'canonical-block', block_revision: 3,
    block_type: 'text', block_position: 2, char_start: charStart, char_end: charEnd, ...overrides };
}

function canonicalRow(overrides: Partial<BlockRow> = {}): BlockRow {
  return { workspace_id: workspaceId, revision: 7, title, archived_at: null,
    updated_at: new Date(updatedAt), block_id: 'canonical-block', block_revision: 3,
    block_type: 'text', position: 2, content, block_archived: null, ...overrides };
}

function titleHit(overrides: Partial<Hit> = {}): Hit {
  return { id: pageId, workspace_id: workspaceId, revision: 7, title, snippet: title,
    semantic: true, citation: titleCitation(), ...overrides };
}

function blockHit(citationOverrides: Partial<BlockCitation> = {}, hitOverrides: Partial<Hit> = {}): Hit {
  return titleHit({ snippet, citation: blockCitation(citationOverrides), ...hitOverrides });
}

// Deliberately malformed service payloads still need guards at runtime.
function malformedCitation(overrides: Record<string, unknown>, omitted: string[] = []): RagChunk['citation'] {
  const citation: Record<string, unknown> = { ...titleCitation(), ...overrides };
  for (const key of omitted) delete citation[key];
  return citation as unknown as RagChunk['citation'];
}

function expectViolations(hit: Hit, canonical: readonly CanonicalHitRow[], names: string[]): void {
  expect(validateCanonicalHit(hit, canonical, workspaceId)).toEqual(names.map((name) => `${name}:${hit.id}`));
}

describe('independent canonical retrieval citation validation', () => {
  it('accepts an exact title citation', () => {
    expectViolations(titleHit(), [canonicalRow()], []);
  });

  it('accepts an exact block citation and finds it among other canonical blocks', () => {
    expectViolations(blockHit(), [canonicalRow({ block_id: 'other-block', content: 'distractor' }), canonicalRow()], []);
  });

  it('accepts a full-block range, including both boundary offsets', () => {
    expectViolations(blockHit({ char_start: 0, char_end: content.length }, { snippet: `${content}\nPage: ${title}` }), [canonicalRow()], []);
  });

  it('accepts a title on a canonical page without blocks', () => {
    const row: CanonicalHitRow = { ...canonicalRow(), block_id: null, block_revision: null,
      block_type: null, position: null, content: null, block_archived: null };
    expectViolations(titleHit(), [row], []);
    expectViolations(blockHit(), [row], ['invalid-block-citation']);
  });

  it('does not require semantic citations for lexical hits', () => {
    expectViolations(titleHit({ semantic: false, citation: undefined, snippet: 'lexical highlight' }), [canonicalRow()], []);
  });

  it('still validates title and block evidence when a nonsemantic hit supplies a citation', () => {
    expectViolations(titleHit({ semantic: false, snippet: 'wrong title' }), [canonicalRow()], ['invalid-title-citation']);
    expectViolations(blockHit({}, { semantic: false, snippet: 'wrong content' }), [canonicalRow()], ['invalid-block-citation']);
  });

  it('rejects a hit from another workspace', () => {
    expectViolations(titleHit({ workspace_id: 'foreign-workspace' }), [canonicalRow()], ['wrong-workspace-or-missing']);
  });

  it('rejects canonical evidence from another workspace even when the hit claims the expected workspace', () => {
    expectViolations(titleHit(), [canonicalRow({ workspace_id: 'foreign-workspace' })], ['wrong-workspace-or-missing']);
  });

  it('rejects a missing hit workspace', () => {
    const hit = titleHit();
    const { workspace_id: _workspace, ...missingWorkspace } = hit;
    expectViolations(missingWorkspace as Hit, [canonicalRow()], ['wrong-workspace-or-missing']);
  });

  it('rejects a missing canonical workspace', () => {
    const { workspace_id: _workspace, ...missingWorkspace } = canonicalRow();
    expectViolations(titleHit(), [missingWorkspace as CanonicalHitRow], ['wrong-workspace-or-missing']);
  });

  it('rejects a missing canonical record for a lexical hit', () => {
    expectViolations(titleHit({ semantic: false, citation: undefined }), [], ['wrong-workspace-or-missing']);
  });

  it('reports all independent failures when a semantic title record is missing', () => {
    expectViolations(titleHit(), [], ['wrong-workspace-or-missing', 'invalid-page-citation', 'invalid-title-citation']);
  });

  it('reports all independent failures when a semantic block record is missing', () => {
    expectViolations(blockHit(), [], ['wrong-workspace-or-missing', 'invalid-page-citation', 'invalid-block-citation']);
  });

  it('rejects an archived canonical page', () => {
    expectViolations(titleHit(), [canonicalRow({ archived_at: new Date('2026-01-02T00:00:00.000Z') })], ['archived']);
  });

  it.each([
    { label: 'revision', overrides: { revision: 8 } },
    { label: 'title', overrides: { title: 'Renamed canonical page' } },
  ])('rejects a stale hit when the canonical page $label changed', ({ overrides }) => {
    expectViolations(titleHit({ semantic: false, citation: undefined }), [canonicalRow(overrides)], ['stale-page']);
  });

  it('rejects a changed canonical timestamp independently of revision and title', () => {
    expectViolations(blockHit(), [canonicalRow({ updated_at: new Date('2026-01-02T00:00:00.000Z') })], ['invalid-page-citation']);
  });

  it('rejects a semantic hit with no citation', () => {
    expectViolations(titleHit({ citation: undefined }), [canonicalRow()], ['invalid-page-citation']);
  });

  it('rejects a row citation in this page-only benchmark', () => {
    const citation: RagRowCitation = { type: 'row', id: pageId, workspace_id: workspaceId,
      revision: 7, title, updated_at: updatedAt, database_id: 'database', database_name: 'Rows',
      database_description: null, properties: [] };
    expectViolations(titleHit({ citation }), [canonicalRow()], ['invalid-page-citation']);
  });

  it.each([
    { label: 'record id', overrides: { id: 'another-page' } },
    { label: 'workspace', overrides: { workspace_id: 'foreign-workspace' } },
    { label: 'revision', overrides: { revision: 6 } },
    { label: 'title', overrides: { title: 'Old title' } },
    { label: 'timestamp', overrides: { updated_at: '2025-12-31T00:00:00.000Z' } },
  ])('rejects a semantic citation with the wrong $label', ({ overrides }) => {
    expectViolations(titleHit({ citation: titleCitation(overrides) }), [canonicalRow()], ['invalid-page-citation']);
  });

  it.each(['type', 'part', 'workspace_id', 'updated_at'])('rejects a semantic citation missing %s', (field) => {
    expectViolations(titleHit({ citation: malformedCitation({}, [field]) }), [canonicalRow()], ['invalid-page-citation']);
  });

  it.each([
    { type: 'unsupported' },
    { part: 'properties' },
  ])('rejects unsupported semantic citation metadata %j', (overrides) => {
    expectViolations(titleHit({ citation: malformedCitation(overrides) }), [canonicalRow()], ['invalid-page-citation']);
  });

  it('rejects a title snippet that differs from the canonical title', () => {
    expectViolations(titleHit({ snippet: 'Canonical page' }), [canonicalRow()], ['invalid-title-citation']);
  });

  it('reports page and title failures independently when the canonical title changed', () => {
    expectViolations(titleHit(), [canonicalRow({ title: 'Renamed page' })], ['stale-page', 'invalid-title-citation']);
  });

  it('rejects a citation to a missing canonical block', () => {
    expectViolations(blockHit({ block_id: 'missing-block' }), [canonicalRow()], ['invalid-block-citation']);
  });

  it('rejects an archived canonical block', () => {
    expectViolations(blockHit(), [canonicalRow({ block_archived: new Date('2026-01-02T00:00:00.000Z') })], ['invalid-block-citation']);
  });

  it.each([
    { label: 'revision', overrides: { block_revision: 4 } },
    { label: 'type', overrides: { block_type: 'heading' as const } },
    { label: 'position', overrides: { position: 3 } },
    { label: 'content', overrides: { content: content.replace(evidence, 'different evidence') } },
  ])('rejects block evidence after its canonical $label changed', ({ overrides }) => {
    expectViolations(blockHit(), [canonicalRow(overrides)], ['invalid-block-citation']);
  });

  it.each([
    { label: 'revision', overrides: { block_revision: 2 } },
    { label: 'type', overrides: { block_type: 'code' as const } },
    { label: 'position', overrides: { block_position: 1 } },
  ])('rejects a block citation with the wrong $label', ({ overrides }) => {
    expectViolations(blockHit(overrides), [canonicalRow()], ['invalid-block-citation']);
  });

  it.each([
    { label: 'negative start', start: -1, end: charEnd },
    { label: 'fractional start', start: charStart + 0.5, end: charEnd },
    { label: 'fractional end', start: charStart, end: charEnd + 0.5 },
    { label: 'NaN start', start: NaN, end: charEnd },
    { label: 'NaN end', start: charStart, end: NaN },
    { label: 'infinite start', start: Infinity, end: charEnd },
    { label: 'infinite end', start: charStart, end: Infinity },
    { label: 'empty range', start: charStart, end: charStart },
    { label: 'reversed range', start: charEnd, end: charStart },
    { label: 'end beyond content', start: charStart, end: content.length + 1 },
    { label: 'start beyond content', start: content.length + 1, end: content.length + 2 },
  ])('rejects a block citation with $label', ({ start, end }) => {
    expectViolations(blockHit({ char_start: start, char_end: end }), [canonicalRow()], ['invalid-block-citation']);
  });

  it.each([
    { label: 'shifted start', overrides: { char_start: charStart + 1 } },
    { label: 'shifted end', overrides: { char_end: charEnd - 1 } },
  ])('rejects an in-bounds block range with a $label that does not match the snippet', ({ overrides }) => {
    expectViolations(blockHit(overrides), [canonicalRow()], ['invalid-block-citation']);
  });

  it('rejects a snippet that does not exactly match the cited block slice', () => {
    expectViolations(blockHit({}, { snippet: snippet.toUpperCase() }), [canonicalRow()], ['invalid-block-citation']);
  });

  it.each([
    { label: 'missing page context', rendered: evidence },
    { label: 'wrong context title', rendered: `${evidence}\nPage: Old title` },
    { label: 'wrong context format', rendered: `${evidence} Page: ${title}` },
    { label: 'extra context suffix', rendered: `${snippet}\nPage: ${title}` },
  ])('rejects a block snippet with $label', ({ rendered }) => {
    expectViolations(blockHit({}, { snippet: rendered }), [canonicalRow()], ['invalid-block-citation']);
  });

  it('uses the canonical page title when checking block context', () => {
    expectViolations(blockHit(), [canonicalRow({ title: 'Renamed canonical page' })], ['stale-page', 'invalid-block-citation']);
  });
});
