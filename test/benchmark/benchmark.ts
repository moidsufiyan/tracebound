import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { load } from 'js-yaml';
import type { LexicalQuery } from '../../src/retrieval/lexical-search.js';

// Loads the Phase 1 evaluation cases (docs/evaluation/cases) and the committed B2/B5/B6 research
// outputs so production retrieval can be compared with them.

const ROOT = join(import.meta.dirname, '..', '..');
const CASES_DIR = join(ROOT, 'docs', 'evaluation', 'cases');
const COMBINED_OUTPUTS = join(ROOT, 'experiments', 'combined', 'outputs');
const B6_SUMMARY = join(ROOT, 'experiments', 'ranking', 'outputs', 'summary.json');

/** Environment variables naming the local clones the cases were built from. */
const REPOSITORY_ENV: Record<string, string> = {
  'moidsufiyan/wollyway': 'TRACEBOUND_WOLLYWAY_REPO',
  'honojs/hono': 'TRACEBOUND_HONO_REPO',
};

interface CaseFile {
  case_id: string;
  repository: { name: string; base_commit: string };
  source_change: { description: string };
  changed_artifacts?: { path: string; symbols?: { name: string }[] }[];
  candidates?: { path: string; relevance: string }[];
}

export interface BenchmarkCase {
  id: string;
  repositoryName: string;
  baseCommit: string;
  query: LexicalQuery;
  changedPaths: Set<string>;
  /** Candidates a developer should investigate. */
  positives: string[];
  /** Candidates labelled not-relevant (negative cases). */
  negatives: string[];
}

export function repositoryPath(repositoryName: string): string | undefined {
  const variable = REPOSITORY_ENV[repositoryName];
  return variable ? process.env[variable] : undefined;
}

export function benchmarkAvailable(): boolean {
  return (
    Object.values(REPOSITORY_ENV).every((variable) => {
      const path = process.env[variable];
      return path !== undefined && existsSync(path);
    }) &&
    existsSync(COMBINED_OUTPUTS) &&
    existsSync(B6_SUMMARY)
  );
}

/** The B2 query: the change description, the changed files' base names and their symbol names. */
export function loadCases(): BenchmarkCase[] {
  return readdirSync(CASES_DIR)
    .filter((file) => /^case-\d+\.yaml$/.test(file))
    .sort()
    .map((file) => {
      const data = load(readFileSync(join(CASES_DIR, file), 'utf8')) as CaseFile;
      const changed = data.changed_artifacts ?? [];
      const names = changed.map((artifact) => basename(artifact.path));
      const candidates = data.candidates ?? [];
      return {
        id: data.case_id,
        repositoryName: data.repository.name,
        baseCommit: data.repository.base_commit,
        query: {
          text: [data.source_change.description, ...names].join(' '),
          symbols: changed.flatMap((artifact) => (artifact.symbols ?? []).map((symbol) => symbol.name)),
        },
        changedPaths: new Set(changed.map((artifact) => artifact.path)),
        positives: candidates.filter((c) => c.relevance !== 'not-relevant').map((c) => c.path),
        negatives: candidates.filter((c) => c.relevance === 'not-relevant').map((c) => c.path),
      };
    });
}

/** Resolves revisions such as `abc~1` to the full commit SHA that ingestion requires. */
export function resolveCommit(repoPath: string, revision: string): string {
  return execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', `${revision}^{commit}`], {
    encoding: 'utf8',
  }).trim();
}

export interface ResearchCandidate {
  path: string;
  contentTerms: Set<string>;
  pathTerms: Set<string>;
}

/** B2 candidates for a case (changed files excluded unless labelled), from the B5 combined output. */
export function loadResearchCandidates(caseId: string): ResearchCandidate[] {
  const output = JSON.parse(readFileSync(join(COMBINED_OUTPUTS, `${caseId}.json`), 'utf8')) as {
    relevant_found: { path: string; b2_evidence: string[] }[];
    false_positives: { path: string; b2_evidence: string[] }[];
  };
  return [...output.relevant_found, ...output.false_positives].map(({ path, b2_evidence }) => {
    const contentTerms = new Set<string>();
    const pathTerms = new Set<string>();
    for (const evidence of b2_evidence) {
      const term = /matched token: '([^']+)'/.exec(evidence)?.[1];
      if (term) (evidence.startsWith('Path') ? pathTerms : contentTerms).add(term);
    }
    return { path, contentTerms, pathTerms };
  });
}

/** The rank B6 recorded for the case's first labelled candidate, structural tiers included. */
export function loadResearchB6TruthRank(caseId: string): number {
  const summary = JSON.parse(readFileSync(B6_SUMMARY, 'utf8')) as Record<string, { metrics: { truth_rank: number } }>;
  return summary[caseId]!.metrics.truth_rank;
}

/**
 * B6 ranking restricted to its lexical categories, as written in experiments/ranking/index.js:
 * category, then distinct terms, then path terms, then shorter path, then localeCompare.
 */
export function researchLexicalRanking(candidates: ResearchCandidate[]): string[] {
  const level = (c: { all: number; path: number }) =>
    c.path > 0 && c.all >= 3 ? 2 : c.all >= 5 ? 3 : c.path > 0 ? 5 : c.all >= 2 ? 6 : 7;
  return candidates
    .map((c) => ({ path: c.path, all: new Set([...c.contentTerms, ...c.pathTerms]).size, pathCount: c.pathTerms.size }))
    .map((c) => ({ ...c, level: level({ all: c.all, path: c.pathCount }) }))
    .sort(
      (a, b) =>
        a.level - b.level ||
        b.all - a.all ||
        b.pathCount - a.pathCount ||
        a.path.length - b.path.length ||
        a.path.localeCompare(b.path),
    )
    .map((c) => c.path);
}
