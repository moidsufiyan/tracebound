// The lexical tokenizer, derived from the Phase 1 B2 baseline (experiments/lexical/index.js):
// lowercase, split camelCase and snake_case, treat punctuation as separators, drop stop words
// and tokens shorter than three characters from queries. The B2 baseline searched with
// `git grep -i`, i.e. substring matching; token matching replaces it, so this module also emits
// the joined form of every compound identifier (the B2 "whole symbol name" query term).

// Same list as B2, including its extension and generic-path terms. 'tsx' is intentionally not
// listed: B2 did not list it either.
const STOP_WORDS: ReadonlySet<string> = new Set([
  'and', 'or', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'from', 'by', 'as', 'is', 'are',
  'was', 'were', 'it', 'this', 'that', 'these', 'those',
  'ts', 'js', 'md', 'src', 'index', 'backend', 'frontend', 'docs', 'test', 'spec', 'file', 'across', 'full',
  'stack', 'some',
]);

const MIN_QUERY_TERM_LENGTH = 3;
const IDENTIFIER = /[\p{L}\p{N}_]+/gu;
const CAMEL_CASE_BOUNDARY = /(?<=\p{Ll})(?=\p{Lu})/u;

/** Lowercase words of one identifier, split at underscores and lower-to-upper case changes. */
function identifierParts(identifier: string): string[] {
  return identifier
    .split('_')
    .flatMap((segment) => segment.split(CAMEL_CASE_BOUNDARY))
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

/**
 * Tokens of one identifier: its parts, plus the parts joined together when there are several, so
 * `releaseLockLua` and `RELEASE_LOCK_LUA` both produce `releaselocklua`. Hyphens, dots and slashes
 * separate identifiers.
 */
function identifierTokens(identifier: string): string[] {
  const parts = identifierParts(identifier);
  return parts.length > 1 ? [...parts, parts.join('')] : parts;
}

/**
 * Distinct tokens of `text` in order of first appearance. Applies no stop-word or length filtering,
 * so it is what the index stores and what any exact lookup can match.
 */
export function tokenize(text: string): string[] {
  const tokens = new Set<string>();
  for (const [identifier] of text.matchAll(IDENTIFIER)) {
    for (const token of identifierTokens(identifier)) tokens.add(token);
  }
  return [...tokens];
}

function isSearchable(token: string): boolean {
  return token.length >= MIN_QUERY_TERM_LENGTH && !STOP_WORDS.has(token);
}

/**
 * The distinct terms a lexical search looks up. Free text drops stop words and short tokens.
 * Symbols are explicit identifiers rather than prose, so each keeps its joined lowercase name
 * even when that name is short or a stop word (B2 did the same: a function called `some` is
 * searchable), alongside its filtered parts.
 */
export function queryTerms(query: { text: string; symbols?: readonly string[] }): string[] {
  const terms = new Set(tokenize(query.text).filter(isSearchable));
  for (const symbol of query.symbols ?? []) {
    for (const [identifier] of symbol.matchAll(IDENTIFIER)) {
      const parts = identifierParts(identifier);
      if (parts.length === 0) continue;
      terms.add(parts.join(''));
      for (const part of parts) if (isSearchable(part)) terms.add(part);
    }
  }
  return [...terms];
}
