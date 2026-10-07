import type { RagChunk, RagPageCitation } from '../../search/rag.js';

export interface Hit {
  id: string;
  workspace_id: string;
  revision: number;
  title: string;
  snippet: string;
  semantic?: boolean;
  citation?: RagChunk['citation'];
}

interface CanonicalPage {
  workspace_id: string;
  revision: number;
  title: string;
  archived_at: Date | null;
  updated_at: Date;
}

interface CanonicalBlock {
  block_id: string;
  block_revision: number;
  block_type: Extract<RagPageCitation, { part: 'block' }>['block_type'];
  position: number;
  content: string;
  block_archived: Date | null;
}

// A page without blocks still appears in the benchmark's LEFT JOIN.
export type CanonicalHitRow = CanonicalPage & (CanonicalBlock | {
  block_id: null;
  block_revision: null;
  block_type: null;
  position: null;
  content: null;
  block_archived: null;
});

/** Validate retrieved evidence against independently read canonical SQL rows. */
export function validateCanonicalHit(hit: Hit, canonical: readonly CanonicalHitRow[], workspaceId: string): string[] {
  const violations: string[] = [];
  const page = canonical[0];
  if (!page || page.workspace_id !== workspaceId || hit.workspace_id !== workspaceId) violations.push(`wrong-workspace-or-missing:${hit.id}`);
  if (page?.archived_at) violations.push(`archived:${hit.id}`);
  if (page && (page.revision !== hit.revision || page.title !== hit.title)) violations.push(`stale-page:${hit.id}`);
  const citation = hit.citation;
  if (hit.semantic && (!citation || citation.type !== 'page' || citation.id !== hit.id
    || citation.workspace_id !== workspaceId || citation.revision !== hit.revision
    || citation.title !== hit.title || (citation.part !== 'title' && citation.part !== 'block')
    || citation.updated_at !== page?.updated_at.toISOString())) violations.push(`invalid-page-citation:${hit.id}`);
  if (citation?.type === 'page' && citation.part === 'block') {
    const block = canonical.find((row): row is CanonicalPage & CanonicalBlock => row.block_id === citation.block_id);
    // Public RAG block text includes page-title context outside the cited offsets.
    if (!block || block.block_archived || block.block_revision !== citation.block_revision
        || block.block_type !== citation.block_type || block.position !== citation.block_position
        || !Number.isInteger(citation.char_start) || !Number.isInteger(citation.char_end)
        || citation.char_start < 0 || citation.char_end <= citation.char_start || citation.char_end > block.content.length
        || `${block.content.slice(citation.char_start, citation.char_end)}\nPage: ${page.title}` !== hit.snippet) violations.push(`invalid-block-citation:${hit.id}`);
  }
  if (citation?.type === 'page' && citation.part === 'title' && page?.title !== hit.snippet) violations.push(`invalid-title-citation:${hit.id}`);
  return violations;
}
