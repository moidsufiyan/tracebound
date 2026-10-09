import { beforeAll, describe, expect, it } from 'vitest';
import { indexSnapshotStructurally } from '../../src/analysis/structural-index.js';
import { openDatabase, type Database } from '../../src/db/database.js';
import { ingestSnapshot } from '../../src/ingestion/ingest-snapshot.js';
import { createProject, registerRepository, type Repository } from '../../src/projects/projects.js';
import { retrieveCandidates } from '../../src/retrieval/deterministic-retrieval.js';
import { searchHybrid } from '../../src/retrieval/hybrid-search.js';
import { indexSnapshotLexically } from '../../src/retrieval/lexical-index.js';
import { fuseRrf, type FusedCandidate } from '../../src/retrieval/rrf.js';
import { createOllamaEmbeddingProvider } from '../../src/semantic/ollama-provider.js';
import type { EmbeddingProvider } from '../../src/semantic/provider.js';
import { indexSnapshotSemantically } from '../../src/semantic/semantic-index.js';
import { searchSemantic } from '../../src/semantic/semantic-search.js';
import {
  loadCases,
  loadResearchHybridRank,
  ollamaUrl,
  repositoryPath,
  resolveCommit,
  semanticBenchmarkAvailable,
  type BenchmarkCase,
} from './benchmark.js';

// Compares deterministic-only, semantic-only and hybrid (RRF, K = 60) retrieval over the 9-case
// Phase 1 benchmark, searching each case's base commit. It calls a real Ollama server, so it needs
// TRACEBOUND_OLLAMA_URL as well as the repositories named by TRACEBOUND_WOLLYWAY_REPO and
// TRACEBOUND_HONO_REPO, and is skipped without them. TRACEBOUND_BENCHMARK_DB names an optional
// SQLite file that keeps the embeddings between runs.
//
// Protocol, as in the historical H2 run (experiments/hybrid/index.js): the deterministic ranking
// had the changed files removed (unless labelled) and was renumbered, while the semantic ranking
// was B7's, which ranks every artifact. "Both filtered" is also reported, so the effect of that
// asymmetry can be read. The production API removes nothing.
//
// Pinned values are measurements of this implementation, not targets; ground truth is never edited.

const K_VALUES = [1, 3, 5, 10, 20] as const;

type Ranks = Map<string, number>;

interface CaseRun {
  testCase: BenchmarkCase;
  /** Deterministic-only: M4, changed files removed. */
  deterministic: Ranks;
  /** Semantic-only: M5 under the B7 protocol, every artifact ranked. */
  semantic: Ranks;
  /** Hybrid under the historical protocol. */
  hybrid: FusedCandidate[];
  hybridRanks: Ranks;
  /** Hybrid with the changed files removed from both rankings before fusion. */
  hybridFilteredRanks: Ranks;
  /** The production API's own output, nothing removed. */
  production: FusedCandidate[];
  productionRanks: Ranks;
}

const runs = new Map<string, CaseRun>();
let db: Database;
let provider: EmbeddingProvider;

const label = (testCase: BenchmarkCase) => testCase.positives[0] ?? testCase.negatives[0];
const rankOf = (ranks: Ranks, path: string | undefined) => (path === undefined ? null : (ranks.get(path) ?? null));
const ranksOf = (list: readonly { path: string; rank: number }[]): Ranks => new Map(list.map((c) => [c.path, c.rank]));
const renumbered = <T extends { rank: number }>(list: readonly T[]): T[] => list.map((c, index) => ({ ...c, rank: index + 1 }));

function getOrCreateProject(name: string): number {
  const row = db.prepare('SELECT id FROM project WHERE name = ?').get(name) as { id: number } | undefined;
  return row?.id ?? createProject(db, name).id;
}

async function getOrRegisterRepository(projectId: number, name: string, sourcePath: string): Promise<Repository> {
  const row = db.prepare('SELECT id FROM repository WHERE project_id = ? AND name = ?').get(projectId, name) as { id: number } | undefined;
  if (row) return { id: row.id, projectId, name, sourcePath, createdAt: '' };
  return registerRepository(db, { projectId, name, sourcePath });
}

const recallAt = (positives: { run: CaseRun; path: string }[], pick: (run: CaseRun) => Ranks) =>
  K_VALUES.map((k) =>
    positives.filter(({ run, path }) => {
      const rank = rankOf(pick(run), path);
      return rank !== null && rank <= k;
    }).length,
  );

describe.skipIf(!semanticBenchmarkAvailable())('hybrid retrieval on the Phase 1 benchmark', () => {
  beforeAll(async () => {
    db = openDatabase(process.env['TRACEBOUND_BENCHMARK_DB'] ?? ':memory:');
    provider = await createOllamaEmbeddingProvider({ endpoint: ollamaUrl()! });
    console.log(`semantic provider: ${provider.modelId}`);

    const projectId = getOrCreateProject('benchmark');
    const repositories = new Map<string, Repository>();
    for (const testCase of loadCases()) {
      const sourcePath = repositoryPath(testCase.repositoryName)!;
      let repository = repositories.get(testCase.repositoryName);
      if (!repository) {
        repository = await getOrRegisterRepository(projectId, testCase.repositoryName, sourcePath);
        repositories.set(testCase.repositoryName, repository);
      }
      const { snapshot } = await ingestSnapshot(db, repository.id, resolveCommit(sourcePath, testCase.baseCommit));
      indexSnapshotLexically(db, snapshot.id);
      indexSnapshotStructurally(db, snapshot.id);
      await indexSnapshotSemantically(db, snapshot.id, provider);

      const changedPaths = [...testCase.changedPaths];
      const keep = new Set([...testCase.positives, ...testCase.negatives]);
      const visible = (c: { path: string }) => !testCase.changedPaths.has(c.path) || keep.has(c.path);

      const deterministicRaw = retrieveCandidates(db, snapshot.id, { ...testCase.query, changedPaths });
      const semanticRaw = await searchSemantic(db, snapshot.id, provider, { description: testCase.description, changedPaths });
      const deterministicFiltered = renumbered(deterministicRaw.filter(visible));
      const semanticFiltered = renumbered(semanticRaw.filter(visible));

      const hybrid = fuseRrf(deterministicFiltered, semanticRaw);
      const production = await searchHybrid(db, snapshot.id, provider, {
        description: testCase.description,
        changedPaths,
        ...(testCase.query.symbols ? { symbols: testCase.query.symbols } : {}),
      });
      // The production orchestrator, with nothing removed, is exactly the fusion of the two raw rankings.
      expect(production, testCase.id).toEqual(fuseRrf(deterministicRaw, semanticRaw));

      runs.set(testCase.id, {
        testCase,
        deterministic: ranksOf(deterministicFiltered),
        semantic: ranksOf(semanticRaw),
        hybrid,
        hybridRanks: ranksOf(hybrid),
        hybridFilteredRanks: ranksOf(fuseRrf(deterministicFiltered, semanticFiltered)),
        production,
        productionRanks: ranksOf(production),
      });
    }
  }, 3_600_000);

  const positives = () => [...runs.values()].flatMap((run) => run.testCase.positives.map((path) => ({ run, path })));

  it('compares deterministic-only, semantic-only and hybrid recall at K on the same cases', () => {
    const rows = {
      'deterministic (M4)': recallAt(positives(), (run) => run.deterministic),
      'semantic (M5)': recallAt(positives(), (run) => run.semantic),
      'hybrid (RRF, historical protocol)': recallAt(positives(), (run) => run.hybridRanks),
      'hybrid (changed files removed from both)': recallAt(positives(), (run) => run.hybridFilteredRanks),
      'hybrid (production API, nothing removed)': recallAt(positives(), (run) => run.productionRanks),
    };
    console.log(`recall over ${positives().length} positives at K = ${K_VALUES.join(', ')}:`);
    console.table(rows);

    expect(positives()).toHaveLength(7);
    expect(rows['deterministic (M4)']).toEqual([2, 3, 3, 4, 6]);
    expect(rows['semantic (M5)']).toEqual([0, 4, 4, 4, 7]);
    expect(rows['hybrid (RRF, historical protocol)']).toEqual([2, 3, 4, 6, 7]);
    expect(rows['hybrid (changed files removed from both)']).toEqual([2, 3, 4, 6, 7]);
    expect(rows['hybrid (production API, nothing removed)']).toEqual([2, 3, 4, 6, 7]);
  });

  it('matches the pinned per-case ranks and candidate volumes', () => {
    const measured = Object.fromEntries(
      [...runs].map(([id, run]) => {
        const target = label(run.testCase);
        return [
          id,
          {
            deterministic: rankOf(run.deterministic, target),
            semantic: rankOf(run.semantic, target),
            hybrid: rankOf(run.hybridRanks, target),
            hybridFiltered: rankOf(run.hybridFilteredRanks, target),
            production: rankOf(run.productionRanks, target),
            candidates: run.hybrid.length,
          },
        ];
      }),
    );
    const rank = (deterministic: number | null, semantic: number | null, hybrid: number | null, hybridFiltered: number | null, production: number | null, candidates: number) => ({
      deterministic,
      semantic,
      hybrid,
      hybridFiltered,
      production,
      candidates,
    });
    expect(measured).toEqual({
      'TB-0001': rank(7, 13, 6, 6, 7, 319),
      'TB-0002': rank(35, 2, 4, 4, 4, 319),
      'TB-0003': rank(1, 2, 1, 1, 1, 541),
      'TB-0004': rank(1, 2, 1, 1, 1, 541),
      'TB-0005': rank(2, 3, 2, 2, 3, 445),
      'TB-0006': rank(20, 18, 15, 14, 16, 319),
      'TB-0007': rank(11, 13, 9, 9, 10, 317),
      'TB-0008': rank(null, null, null, null, null, 541), // docs-only change, no labelled candidate
      'TB-0009': rank(3, 3, 2, 2, 3, 446), // negative case: the labelled candidate is NOT relevant
    });
  });

  it('returns every artifact of the snapshot once, with consecutive fused ranks', () => {
    for (const run of runs.values()) {
      expect(run.production.map((c) => c.rank), run.testCase.id).toEqual(run.production.map((_, i) => i + 1));
      expect(new Set(run.production.map((c) => c.versionId)).size, run.testCase.id).toBe(run.production.length);
      // Semantic retrieval ranks every artifact, so the union is that universe.
      expect(run.production.every((c) => c.semanticRank !== null), run.testCase.id).toBe(true);
      expect(run.production).toHaveLength(run.semantic.size);
    }
  });

  it('is deterministic: repeating the fusion returns the identical ordered list', async () => {
    for (const run of runs.values()) {
      const testCase = run.testCase;
      const again = await searchHybrid(db, run.production[0] ? snapshotIdOf(run) : 0, provider, {
        description: testCase.description,
        changedPaths: [...testCase.changedPaths],
        ...(testCase.query.symbols ? { symbols: testCase.query.symbols } : {}),
      });
      expect(again, testCase.id).toEqual(run.production);
    }
  });

  it('keeps the TB-0009 consensus: the negative is found by both modalities and fused above its weaker rank', () => {
    const run = runs.get('TB-0009')!;
    const negative = run.hybrid.find((c) => c.path === run.testCase.negatives[0])!;
    console.log(`TB-0009 negative: deterministic ${negative.deterministicRank}, semantic ${negative.semanticRank}, hybrid ${negative.rank}`);
    expect(negative.deterministicRank).not.toBeNull();
    expect(negative.semanticRank).not.toBeNull();
    expect(negative.rank).toBeLessThanOrEqual(Math.max(negative.deterministicRank!, negative.semanticRank!));
  });

  it('keeps the abstraction-gap cases retrievable through the hybrid ranking', () => {
    for (const id of ['TB-0002', 'TB-0006', 'TB-0007']) {
      const run = runs.get(id)!;
      const target = run.testCase.positives[0]!;
      const hybrid = rankOf(run.hybridRanks, target)!;
      console.log(`${id}: deterministic ${rankOf(run.deterministic, target)}, semantic ${rankOf(run.semantic, target)}, hybrid ${hybrid}`);
      expect(hybrid, id).toBeLessThanOrEqual(20);
    }
  });

  it('only fuses artifacts of the searched snapshot', () => {
    for (const run of runs.values()) {
      const inFused = new Set(run.production.map((c) => c.path));
      for (const path of [...run.deterministic.keys(), ...run.semantic.keys()]) expect(inFused.has(path), `${run.testCase.id} ${path}`).toBe(true);
    }
  });

  it('reports the per-case comparison with the historical H2 run', () => {
    const rows = [...runs.values()].map((run) => {
      const target = label(run.testCase);
      const historical = target ? loadResearchHybridRank(run.testCase.id, target) : undefined;
      return {
        case: run.testCase.id,
        polarity: run.testCase.positives.length > 0 ? 'positive' : run.testCase.negatives.length > 0 ? 'negative' : 'none',
        candidates: run.hybrid.length,
        deterministic: rankOf(run.deterministic, target) ?? '-',
        semantic: rankOf(run.semantic, target) ?? '-',
        hybrid: rankOf(run.hybridRanks, target) ?? '-',
        hybridFiltered: rankOf(run.hybridFilteredRanks, target) ?? '-',
        productionApi: rankOf(run.productionRanks, target) ?? '-',
        historicalH2: target ? (historical?.rank ?? '>20') : '-',
        historicalDeterministic: historical?.deterministicRank ?? '-',
        historicalSemantic: historical?.semanticRank ?? '-',
      };
    });
    console.table(rows);
    expect(rows).toHaveLength(9);
  });
});

function snapshotIdOf(run: CaseRun): number {
  const row = db
    .prepare('SELECT snapshot_id FROM artifact_version WHERE id = ?')
    .get(run.production[0]!.versionId) as { snapshot_id: number };
  return row.snapshot_id;
}
