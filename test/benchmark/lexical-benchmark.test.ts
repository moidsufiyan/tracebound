import { beforeAll, describe, expect, it } from 'vitest';
import { listSnapshotArtifacts } from '../../src/artifacts/artifacts.js';
import { openDatabase, type Database } from '../../src/db/database.js';
import { ingestSnapshot } from '../../src/ingestion/ingest-snapshot.js';
import { createProject, registerRepository, type Repository } from '../../src/projects/projects.js';
import { indexSnapshotLexically } from '../../src/retrieval/lexical-index.js';
import { searchLexical, type LexicalCandidate } from '../../src/retrieval/lexical-search.js';
import { compareSnapshots } from '../../src/snapshots/compare-snapshots.js';
import {
  benchmarkAvailable,
  loadCases,
  loadResearchB6TruthRank,
  loadResearchCandidates,
  repositoryPath,
  researchLexicalRanking,
  resolveCommit,
  type BenchmarkCase,
} from './benchmark.js';

// Runs production lexical retrieval over the 9-case Phase 1 benchmark, searching each case's base
// commit. It needs the two source repositories the cases were built from, named by
// TRACEBOUND_WOLLYWAY_REPO and TRACEBOUND_HONO_REPO, and is skipped without them.
//
// The pinned ranks below are measured results of this implementation, not targets: the ground truth
// is never adjusted. If the tokenizer or ranking changes on purpose, re-measure and update them.

const K_VALUES = [1, 3, 5, 10, 20] as const;

/** Rank of the case's labelled candidate among production candidates, and the production candidate count. */
const EXPECTED: Record<string, { rank: number | null; candidates: number }> = {
  'TB-0001': { rank: 2, candidates: 183 },
  'TB-0002': { rank: 1, candidates: 209 },
  'TB-0003': { rank: 1, candidates: 343 },
  'TB-0004': { rank: 1, candidates: 298 },
  'TB-0005': { rank: 60, candidates: 154 },
  'TB-0006': { rank: 16, candidates: 195 },
  'TB-0007': { rank: 11, candidates: 264 },
  'TB-0008': { rank: null, candidates: 364 }, // docs-only change, no labelled candidate
  'TB-0009': { rank: 5, candidates: 284 }, // negative case: the labelled candidate is NOT relevant
};

interface CaseRun {
  testCase: BenchmarkCase;
  baseSnapshotId: number;
  /** A much later snapshot of the same repository: the tip of the clone, pinned to its commit id. */
  laterSnapshotId: number;
  /** Production candidates with the case's changed files removed unless labelled, as B2 evaluated. */
  candidates: LexicalCandidate[];
  rankOf: (path: string) => number;
}

const runs = new Map<string, CaseRun>();
let db: Database;

describe.skipIf(!benchmarkAvailable())('lexical retrieval on the Phase 1 benchmark', () => {
  beforeAll(async () => {
    db = openDatabase(':memory:');
    const project = createProject(db, 'benchmark');
    const repositories = new Map<string, Repository>();

    for (const testCase of loadCases()) {
      const sourcePath = repositoryPath(testCase.repositoryName)!;
      let repository = repositories.get(testCase.repositoryName);
      if (!repository) {
        repository = await registerRepository(db, { projectId: project.id, name: testCase.repositoryName, sourcePath });
        repositories.set(testCase.repositoryName, repository);
      }
      const snapshotOf = async (revision: string) => {
        const { snapshot } = await ingestSnapshot(db, repository.id, resolveCommit(sourcePath, revision));
        indexSnapshotLexically(db, snapshot.id);
        return snapshot.id;
      };
      const baseSnapshotId = await snapshotOf(testCase.baseCommit);
      const laterSnapshotId = await snapshotOf('HEAD');

      const labelled = new Set([...testCase.positives, ...testCase.negatives]);
      const candidates = searchLexical(db, baseSnapshotId, testCase.query)
        .filter((c) => !testCase.changedPaths.has(c.path) || labelled.has(c.path))
        .map((c, index) => ({ ...c, rank: index + 1 }));
      const ranks = new Map(candidates.map((c) => [c.path, c.rank]));
      runs.set(testCase.id, {
        testCase,
        baseSnapshotId,
        laterSnapshotId,
        candidates,
        rankOf: (path) => ranks.get(path) ?? -1,
      });
    }
  }, 600_000);

  it('retrieves every labelled positive, and reports recall at K', () => {
    const positives = [...runs.values()].flatMap((run) => run.testCase.positives.map((path) => ({ run, path })));
    const hits = (k: number) => positives.filter(({ run, path }) => run.rankOf(path) >= 1 && run.rankOf(path) <= k).length;
    const recall = Object.fromEntries(K_VALUES.map((k) => [`top${k}`, `${hits(k)}/${positives.length}`]));
    console.log('production lexical recall:', JSON.stringify(recall));

    expect(positives).toHaveLength(7);
    expect(positives.every(({ run, path }) => run.rankOf(path) >= 1)).toBe(true);
    expect(K_VALUES.map(hits)).toEqual([3, 4, 4, 4, 6]);
  });

  it('matches the pinned per-case ranks and candidate volumes', () => {
    for (const [caseId, expected] of Object.entries(EXPECTED)) {
      const run = runs.get(caseId)!;
      const label = run.testCase.positives[0] ?? run.testCase.negatives[0];
      expect({ rank: label ? run.rankOf(label) : null, candidates: run.candidates.length }, caseId).toEqual(expected);
    }
  });

  it('does not rank the TB-0009 negative first, but a lexical-only ranker cannot rule it out', () => {
    const run = runs.get('TB-0009')!;
    const negative = run.candidates.find((c) => c.path === run.testCase.negatives[0])!;
    // Documented limitation: the dependent shares the change's vocabulary, so it is retrieved
    // in the best category. Telling it apart needs structural or semantic signals.
    expect(negative.category).toBe('path-and-multi-content');
    expect(negative.rank).toBeGreaterThan(1);
  });

  it('is deterministic: repeating a search returns the identical ordered list', () => {
    for (const run of runs.values()) {
      expect(searchLexical(db, run.baseSnapshotId, run.testCase.query)).toEqual(
        searchLexical(db, run.baseSnapshotId, run.testCase.query),
      );
    }
  });

  it('only returns artifacts that exist in the searched snapshot', () => {
    for (const run of runs.values()) {
      const inSnapshot = new Set(listSnapshotArtifacts(db, run.baseSnapshotId).map((a) => a.path));
      expect(run.candidates.every((c) => inSnapshot.has(c.path))).toBe(true);
    }
  });

  it('cannot see artifacts that exist only in a later snapshot', () => {
    let visibleLater = 0;
    for (const run of runs.values()) {
      const added = new Set(
        compareSnapshots(db, run.baseSnapshotId, run.laterSnapshotId)
          .filter((c) => c.change === 'added')
          .map((c) => c.path),
      );
      const atBase = searchLexical(db, run.baseSnapshotId, run.testCase.query).map((c) => c.path);
      const atLater = searchLexical(db, run.laterSnapshotId, run.testCase.query).map((c) => c.path);

      expect(atBase.filter((path) => added.has(path)), run.testCase.id).toEqual([]);
      visibleLater += atLater.filter((path) => added.has(path)).length;
    }
    // Not vacuous: later-only files do match the queries once their own snapshot is searched.
    expect(visibleLater).toBeGreaterThan(0);
  });

  it('retrieves only artifacts the B2 research baseline also retrieved', () => {
    for (const run of runs.values()) {
      const research = new Set(loadResearchCandidates(run.testCase.id).map((c) => c.path));
      const unexpected = run.candidates.map((c) => c.path).filter((path) => !research.has(path));
      expect(unexpected, run.testCase.id).toEqual([]);
    }
  });

  it('reports the production-vs-research comparison', () => {
    const rows = [...runs.values()].map((run) => {
      const { testCase } = run;
      const label = testCase.positives[0] ?? testCase.negatives[0];
      const research = loadResearchCandidates(testCase.id);
      const oracle = researchLexicalRanking(research);
      const inSnapshot = new Set(listSnapshotArtifacts(db, run.baseSnapshotId).map((a) => a.path));
      const oracleInPolicy = oracle.filter((path) => inSnapshot.has(path));
      const production = new Set(run.candidates.map((c) => c.path));

      const researchTerms = new Set<string>();
      const researchCandidate = research.find((c) => c.path === label);
      for (const term of [...(researchCandidate?.contentTerms ?? []), ...(researchCandidate?.pathTerms ?? [])]) {
        researchTerms.add(term);
      }
      const productionTerms = new Set(run.candidates.find((c) => c.path === label)?.matchedTerms ?? []);

      return {
        case: testCase.id,
        polarity: testCase.positives.length > 0 ? 'positive' : testCase.negatives.length > 0 ? 'negative' : 'none',
        prodCandidates: run.candidates.length,
        prodFalsePositives: run.candidates.length - (label && production.has(label) ? 1 : 0),
        resB2Candidates: research.length,
        resOutsideFilePolicy: research.length - oracleInPolicy.length,
        resSubstringOnly: oracleInPolicy.filter((path) => !production.has(path)).length,
        prodRank: label ? run.rankOf(label) : '-',
        resLexOnlyRank: label ? oracle.indexOf(label) + 1 || -1 : '-',
        resB6Rank: label ? loadResearchB6TruthRank(testCase.id) : '-',
        termsOnlyInResearch: [...researchTerms].filter((term) => !productionTerms.has(term)).join(','),
        termsOnlyInProduction: [...productionTerms].filter((term) => !researchTerms.has(term)).join(','),
      };
    });
    console.table(rows);
    expect(rows).toHaveLength(9);
  });
});
