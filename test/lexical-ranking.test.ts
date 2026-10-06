import { describe, expect, it } from 'vitest';
import { categorize, rankMatches, type LexicalMatch } from '../src/retrieval/lexical-ranking.js';

function match(path: string, contentTerms: string[], pathTerms: string[] = []): LexicalMatch {
  return { artifactId: 0, versionId: 0, path, contentTerms: new Set(contentTerms), pathTerms: new Set(pathTerms) };
}

describe('categorize', () => {
  it.each([
    [3, 1, 'path-and-multi-content'],
    [9, 2, 'path-and-multi-content'],
    [5, 0, 'high-content-density'],
    [8, 0, 'high-content-density'],
    [1, 1, 'path-only'],
    [2, 1, 'path-only'],
    [2, 0, 'multiple-terms'],
    [4, 0, 'multiple-terms'],
    [1, 0, 'single-term'],
  ] as const)('%i distinct terms with %i in the path is %s', (distinct, inPath, expected) => {
    expect(categorize(distinct, inPath)).toBe(expected);
  });
});

describe('rankMatches', () => {
  it('orders by category before anything else', () => {
    const ranked = rankMatches([
      match('a.md', ['t1']),
      match('b.md', ['t1', 't2']),
      match('c.md', ['t1', 't2', 't3', 't4', 't5']),
      match('d.md', ['t1'], ['t2']),
      match('e.md', ['t1', 't2'], ['t3']),
    ]);

    expect(ranked.map((r) => [r.rank, r.path, r.category])).toEqual([
      [1, 'e.md', 'path-and-multi-content'],
      [2, 'c.md', 'high-content-density'],
      [3, 'd.md', 'path-only'],
      [4, 'b.md', 'multiple-terms'],
      [5, 'a.md', 'single-term'],
    ]);
  });

  it('counts a term matched in both path and content once', () => {
    const [ranked] = rankMatches([match('x.md', ['t1', 't2'], ['t1'])]);
    expect(ranked!.matchedTerms).toEqual(['t1', 't2']);
    expect(ranked!.category).toBe('path-only');
  });

  it('breaks ties by distinct terms, then path terms, then shorter path, then code unit order', () => {
    const ranked = rankMatches([
      match('zz.md', ['t1', 't2']),
      match('b.md', ['t1', 't2']),
      match('B.md', ['t1', 't2']),
      match('longer-path.md', ['t1', 't2']),
      match('m.md', ['t1', 't2', 't3']),
      match('p/n.md', ['t1'], ['t2']),
      match('q/n.md', ['t1', 't3'], ['t2']),
    ]);

    expect(ranked.map((r) => r.path)).toEqual([
      'q/n.md', // path-only tier, 3 distinct terms beats 2
      'p/n.md',
      'm.md', // multiple-terms tier, 3 distinct terms beats 2
      'B.md', // 2 distinct terms, equal length: 'B' (0x42) sorts before 'b' (0x62), unlike localeCompare
      'b.md',
      'zz.md',
      'longer-path.md',
    ]);
  });

  it('prefers more path terms when category and distinct terms tie', () => {
    const ranked = rankMatches([match('a/b.md', ['t1', 't2'], ['t3']), match('c/d.md', ['t1'], ['t2', 't3'])]);
    expect(ranked.map((r) => r.path)).toEqual(['c/d.md', 'a/b.md']);
  });

  it('is independent of input order', () => {
    const matches = [match('c.md', ['t1']), match('a.md', ['t1']), match('b.md', ['t1', 't2'])];
    expect(rankMatches(matches)).toEqual(rankMatches([...matches].reverse()));
  });
});
