import { beforeAll, describe, expect, it } from 'vitest';
import { indexSnapshotStructurally } from '../../src/analysis/structural-index.js';
import { listSnapshotArtifacts, readContent } from '../../src/artifacts/artifacts.js';
import { openDatabase, type Database } from '../../src/db/database.js';
import { ingestSnapshot } from '../../src/ingestion/ingest-snapshot.js';
import { createProject, registerRepository, type Repository } from '../../src/projects/projects.js';
import { retrieveCandidates } from '../../src/retrieval/deterministic-retrieval.js';
import { indexSnapshotLexically } from '../../src/retrieval/lexical-index.js';
import { chunkArtifact, embeddingInputHash } from '../../src/semantic/chunking.js';
import { createOllamaEmbeddingProvider } from '../../src/semantic/ollama-provider.js';
import type { EmbeddingProvider } from '../../src/semantic/provider.js';
import { indexSnapshotSemantically } from '../../src/semantic/semantic-index.js';
import { searchSemantic, type SemanticCandidate } from '../../src/semantic/semantic-search.js';
import {
  loadCases,
  loadResearchEmbeddingKeys,
  loadResearchSemantic,
  ollamaUrl,
  repositoryPath,
  resolveCommit,
  semanticBenchmarkAvailable,
  type BenchmarkCase,
} from './benchmark.js';

// Runs production semantic retrieval over the 9-case Phase 1 benchmark, searching each case's base
// commit with the B7 query, and compares it with B7.1 and with deterministic retrieval. It calls a
// real Ollama server, so it needs TRACEBOUND_OLLAMA_URL (for example http://127.0.0.1:11434) as well
// as the repositories named by TRACEBOUND_WOLLYWAY_REPO and TRACEBOUND_HONO_REPO, and is skipped
// without them. TRACEBOUND_BENCHMARK_DB names an optional SQLite file that keeps the embeddings
// between runs, which is the reuse the index is built for.
//
// Pinned values are measurements of this implementation, not targets; ground truth is never edited.

const K_VALUES = [1, 3, 5, 10, 20] as const;

interface CaseRun {
  testCase: BenchmarkCase;
  snapshotId: number;
  /** Every artifact of the base snapshot, as B7.1 ranked them. */
  candidates: SemanticCandidate[];
  rankOf: (path: string) => number;
  /** Rank after removing the changed files unless labelled, as the deterministic pipelines were evaluated. */
  rankExcludingChanged: (path: string) => number;
  deterministicRank: (path: string) => number;
}

/** Rank of the labelled candidate under the B7.1 protocol, which ranks every artifact, and the candidate count. */
const EXPECTED: Record<string, { rank: number | null; candidates: number }> = {
  'TB-0001': { rank: 13, candidates: 319 },
  'TB-0002': { rank: 2, candidates: 319 },
  'TB-0003': { rank: 2, candidates: 541 },
  'TB-0004': { rank: 2, candidates: 541 },
  'TB-0005': { rank: 3, candidates: 445 },
  'TB-0006': { rank: 18, candidates: 319 },
  'TB-0007': { rank: 13, candidates: 317 },
  'TB-0008': { rank: null, candidates: 541 }, // docs-only change, no labelled candidate
  'TB-0009': { rank: 3, candidates: 446 }, // negative case: the labelled candidate is NOT relevant
};

const runs = new Map<string, CaseRun>();
let db: Database;
let provider: EmbeddingProvider;

const label = (testCase: BenchmarkCase) => testCase.positives[0] ?? testCase.negatives[0];

function chunkCount(artifactId: number, snapshotId: number): number {
  const row = db
    .prepare('SELECT count(*) AS n FROM semantic_chunk WHERE model_id = ? AND snapshot_id = ? AND artifact_id = ?')
    .get(provider.modelId, snapshotId, artifactId) as { n: number };
  return row.n;
}

function getOrCreateProject(name: string): number {
  const row = db.prepare('SELECT id FROM project WHERE name = ?').get(name) as { id: number } | undefined;
  return row?.id ?? createProject(db, name).id;
}

async function getOrRegisterRepository(projectId: number, name: string, sourcePath: string): Promise<Repository> {
  const row = db.prepare('SELECT id FROM repository WHERE project_id = ? AND name = ?').get(projectId, name) as { id: number } | undefined;
  if (row) return { id: row.id, projectId, name, sourcePath, createdAt: '' };
  return registerRepository(db, { projectId, name, sourcePath });
}

describe.skipIf(!semanticBenchmarkAvailable())('semantic retrieval on the Phase 1 benchmark', () => {
  beforeAll(async () => {
    db = openDatabase(process.env['TRACEBOUND_BENCHMARK_DB'] ?? ':memory:');
    provider = await createOllamaEmbeddingProvider({ endpoint: ollamaUrl()! });
    console.log(`semantic provider: ${provider.modelId}, ${provider.dimensions} dimensions, ${provider.maxInputChars} characters per input`);

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
      const started = Date.now();
      const indexing = await indexSnapshotSemantically(db, snapshot.id, provider);
      console.log(`${testCase.id}: ${JSON.stringify(indexing)} in ${Math.round((Date.now() - started) / 1000)}s`);

      const candidates = await searchSemantic(db, snapshot.id, provider, {
        description: testCase.description,
        changedPaths: [...testCase.changedPaths],
      });
      const keep = new Set([...testCase.positives, ...testCase.negatives]);
      const visible = (path: string) => !testCase.changedPaths.has(path) || keep.has(path);
      const ranks = new Map(candidates.map((c) => [c.path, c.rank]));
      const filtered = new Map(candidates.filter((c) => visible(c.path)).map((c, index) => [c.path, index + 1]));
      const deterministic = new Map(
        retrieveCandidates(db, snapshot.id, { ...testCase.query, changedPaths: [...testCase.changedPaths] })
          .filter((c) => visible(c.path))
          .map((c, index) => [c.path, index + 1]),
      );
      runs.set(testCase.id, {
        testCase,
        snapshotId: snapshot.id,
        candidates,
        rankOf: (path) => ranks.get(path) ?? -1,
        rankExcludingChanged: (path) => filtered.get(path) ?? -1,
        deterministicRank: (path) => deterministic.get(path) ?? -1,
      });
    }
  }, 3_600_000);

  it('embeds, for every file that fits, exactly the text B7.1 embedded', () => {
    const research = loadResearchEmbeddingKeys();
    let whole = 0;
    let wholeInResearch = 0;
    let chunks = 0;
    for (const run of runs.values()) {
      for (const artifact of listSnapshotArtifacts(db, run.snapshotId)) {
        for (const input of chunkArtifact(artifact.path, readContent(db, artifact.contentSha256)!, provider.maxInputChars)) {
          const isChunk = input.text.startsWith(`search_document: File: ${artifact.path} (Chunk `);
          if (isChunk) chunks += 1;
          else {
            whole += 1;
            if (research.has(embeddingInputHash(input.text))) wholeInResearch += 1;
          }
        }
      }
    }
    console.log(`whole-file inputs: ${whole}, found in the B7.1 embedding cache: ${wholeInResearch}; chunk inputs: ${chunks}`);
    expect(wholeInResearch).toBe(whole);
  });

  it('scores every file that was embedded whole exactly as B7.1 did', () => {
    let wholeFiles = 0;
    let chunkedFiles = 0;
    let chunkedDiffering = 0;
    for (const run of runs.values()) {
      const research = new Map(loadResearchSemantic(run.testCase.id).ranking.map((c) => [c.path, c.similarity]));
      for (const candidate of run.candidates) {
        const expected = research.get(candidate.path);
        const wholeFile = candidate.bestChunkIndex === 0 && chunkCount(candidate.artifactId, run.snapshotId) === 1;
        if (wholeFile) {
          wholeFiles += 1;
          // Identical input, identical model: the score is B7.1's up to float32 storage.
          expect(candidate.similarityScore, `${run.testCase.id} ${candidate.path}`).toBeCloseTo(expected!, 4);
        } else {
          chunkedFiles += 1;
          if (expected === undefined || Math.abs(candidate.similarityScore - expected) > 1e-4) chunkedDiffering += 1;
        }
      }
    }
    console.log(`scored like B7.1: ${wholeFiles} whole-file artifacts; chunked artifacts: ${chunkedFiles}, of which differing from B7.1: ${chunkedDiffering}`);
    expect(wholeFiles).toBeGreaterThan(0);
  });

  it('reports recall at K and the rank of every labelled candidate under the B7.1 protocol', () => {
    const positives = [...runs.values()].flatMap((run) => run.testCase.positives.map((path) => ({ run, path })));
    const hits = (k: number) => positives.filter(({ run, path }) => run.rankOf(path) >= 1 && run.rankOf(path) <= k).length;
    console.log('semantic recall:', JSON.stringify(Object.fromEntries(K_VALUES.map((k) => [`top${k}`, `${hits(k)}/${positives.length}`]))));
    expect(positives).toHaveLength(7);
    expect(positives.every(({ run, path }) => run.rankOf(path) >= 1)).toBe(true);
    expect(K_VALUES.map(hits)).toEqual([0, 4, 4, 4, 7]);
  });

  it('matches the pinned per-case ranks', () => {
    const measured = Object.fromEntries(
      [...runs.entries()].map(([id, run]) => [
        id,
        { rank: label(run.testCase) ? run.rankOf(label(run.testCase)!) : null, candidates: run.candidates.length },
      ]),
    );
    expect(measured).toEqual(EXPECTED);
  });

  it('is deterministic: repeating a search returns the identical ordered list', async () => {
    for (const run of runs.values()) {
      const query = { description: run.testCase.description, changedPaths: [...run.testCase.changedPaths] };
      expect(await searchSemantic(db, run.snapshotId, provider, query)).toEqual(await searchSemantic(db, run.snapshotId, provider, query));
    }
  });

  it('returns one candidate per artifact of the searched snapshot and nothing from any other snapshot', () => {
    const pathsBySnapshot = new Map([...runs.values()].map((run) => [run.snapshotId, new Set(listSnapshotArtifacts(db, run.snapshotId).map((a) => a.path))]));
    let foreign = 0;
    let leaked = 0;
    for (const run of runs.values()) {
      const own = pathsBySnapshot.get(run.snapshotId)!;
      expect(run.candidates.map((c) => c.path).sort(), run.testCase.id).toEqual([...own].sort());
      // Snapshots of the same repository share embeddings but not membership.
      const returned = new Set(run.candidates.map((c) => c.path));
      for (const [otherId, other] of pathsBySnapshot) {
        if (otherId === run.snapshotId) continue;
        const onlyThere = [...other].filter((path) => !own.has(path));
        foreign += onlyThere.length;
        leaked += onlyThere.filter((path) => returned.has(path)).length;
      }
    }
    expect(foreign).toBeGreaterThan(0); // other snapshots do contain artifacts this one lacks
    expect(leaked).toBe(0);
  });

  it('keeps the TB-0009 negative as a documented semantic false positive', () => {
    const run = runs.get('TB-0009')!;
    const negative = run.candidates.find((c) => c.path === run.testCase.negatives[0])!;
    console.log(`TB-0009 negative: rank ${negative.rank}, similarity ${negative.similarityScore.toFixed(4)}`);
    expect(negative.rank).toBeGreaterThan(1);
  });

  it('reports the production-vs-research comparison', () => {
    const rows = [...runs.values()].map((run) => {
      const { testCase } = run;
      const target = label(testCase);
      const research = loadResearchSemantic(testCase.id);
      const researchRank = research.labelled.find((l) => l.path === target)?.rank;
      const top10 = new Set(run.candidates.slice(0, 10).map((c) => c.path));
      const researchTop10 = new Set(research.ranking.slice(0, 10).map((c) => c.path));
      const overlap = [...top10].filter((path) => researchTop10.has(path)).length;
      return {
        case: testCase.id,
        polarity: testCase.positives.length > 0 ? 'positive' : testCase.negatives.length > 0 ? 'negative' : 'none',
        candidates: run.candidates.length,
        resB71Artifacts: research.totalArtifacts,
        rank: target ? run.rankOf(target) : '-',
        resB71Rank: target ? (researchRank ?? '-') : '-',
        rankExclChanged: target ? run.rankExcludingChanged(target) : '-',
        deterministicRank: target ? run.deterministicRank(target) : '-',
        similarity: target ? Number(run.candidates.find((c) => c.path === target)!.similarityScore.toFixed(4)) : '-',
        resB71Similarity: target ? (research.labelled.find((l) => l.path === target)?.similarity?.toFixed(4) ?? '-') : '-',
        top10OverlapWithB71: overlap,
        top1: run.candidates[0]?.path.split('/').slice(-2).join('/'),
      };
    });
    console.table(rows);
    expect(rows).toHaveLength(9);
  });
});
