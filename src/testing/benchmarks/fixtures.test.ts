import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface FixtureDocument {
  id: string;
  workspace: 'primary' | 'foreign';
  title: string;
  content: string;
  tags: string[];
  archived?: boolean;
}

interface FixtureQuery {
  id: string;
  split: 'dev' | 'heldout';
  family: string;
  kind: 'lexical' | 'paraphrase' | 'hard-negative' | 'negative';
  query: string;
  relevance: Record<string, number>;
}

const documents = JSON.parse(readFileSync(
  new URL('../../../benchmarks/fixtures/v1/documents.json', import.meta.url), 'utf8'
)) as FixtureDocument[];
const queries = JSON.parse(readFileSync(
  new URL('../../../benchmarks/fixtures/v1/queries.json', import.meta.url), 'utf8'
)) as FixtureQuery[];
const documentById = new Map(documents.map((document) => [document.id, document]));
const activePrimary = documents.filter((document) =>
  document.workspace === 'primary' && !document.archived
);

describe('authored synthetic retrieval fixture v1', () => {
  it('contains the versioned corpus and query dimensions', () => {
    expect(activePrimary).toHaveLength(120);
    expect(documents).toHaveLength(136);
    expect(queries).toHaveLength(80);
    expect(activePrimary.length).toBeGreaterThanOrEqual(100);
    expect(activePrimary.length).toBeLessThanOrEqual(200);
    expect(queries.length).toBeGreaterThanOrEqual(60);
    expect(queries.length).toBeLessThanOrEqual(100);
    expect(documents.filter((document) => document.workspace === 'foreign')).toHaveLength(8);
    expect(documents.filter((document) => document.archived)).toHaveLength(8);
  });

  it('uses unique IDs and complete searchable document records', () => {
    expect(documentById.size).toBe(documents.length);
    expect(new Set(queries.map((query) => query.id)).size).toBe(queries.length);
    expect(new Set(queries.map((query) => query.query)).size).toBe(queries.length);

    for (const document of documents) {
      expect(document.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(['primary', 'foreign']).toContain(document.workspace);
      expect(document.title.trim().length).toBeGreaterThan(10);
      expect(document.content.trim().length).toBeGreaterThan(120);
      expect(Array.isArray(document.tags)).toBe(true);
      expect(document.tags.every((tag) => typeof tag === 'string' && tag.length > 0)).toBe(true);
      expect(document.tags.filter((tag) => tag.startsWith('family:'))).toHaveLength(1);
      if (document.archived !== undefined) expect(typeof document.archived).toBe('boolean');
    }
  });

  it('references existing labels with integer relevance grades and scoped positives', () => {
    const observedGrades = new Set<number>();
    for (const query of queries) {
      expect(query.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(['dev', 'heldout']).toContain(query.split);
      expect(['lexical', 'paraphrase', 'hard-negative', 'negative']).toContain(query.kind);
      expect(query.query.trim().split(/\s+/).length).toBeGreaterThanOrEqual(6);
      expect(query.relevance).toBeTypeOf('object');
      expect(query.relevance).not.toBeNull();
      expect(Array.isArray(query.relevance)).toBe(false);
      expect(Object.keys(query.relevance).sort()).toEqual([...documentById.keys()].sort());

      for (const [documentId, grade] of Object.entries(query.relevance)) {
        const document = documentById.get(documentId);
        expect(document, `${query.id} references ${documentId}`).toBeDefined();
        expect(Number.isInteger(grade)).toBe(true);
        expect(grade).toBeGreaterThanOrEqual(0);
        expect(grade).toBeLessThanOrEqual(3);
        observedGrades.add(grade);
        if (grade > 0) {
          expect(document?.workspace).toBe('primary');
          expect(document?.archived).not.toBe(true);
          expect(document?.tags).toContain(`family:${query.family}`);
        }
      }
    }
    expect([...observedGrades].sort()).toEqual([0, 1, 2, 3]);
  });

  it('holds entire scenario families out instead of splitting query paraphrases', () => {
    const families = new Map<string, Set<string>>();
    for (const query of queries) {
      const splits = families.get(query.family) ?? new Set<string>();
      splits.add(query.split);
      families.set(query.family, splits);
    }
    expect(families.size).toBe(16);
    for (const [family, splits] of families) {
      expect(splits.size, `${family} crosses dev and heldout`).toBe(1);
      expect(queries.filter((query) => query.family === family)).toHaveLength(5);
      const familyDocuments = activePrimary.filter((document) =>
        document.tags.includes(`family:${family}`)
      );
      expect(familyDocuments).toHaveLength(splits.has('dev') ? 8 : 7);
    }
    for (const split of ['dev', 'heldout']) {
      const splitQueries = queries.filter((query) => query.split === split);
      expect(splitQueries).toHaveLength(40);
      expect(new Set(splitQueries.map((query) => query.family)).size).toBe(8);
      expect(splitQueries.filter((query) => query.kind === 'lexical')).toHaveLength(8);
      expect(splitQueries.filter((query) => query.kind === 'paraphrase')).toHaveLength(16);
      expect(splitQueries.filter((query) => query.kind === 'hard-negative')).toHaveLength(8);
      expect(splitQueries.filter((query) => query.kind === 'negative')).toHaveLength(8);
    }
    const queryFamilies = new Set(queries.map((query) => `family:${query.family}`));
    for (const document of documents) {
      expect(queryFamilies.has(document.tags.find((tag) => tag.startsWith('family:')) ?? '')).toBe(true);
    }
  });

  it('keeps no-answer cases negative and explicit hard negatives unrewarded', () => {
    for (const query of queries) {
      const grades = Object.values(query.relevance);
      if (query.kind === 'negative') {
        expect(grades.every((grade) => grade === 0), query.id).toBe(true);
      } else {
        expect(grades.some((grade) => grade === 3), query.id).toBe(true);
        expect(grades.some((grade) => grade === 0), query.id).toBe(true);
      }
      if (query.kind === 'hard-negative') {
        expect(Object.entries(query.relevance).some(([id, grade]) =>
          grade === 0 && documentById.get(id)?.workspace === 'primary' && !documentById.get(id)?.archived
        ), query.id).toBe(true);
      }
    }

    for (const document of documents.filter((entry) => entry.workspace === 'foreign' || entry.archived)) {
      expect(queries.some((query) => query.relevance[document.id] === 0), document.id).toBe(true);
      expect(queries.every((query) => (query.relevance[document.id] ?? 0) === 0), document.id).toBe(true);
    }
  });
});
