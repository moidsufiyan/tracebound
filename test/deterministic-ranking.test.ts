import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_CATEGORIES,
  deterministicCategory,
  rankDeterministically,
  type DeterministicMatch,
  type StructuralSignalKind,
} from '../src/retrieval/deterministic-ranking.js';

function match(
  path: string,
  options: { content?: string[]; inPath?: string[]; structural?: StructuralSignalKind[] } = {},
): DeterministicMatch {
  return {
    path,
    contentTerms: new Set(options.content ?? []),
    pathTerms: new Set(options.inPath ?? []),
    structuralKinds: new Set(options.structural ?? []),
  };
}

describe('deterministicCategory', () => {
  const none = new Set<StructuralSignalKind>();

  it('puts incoming imports and tests above every lexical category', () => {
    for (const lexical of [null, 'path-and-multi-content', 'high-content-density', 'path-only', 'single-term'] as const) {
      expect(deterministicCategory(lexical, new Set(['incoming-import']))).toBe('critical-structural');
      expect(deterministicCategory(lexical, new Set(['test-to-source']))).toBe('critical-structural');
    }
  });

  it('puts the two strong lexical categories above outgoing imports', () => {
    const outgoing = new Set<StructuralSignalKind>(['outgoing-import']);
    expect(deterministicCategory('path-and-multi-content', outgoing)).toBe('path-and-multi-content');
    expect(deterministicCategory('high-content-density', outgoing)).toBe('high-content-density');
  });

  it('puts outgoing imports above the three weaker lexical categories', () => {
    const outgoing = new Set<StructuralSignalKind>(['outgoing-import']);
    for (const lexical of [null, 'path-only', 'multiple-terms', 'single-term'] as const) {
      expect(deterministicCategory(lexical, outgoing)).toBe('weak-structural');
    }
  });

  it('falls back to the lexical category without a structural signal', () => {
    expect(deterministicCategory('path-only', none)).toBe('path-only');
    expect(deterministicCategory('multiple-terms', none)).toBe('multiple-terms');
    expect(deterministicCategory('single-term', none)).toBe('single-term');
  });

  it('refuses a candidate with neither lexical nor structural evidence', () => {
    expect(() => deterministicCategory(null, none)).toThrow();
  });
});

describe('rankDeterministically', () => {
  it('orders all seven categories as B6 does', () => {
    const ranked = rankDeterministically([
      match('single.md', { content: ['t1'] }),
      match('multi.md', { content: ['t1', 't2'] }),
      match('path.md', { content: ['t1'], inPath: ['t2'] }),
      match('outgoing.ts', { structural: ['outgoing-import'] }),
      match('dense.md', { content: ['t1', 't2', 't3', 't4', 't5'] }),
      match('strong.md', { content: ['t1', 't2'], inPath: ['t3'] }),
      match('dependent.ts', { structural: ['incoming-import'] }),
    ]);

    expect(ranked.map((r) => [r.rank, r.path, r.category])).toEqual([
      [1, 'dependent.ts', 'critical-structural'],
      [2, 'strong.md', 'path-and-multi-content'],
      [3, 'dense.md', 'high-content-density'],
      [4, 'outgoing.ts', 'weak-structural'],
      [5, 'path.md', 'path-only'],
      [6, 'multi.md', 'multiple-terms'],
      [7, 'single.md', 'single-term'],
    ]);
    expect(ranked.map((r) => r.category)).toEqual([...DETERMINISTIC_CATEGORIES]);
  });

  it('keeps the lexical category of a structural candidate that also matched terms', () => {
    const [ranked] = rankDeterministically([match('a.ts', { content: ['t1'], structural: ['test-to-source'] })]);
    expect(ranked).toMatchObject({ category: 'critical-structural', lexicalCategory: 'single-term', matchedTerms: ['t1'] });
  });

  it('gives a purely structural candidate no lexical category', () => {
    const [ranked] = rankDeterministically([match('a.ts', { structural: ['outgoing-import'] })]);
    expect(ranked).toMatchObject({ category: 'weak-structural', lexicalCategory: null, matchedTerms: [] });
  });

  it('breaks ties inside a category with the lexical tie-breaks, then path order', () => {
    const ranked = rankDeterministically([
      match('src/zz.ts', { structural: ['incoming-import'] }),
      match('src/b.ts', { structural: ['incoming-import'] }),
      match('src/c.ts', { content: ['t1', 't2'], structural: ['incoming-import'] }),
      match('src/longer-name.ts', { structural: ['incoming-import'] }),
      match('src/a.ts', { structural: ['incoming-import'] }),
    ]);
    expect(ranked.map((r) => r.path)).toEqual(['src/c.ts', 'src/a.ts', 'src/b.ts', 'src/zz.ts', 'src/longer-name.ts']);
  });

  it('is independent of input order', () => {
    const matches = [
      match('b.ts', { structural: ['outgoing-import'] }),
      match('a.md', { content: ['t1'] }),
      match('c.ts', { structural: ['test-to-source'] }),
    ];
    expect(rankDeterministically(matches)).toEqual(rankDeterministically([...matches].reverse()));
  });
});
