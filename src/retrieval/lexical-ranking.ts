// The lexical part of the Phase 1 B6 deterministic ranking (experiments/ranking/index.js).
// B6 also had two structural categories (incoming dependents/tests, outgoing imports); they need
// the structural analysis that does not exist yet and are not represented here.

/**
 * Ordered best to worst. The comments give the B6 category each one reproduces.
 */
export const LEXICAL_CATEGORIES = [
  'path-and-multi-content', // B6 2: path matched and at least 3 distinct terms matched
  'high-content-density', //   B6 3: at least 5 distinct terms matched
  'path-only', //              B6 5: a path term matched (fewer than the thresholds above)
  'multiple-terms', //         B6 6: at least 2 distinct terms matched, none in the path
  'single-term', //            B6 7: exactly one term matched, in the content
] as const;

export type LexicalCategory = (typeof LEXICAL_CATEGORIES)[number];

export interface LexicalMatch {
  artifactId: number;
  versionId: number;
  path: string;
  /** Distinct query terms found in the artifact's normalized content. */
  contentTerms: ReadonlySet<string>;
  /** Distinct query terms found in the artifact's Git path. */
  pathTerms: ReadonlySet<string>;
}

export interface Ranking {
  rank: number;
  category: LexicalCategory;
  /** Distinct query terms matched in the path or the content, sorted. */
  matchedTerms: string[];
}

/** Category of a match, from the number of distinct terms matched overall and in the path. */
export function categorize(distinctTermCount: number, pathTermCount: number): LexicalCategory {
  if (pathTermCount > 0 && distinctTermCount >= 3) return 'path-and-multi-content';
  if (distinctTermCount >= 5) return 'high-content-density';
  if (pathTermCount > 0) return 'path-only';
  if (distinctTermCount >= 2) return 'multiple-terms';
  return 'single-term';
}

/**
 * Orders matches by category, then by distinct terms matched, then by path terms matched, then by
 * shorter path, then by path in UTF-16 code unit order (locale independent). Git paths are unique
 * within a snapshot, so the order is total. Ranks are 1-based.
 */
export function rankMatches<T extends LexicalMatch>(matches: readonly T[]): (T & Ranking)[] {
  const scored = matches.map((match) => {
    const matchedTerms = [...new Set([...match.contentTerms, ...match.pathTerms])].sort();
    return { ...match, matchedTerms, category: categorize(matchedTerms.length, match.pathTerms.size) };
  });

  scored.sort(
    (a, b) =>
      LEXICAL_CATEGORIES.indexOf(a.category) - LEXICAL_CATEGORIES.indexOf(b.category) ||
      b.matchedTerms.length - a.matchedTerms.length ||
      b.pathTerms.size - a.pathTerms.size ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return scored.map((match, index) => ({ ...match, rank: index + 1 }));
}
