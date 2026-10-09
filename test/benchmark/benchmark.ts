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
  candidates?: { path: string; relevance: string; relationship?: string }[];
}

export interface BenchmarkCase {
  id: string;
  repositoryName: string;
  baseCommit: string;
  /** The change description as written in the case, used verbatim by the semantic query. */
  description: string;
  query: LexicalQuery;
  changedPaths: Set<string>;
  /** Candidates a developer should investigate. */
  positives: string[];
  /** Candidates labelled not-relevant (negative cases). */
  negatives: string[];
  /** The labelled relationship of each positive, e.g. 'test-of' or 'documents'. */
  positiveRelationships: string[];
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
        description: data.source_change.description,
        query: {
          text: [data.source_change.description, ...names].join(' '),
          symbols: changed.flatMap((artifact) => (artifact.symbols ?? []).map((symbol) => symbol.name)),
        },
        changedPaths: new Set(changed.map((artifact) => artifact.path)),
        positives: candidates.filter((c) => c.relevance !== 'not-relevant').map((c) => c.path),
        negatives: candidates.filter((c) => c.relevance === 'not-relevant').map((c) => c.path),
        positiveRelationships: candidates.filter((c) => c.relevance !== 'not-relevant').map((c) => c.relationship ?? ''),
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

/** The number of candidates B6 ranked for the case (B2 and B1 candidates, changed files excluded). */
export function loadResearchB6CandidateCount(caseId: string): number {
  const summary = JSON.parse(readFileSync(B6_SUMMARY, 'utf8')) as Record<string, { metrics: { total_candidates: number } }>;
  return summary[caseId]!.metrics.total_candidates;
}

export type ResearchStructuralKind = 'test-to-source' | 'incoming-import' | 'outgoing-import';

/** B1 structural candidates for a case, with the kinds of signal B1 recorded for each path. */
export function loadResearchStructural(caseId: string): Map<string, Set<ResearchStructuralKind>> {
  const output = JSON.parse(readFileSync(join(ROOT, 'experiments', 'structural', 'outputs', `${caseId}.json`), 'utf8')) as {
    relevant_found: { path: string; evidence: string[] }[];
    false_positives: { path: string; evidence: string[] }[];
  };
  const kinds = new Map<string, Set<ResearchStructuralKind>>();
  for (const { path, evidence } of [...output.relevant_found, ...output.false_positives]) {
    const set = new Set<ResearchStructuralKind>();
    for (const line of evidence) {
      if (line.startsWith('[Test-to-Source Dependency]')) set.add('test-to-source');
      else if (line.startsWith('[Reverse Import]')) set.add('incoming-import');
      else if (line.startsWith('[Direct Import]')) set.add('outgoing-import');
    }
    kinds.set(path, set);
  }
  return kinds;
}

const SEMANTIC_OUTPUTS = join(ROOT, 'experiments', 'semantic', 'outputs');

/** The Ollama server for the semantic benchmark (for example http://127.0.0.1:11434). */
export function ollamaUrl(): string | undefined {
  return process.env['TRACEBOUND_OLLAMA_URL'];
}

export function semanticBenchmarkAvailable(): boolean {
  return benchmarkAvailable() && ollamaUrl() !== undefined && existsSync(SEMANTIC_OUTPUTS);
}

export interface ResearchSemanticCase {
  /** Rank and similarity B7.1 recorded for each labelled candidate, among all artifacts. */
  labelled: { path: string; rank: number; similarity: number | null }[];
  totalArtifacts: number;
  /** B7.1's ranking, best first. */
  ranking: { path: string; similarity: number }[];
}

export function loadResearchSemantic(caseId: string): ResearchSemanticCase {
  const report = JSON.parse(readFileSync(join(SEMANTIC_OUTPUTS, `${caseId}.json`), 'utf8')) as {
    metrics: { total_artifacts_embedded: number };
    relevant_artifacts_results: { path: string; rank: number; similarity: number | null }[];
    all_candidates: { path: string; similarity: number }[];
  };
  return {
    labelled: report.relevant_artifacts_results,
    totalArtifacts: report.metrics.total_artifacts_embedded,
    ranking: report.all_candidates,
  };
}

/** SHA-256 keys of every text the B7.1 run embedded (its Ollama response cache). */
export function loadResearchEmbeddingKeys(): Set<string> {
  return new Set(Object.keys(JSON.parse(readFileSync(join(SEMANTIC_OUTPUTS, 'ollama_embeddings_cache.json'), 'utf8'))));
}

/** The rank H2 gave a path in its fused top 20 (the only part B7's hybrid run recorded), or null beyond it. */
export function loadResearchHybridRank(caseId: string, path: string): { rank: number | null; deterministicRank: number | null; semanticRank: number | null } {
  const report = JSON.parse(readFileSync(join(ROOT, 'experiments', 'hybrid', 'outputs', `${caseId}.json`), 'utf8')) as {
    h2_top_20: {
      artifact: string;
      deterministic_evidence: { rank: number | null };
      semantic_evidence: { rank: number | null };
      hybrid_evidence: { fused_rank: number };
    }[];
  };
  const entry = report.h2_top_20.find((candidate) => candidate.artifact === path);
  return {
    rank: entry?.hybrid_evidence.fused_rank ?? null,
    deterministicRank: entry?.deterministic_evidence.rank ?? null,
    semanticRank: entry?.semantic_evidence.rank ?? null,
  };
}
