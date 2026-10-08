import { categorize, compareLexicalStrength, type LexicalCategory } from './lexical-ranking.js';

// The full Phase 1 B6 category precedence (experiments/ranking/index.js), now that both its
// lexical and structural inputs exist.

export const STRUCTURAL_SIGNAL_KINDS = ['test-to-source', 'incoming-import', 'outgoing-import'] as const;

/**
 * How a candidate relates to a changed artifact:
 * - `test-to-source`: the candidate is a test file that imports the changed artifact
 * - `incoming-import`: the candidate imports the changed artifact (a reverse dependency)
 * - `outgoing-import`: the changed artifact imports the candidate
 */
export type StructuralSignalKind = (typeof STRUCTURAL_SIGNAL_KINDS)[number];

/**
 * Ordered best to worst; the comments give the B6 category each one reproduces. Structural
 * categories rank above weaker lexical ones exactly where B6 placed them.
 */
export const DETERMINISTIC_CATEGORIES = [
  'critical-structural', //     B6 1: imports a changed artifact, or is a test that does
  'path-and-multi-content', //  B6 2
  'high-content-density', //    B6 3
  'weak-structural', //         B6 4: imported by a changed artifact
  'path-only', //               B6 5
  'multiple-terms', //          B6 6
  'single-term', //             B6 7
] as const;

export type DeterministicCategory = (typeof DETERMINISTIC_CATEGORIES)[number];

export interface DeterministicMatch {
  path: string;
  /** Distinct query terms found in the artifact's normalized content. */
  contentTerms: ReadonlySet<string>;
  /** Distinct query terms found in the artifact's Git path. */
  pathTerms: ReadonlySet<string>;
  structuralKinds: ReadonlySet<StructuralSignalKind>;
}

export interface DeterministicRanking {
  rank: number;
  category: DeterministicCategory;
  /** The lexical category the matched terms alone would give; null when no term matched. */
  lexicalCategory: LexicalCategory | null;
  /** Distinct query terms matched in the path or the content, sorted. */
  matchedTerms: string[];
}

/**
 * B6 evaluates in this order: incoming dependents and tests; the two strong lexical categories;
 * outgoing imports; the three weaker lexical categories.
 */
export function deterministicCategory(
  lexicalCategory: LexicalCategory | null,
  structuralKinds: ReadonlySet<StructuralSignalKind>,
): DeterministicCategory {
  if (structuralKinds.has('test-to-source') || structuralKinds.has('incoming-import')) return 'critical-structural';
  if (lexicalCategory === 'path-and-multi-content' || lexicalCategory === 'high-content-density') {
    return lexicalCategory;
  }
  if (structuralKinds.has('outgoing-import')) return 'weak-structural';
  if (lexicalCategory === null) throw new Error('A candidate needs a lexical match or a structural signal');
  return lexicalCategory;
}

/**
 * Orders candidates by category, then by the M3 lexical tie-breaks (distinct terms, path terms,
 * shorter path, code unit order); a purely structural candidate has no terms, so it falls to the
 * path tie-breaks. Ranks are 1-based and the order is total.
 */
export function rankDeterministically<T extends DeterministicMatch>(
  matches: readonly T[],
): (T & DeterministicRanking)[] {
  const scored = matches.map((match) => {
    const matchedTerms = [...new Set([...match.contentTerms, ...match.pathTerms])].sort();
    const lexicalCategory = matchedTerms.length > 0 ? categorize(matchedTerms.length, match.pathTerms.size) : null;
    return {
      ...match,
      matchedTerms,
      lexicalCategory,
      category: deterministicCategory(lexicalCategory, match.structuralKinds),
    };
  });

  scored.sort(
    (a, b) =>
      DETERMINISTIC_CATEGORIES.indexOf(a.category) - DETERMINISTIC_CATEGORIES.indexOf(b.category) ||
      compareLexicalStrength(
        { termCount: a.matchedTerms.length, pathTermCount: a.pathTerms.size, path: a.path },
        { termCount: b.matchedTerms.length, pathTermCount: b.pathTerms.size, path: b.path },
      ),
  );
  return scored.map((match, index) => ({ ...match, rank: index + 1 }));
}
