import { posix } from 'node:path';
import type { Evidence, StructuralEvidence } from '../retrieval/evidence.js';
import { queryTerms, tokenize } from '../retrieval/tokenizer.js';
import type { ImpactClassification } from './impact-report.js';
import type { ReasoningCandidate, ReasoningInput } from './provider.js';

// Grounding guards: narrow, deterministic checks of what a finding claims against the evidence
// objects it cites. Each guard rejects one kind of objective mismatch observed in M8 runs, and only
// when the statement makes that claim explicitly; anything it cannot read with confidence is left
// alone. They do not establish that a finding is true or that a classification is right: whether
// the evidence supports the behavioral relationship a finding asserts still needs human review.
//
// A guard returns a message describing the mismatch, or null. The caller turns it into an
// InvalidReasoningOutputError, so a rejected finding fails its request as any invalid answer does.

/**
 * Evidence types able to show affirmatively that a change does not affect a file. None of the
 * current types can: structural evidence records a relationship, lexical evidence records matched
 * terms, and semantic and fusion evidence are retrieval scores. An absent signal is not evidence of
 * non-impact. A future evidence type that can show it (for example, verified non-use of every changed
 * symbol) would be listed here.
 */
const NON_IMPACT_EVIDENCE_TYPES: ReadonlySet<Evidence['type']> = new Set();

/**
 * Classification guard, applied after the findings are accepted.
 *
 * - `likely_affected` needs at least one cited structural relationship where the candidate is the
 *   source (it imports a changed file) and whose import declaration was located in the source.
 *   Invariant: a likely-affected assessment rests on an incoming code-level dependency from the
 *   candidate to a changed file, not on scores, ranks, similarity, keyword matches or outgoing
 *   imports (where the changed file imports the candidate). This is necessary, not sufficient: a
 *   located import does not show that the changed behavior is used. Limitation: a candidate related
 *   only textually (a document describing the changed behavior) can be at most `potentially_affected`.
 * - `no_impact_indicated` needs cited evidence of a type in NON_IMPACT_EVIDENCE_TYPES. With the
 *   current evidence types that set is empty, so the classification is always rejected and the model
 *   is told to abstain instead. This is the conservative policy: non-impact is never inferred from
 *   missing signals, keyword matches or low scores.
 */
export function classificationGroundingProblem(classification: ImpactClassification, cited: readonly Evidence[], label: string): string | null {
  if (classification === 'likely_affected') {
    const located = cited.some((e) => e.type === 'structural' && e.candidateIs === 'source' && e.declarations !== null && e.declarations.length > 0);
    if (!located) return `${label} is likely_affected but cites no located structural relationship (an import declaration of a changed file); scores, ranks, similarity and keyword matches cannot carry it`;
  }
  if (classification === 'no_impact_indicated' && !cited.some((e) => NON_IMPACT_EVIDENCE_TYPES.has(e.type))) {
    return `${label} is no_impact_indicated, but none of its cited evidence can show that the change does not affect the candidate; the available evidence types record relationships, matched terms and retrieval scores, and the absence of a signal is not non-impact`;
  }
  return null;
}

/** What the finding guards need besides the statement and its cited evidence. */
export interface GroundingContext {
  candidate: ReasoningCandidate;
  change: ReasoningInput['change'];
}

/** The finding guards, in a fixed order; the first problem is reported. */
export function findingGroundingProblem(statement: string, cited: readonly Evidence[], context: GroundingContext, where: string): string | null {
  return (
    importDirectionProblem(statement, cited, context, where) ??
    symbolUseProblem(statement, cited, where) ??
    testCountProblem(statement, cited, where) ??
    lexicalPresenceProblem(statement, cited, context, where)
  );
}

// ---- import direction ---------------------------------------------------------------------------

/**
 * Invariant: a finding that explicitly says the candidate imports the changed file must not cite only
 * structural evidence recording the opposite edge (the changed file importing the candidate), and the
 * reverse. Direction comes from `candidateIs` on the evidence, never from the signal name alone.
 *
 * Only two explicit forms are read: "<X> imports <changed file>" (the changed file named by its path,
 * its base name with or without extension or `.js`, or as "the changed file", or "imports <Y>, which
 * is changed") and "<changed file> imports ..." / "... is imported by <changed file>". A statement
 * whose subject is the changed file is never read as a candidate-imports claim. Each clause is read
 * on its own; a negated clause is checked only in the plain form "<candidate> does not import (or use)
 * <changed file>", which is rejected when every cited edge records the candidate importing it.
 * Statements that name neither form, or cite no structural evidence, are not checked. Limitation:
 * other phrasings of a reversed direction ("depends on", "uses the module") pass.
 */
function importDirectionProblem(statement: string, cited: readonly Evidence[], context: GroundingContext, where: string): string | null {
  const edges = cited.filter((e): e is StructuralEvidence => e.type === 'structural');
  if (edges.length === 0) return null;
  const refs = changedFileReference(context.change.changedPaths);
  const changedSubject = new RegExp(`(?:^|[\\s(])(?:the\\s+)?${refs}['"\`]?\\s+(?:does\\s+not\\s+|doesn't\\s+)?imports?\\b`, 'i');
  const importedByChanged = new RegExp(`\\b(?:is|are)\\s+(?:not\\s+)?imported\\s+by\\s+(?:the\\s+)?['"\`]?${refs}`, 'i');
  const importsChanged = new RegExp(`\\bimports?\\s+(?:or\\s+uses?\\s+)?(?:from\\s+)?(?:the\\s+)?['"\`]?${refs}`, 'i');
  const importsSomethingChanged = /\bimports?\s+(?:from\s+)?\S+?,?\s+which\s+(?:is|was)\s+(?:the\s+)?changed\b/i;
  const candidateImports = edges.every((e) => e.candidateIs === 'source');
  const changedImports = edges.every((e) => e.candidateIs === 'target');

  // Clause by clause, so "X does not import Y" is never read as "X imports Y".
  for (const clause of clauses(statement)) {
    const negated = NEGATION.test(clause);
    const saysChangedImportsCandidate = changedSubject.test(clause) || importedByChanged.test(clause);
    const saysCandidateImportsChanged = !saysChangedImportsCandidate && !/\bimported\s+by\b/i.test(clause) && (importsChanged.test(clause) || importsSomethingChanged.test(clause));
    if (!negated) {
      if (saysCandidateImportsChanged && changedImports) {
        return `${where} says the candidate imports the changed file, but the cited structural evidence records the changed file importing the candidate`;
      }
      if (saysChangedImportsCandidate && candidateImports) {
        return `${where} says the changed file imports the candidate, but the cited structural evidence records the candidate importing the changed file`;
      }
    } else if (saysCandidateImportsChanged && !saysChangedImportsCandidate && candidateImports && importsChanged.test(clause)) {
      // Negated: only the plain "<candidate> does not import (or use) <changed file>" form is read.
      return `${where} says the candidate does not import the changed file, but the cited structural evidence records that it does`;
    }
  }
  return null;
}

const GENERIC_STEMS: ReadonlySet<string> = new Set(['index', 'main', 'mod', 'types', 'utils', 'constants', 'config', 'helpers']);

/** A regex alternation naming a changed file: "changed file(s)/module(s)", or a changed path, base name, stem or `.js` form. */
function changedFileReference(changedPaths: readonly string[]): string {
  const names = new Set<string>();
  for (const path of changedPaths) {
    names.add(path);
    const base = posix.basename(path);
    const stem = base.replace(/\.[^.]+$/, '');
    // A generic base name ("index.ts", "types.ts") names many files, so only the full path refers to it.
    if (GENERIC_STEMS.has(stem.toLowerCase())) continue;
    for (const name of [base, stem, `${stem}.js`]) if (name.length >= 3) names.add(name);
  }
  const escaped = [...names].sort((a, b) => b.length - a.length).map(escapeRegExp);
  // Not followed by a word character or by ".x", so "ipaddr" does not match "ipaddr.test.ts" but a
  // sentence-final "ipaddr.ts." still matches.
  return `(?:changed\\s+(?:files?|modules?)${escaped.length ? `|${escaped.join('|')}` : ''})(?!\\w|\\.\\w)`;
}

// ---- symbol use and execution ------------------------------------------------------------------

const USE_CLAIM =
  /\b(?:uses|use|using|used|calls|call|calling|called|invokes|invoke|invoking|executes|execute|executing|exercises|exercise|exercising|tests|test|testing)\s+(?:the\s+)?(?:(?:function|method|class|symbol|helper|api|constant)\s+)?['"`]([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)['"`]/gi;
const NEGATION = /\b(?:not|no|never|none|without|neither|nor)\b|n't\b/i;

/**
 * Invariant: a finding that explicitly says the candidate uses, calls, executes or tests a quoted
 * symbol must cite source text (a semantic chunk or a located import declaration) in which that
 * symbol appears outside import declarations. An import, a keyword match or a score does not show
 * use or execution. Only a quoted identifier directly after the verb is read, and negated clauses
 * are skipped. Limitation: source text is an excerpt (chunks are cut at 1,000 characters), so a use
 * outside the excerpt is rejected as not shown; unquoted or paraphrased use claims are not checked.
 */
function symbolUseProblem(statement: string, cited: readonly Evidence[], where: string): string | null {
  for (const clause of clauses(statement)) {
    if (NEGATION.test(clause)) continue;
    for (const match of clause.matchAll(USE_CLAIM)) {
      const symbol = match[1]!;
      const texts = citedSourceTexts(cited);
      const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
      const inBody = texts.some((text) => pattern.test(withoutImports(text)));
      if (inBody) continue;
      const inImports = texts.some((text) => pattern.test(text));
      return inImports
        ? `${where} says the candidate uses "${symbol}", but the cited source text shows it only in an import declaration`
        : `${where} says the candidate uses "${symbol}", but no cited source text shows it`;
    }
  }
  return null;
}

/** Source text carried by cited evidence: semantic chunks and located import declarations. */
function citedSourceTexts(cited: readonly Evidence[]): string[] {
  const texts: string[] = [];
  for (const e of cited) {
    if (e.type === 'semantic' && e.chunk) texts.push(e.chunk.text);
    if (e.type === 'structural' && e.declarations) for (const d of e.declarations) texts.push(d.excerpt.text);
  }
  return texts;
}

/**
 * The text with ES import and re-export declarations removed. Each pattern follows the shape of one
 * declaration (a default name, a namespace or a brace list, then `from` and a string), so a match
 * cannot run on into later statements: the brace list stops at the first `}`, and a bare word after
 * `import` that is not followed by `from` (as in a comment) matches nothing. Limitation: forms
 * outside these shapes (`import x = require(...)`, import attributes) are not stripped.
 */
function withoutImports(text: string): string {
  return text
    .replace(/\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\*\s*as\s+[\w$]+|\{[^}]*\}|[\w$]+)\s*from\s*['"][^'"\n]*['"]\s*;?/g, ' ')
    .replace(/\bimport\s*['"][^'"\n]*['"]\s*;?/g, ' ')
    .replace(/\bexport\s+(?:type\s+)?(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"][^'"\n]*['"]\s*;?/g, ' ');
}

// ---- number of tests ----------------------------------------------------------------------------

const TEST_COUNT = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|multiple|several|many|numerous|various)\s+(?:[A-Za-z-]+\s+){0,2}?(?:tests|test\s+cases|test\s+suites|specs)\b/i;

/**
 * Invariant: a statement about how many tests (or test cases) a candidate has must cite source text
 * (a semantic chunk). A lexical match count is the number of distinct query terms found; it says
 * nothing about tests, and neither do ranks or import edges. With a chunk cited, the count is a
 * reading of that text and is left to review. Limitation: test counts phrased differently pass.
 */
function testCountProblem(statement: string, cited: readonly Evidence[], where: string): string | null {
  if (!TEST_COUNT.test(statement)) return null;
  if (cited.some((e) => e.type === 'semantic' && e.chunk !== null)) return null;
  return `${where} states how many tests there are, but its cited evidence has no source text to show them (a lexical match count is not a number of tests)`;
}

// ---- lexical presence and absence --------------------------------------------------------------

const PRESENCE = /\b(?:contains?|containing|mentions?|mentioning|references?|referencing|includes?|including|matche[sd]|matching|occurrences?|lexical\s+evidence|has\s+the\s+terms?)\b/i;
/**
 * Clauses about the change itself (its description, the changed file, the commit) are not about the candidate.
 * Limitation: mentioning change-related terms before a presence verb can bypass lexical-fabrication and contradiction checks.
 */
const ABOUT_THE_CHANGE = /\b(?:change|changes|changed|description|commit|diff|query)\b/i;

/**
 * Two invariants about quoted query terms (a quoted single identifier whose lowercase form is one of
 * the lexical query terms of this change, as the production tokenizer derives them):
 *
 * - Presence: a non-negated clause saying the candidate contains, mentions, references, includes or
 *   matches the term must cite evidence that records it: a cited lexical match, or the term in cited
 *   source text, or in the candidate's own path.
 * - Absence: a negated clause of the same kind must not cite lexical evidence that matched the term
 *   in the content. A term that is also a token of the candidate's path is skipped, because the
 *   evidence does not say whether it matched in the path or the content.
 *
 * Only quoted terms after the first presence verb of a clause are read, so ordinary words are never
 * treated as claims, and a clause whose subject is the change itself ("the change description does
 * not mention ...") is skipped. Limitations: unquoted terms, terms the query did not include (lexical
 * evidence is silent about them), and phrasings outside the verbs above ("does not use 'x'") pass; a
 * clause that mixes presence and absence after its verb is read with the clause's negation;
 * mentioning change-related terms before a presence verb can bypass lexical-fabrication and
 * contradiction checks.
 */
function lexicalPresenceProblem(statement: string, cited: readonly Evidence[], context: GroundingContext, where: string): string | null {
  const queried = new Set(queryTerms({ text: lexicalQueryText(context.change) }));
  const pathTokens = new Set(tokenize(context.candidate.path));
  const lexicalTerms = new Set(cited.flatMap((e) => (e.type === 'lexical' ? e.matchedTerms : [])));
  const textTokens = new Set(citedSourceTexts(cited).flatMap((text) => tokenize(text)));
  const citesLexical = cited.some((e) => e.type === 'lexical');

  for (const clause of clauses(statement)) {
    const verb = PRESENCE.exec(clause);
    if (!verb) continue;
    // The subject (text before the verb) decides whether the clause is about the candidate, and only
    // terms after the verb are its object: in "does not use the 'utils' module, nor contain 'ipv4'",
    // 'utils' is not a containment claim.
    const subject = clause.slice(0, verb.index);
    if (ABOUT_THE_CHANGE.test(subject)) continue;
    const negated = NEGATION.test(clause);
    for (const term of quotedTerms(clause.slice(verb.index))) {
      if (!queried.has(term)) continue;
      if (negated) {
        if (citesLexical && lexicalTerms.has(term) && !pathTokens.has(term)) {
          return `${where} says the candidate does not contain "${term}", but the cited lexical evidence matched it in the content`;
        }
      } else if (!lexicalTerms.has(term) && !textTokens.has(term) && !pathTokens.has(term)) {
        return `${where} says the candidate contains "${term}", but no cited evidence records it`;
      }
    }
  }
  return null;
}

/** The lexical query text, built as hybrid retrieval builds it: the description and the changed files' base names. */
function lexicalQueryText(change: ReasoningInput['change']): string {
  return [change.description, ...change.changedPaths.map((path) => posix.basename(path))].join(' ');
}

/** Quoted single identifiers in a clause, lowercased the way the tokenizer joins them. */
function quotedTerms(clause: string): string[] {
  const terms: string[] = [];
  for (const match of clause.matchAll(/['"`]([^'"`\s]{1,80})['"`]/g)) {
    const raw = match[1]!;
    if (!/^[\p{L}\p{N}_]+$/u.test(raw)) continue; // a single identifier only: no paths, no hyphenated or dotted names
    terms.push(raw.toLowerCase());
  }
  return terms;
}

// ---- shared ------------------------------------------------------------------------------------

/** Sentences of a statement, and the halves of "X, but Y". */
function clauses(statement: string): string[] {
  return statement.split(/(?<=[.;!?])\s+|,\s*(?:but|while|whereas)\s+/i).filter((part) => part.trim().length > 0);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
