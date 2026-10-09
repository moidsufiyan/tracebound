import { beforeAll, describe, expect, it } from 'vitest';
import { indexSnapshotStructurally } from '../../src/analysis/structural-index.js';
import { openDatabase, type Database } from '../../src/db/database.js';
import { ingestSnapshot } from '../../src/ingestion/ingest-snapshot.js';
import { createProject, registerRepository, type Repository } from '../../src/projects/projects.js';
import { constructEvidence, type EvidenceBundle, type FusionEvidence, type SemanticEvidence, type StructuralEvidence } from '../../src/retrieval/evidence.js';
import { searchHybridDetailed } from '../../src/retrieval/hybrid-search.js';
import { indexSnapshotLexically } from '../../src/retrieval/lexical-index.js';
import { createOllamaEmbeddingProvider } from '../../src/semantic/ollama-provider.js';
import type { EmbeddingProvider } from '../../src/semantic/provider.js';
import { indexSnapshotSemantically } from '../../src/semantic/semantic-index.js';
import {
  loadCases,
  ollamaUrl,
  repositoryPath,
  resolveCommit,
  semanticBenchmarkAvailable,
  type BenchmarkCase,
} from './benchmark.js';

// Builds evidence for the hybrid candidates of the 9-case Phase 1 benchmark on real repositories,
// to show that the facts can be verified and the source reconstructed on real data. It needs the
// same configuration as the semantic and hybrid benchmarks (a running Ollama and both repositories)
// and is skipped without it; TRACEBOUND_BENCHMARK_DB names an optional SQLite file that keeps the
// embeddings between runs.

const LIMIT = 50;

interface CaseRun {
  testCase: BenchmarkCase;
  bundle: EvidenceBundle;
}

const runs = new Map<string, CaseRun>();
let db: Database;
let provider: EmbeddingProvider;

function getOrCreateProject(name: string): number {
  const row = db.prepare('SELECT id FROM project WHERE name = ?').get(name) as { id: number } | undefined;
  return row?.id ?? createProject(db, name).id;
}

async function getOrRegisterRepository(projectId: number, name: string, sourcePath: string): Promise<Repository> {
  const row = db.prepare('SELECT id FROM repository WHERE project_id = ? AND name = ?').get(projectId, name) as { id: number } | undefined;
  if (row) return { id: row.id, projectId, name, sourcePath, createdAt: '' };
  return registerRepository(db, { projectId, name, sourcePath });
}

describe.skipIf(!semanticBenchmarkAvailable())('evidence on the Phase 1 benchmark', () => {
  beforeAll(async () => {
    db = openDatabase(process.env['TRACEBOUND_BENCHMARK_DB'] ?? ':memory:');
    provider = await createOllamaEmbeddingProvider({ endpoint: ollamaUrl()! });

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

      const result = await searchHybridDetailed(db, snapshot.id, provider, {
        description: testCase.description,
        changedPaths: [...testCase.changedPaths],
        ...(testCase.query.symbols ? { symbols: testCase.query.symbols } : {}),
      });
      // Evidence is built from this one run: it does not search or embed again.
      runs.set(testCase.id, { testCase, bundle: constructEvidence(db, snapshot.id, provider, result, { limit: LIMIT }) });
    }
  }, 3_600_000);

  const all = <T extends { type: string }>(type: T['type']) =>
    [...runs.values()].flatMap((run) => run.bundle.candidates.flatMap((c) => c.evidence.filter((e): e is Extract<typeof e, T> => e.type === type) as unknown as T[]));

  it('verifies every candidate and builds evidence for the top candidates of every case', () => {
    for (const run of runs.values()) {
      expect(run.bundle.candidates.length, run.testCase.id).toBe(LIMIT);
      // The changed files are never among the candidates that were described.
      expect(run.bundle.candidates.some((c) => run.testCase.changedPaths.has(c.path)), run.testCase.id).toBe(false);
    }
  });

  it('locates the import declaration of every structural fact on real source', () => {
    const structural = all<StructuralEvidence>('structural');
    console.log(`structural evidence: ${structural.length}, declarations located: ${structural.filter((e) => e.declarations).length}`);
    expect(structural.length).toBeGreaterThan(0);
    expect(structural.filter((e) => e.declarations === null).map((e) => `${e.source.path} -> ${e.target.path}`)).toEqual([]);
  });

  it('reconstructs the source text of every semantic chunk it describes', () => {
    const semantic = all<SemanticEvidence>('semantic');
    const unavailable = semantic.filter((e) => e.chunk === null);
    console.log(`semantic evidence: ${semantic.length}, chunk text reconstructed: ${semantic.length - unavailable.length}`);
    expect(semantic.length).toBeGreaterThan(0);
    expect(unavailable.map((e) => e.id)).toEqual([]);
    expect(semantic.every((e) => e.chunk !== null && !e.chunk.text.includes('search_document:'))).toBe(true);
  });

  it('records contributions that add up to every score', () => {
    for (const fusion of all<FusionEvidence>('fusion')) {
      const sum = (fusion.deterministic?.contribution ?? 0) + (fusion.semantic?.contribution ?? 0);
      expect(Math.abs(sum - fusion.rrfScore)).toBeLessThan(1e-12);
      expect(fusion.k).toBe(60);
    }
  });

  it('records the TB-0009 consensus and import as facts, with no claim of impact', () => {
    const run = runs.get('TB-0009')!;
    const negative = run.bundle.candidates.find((c) => c.path === run.testCase.negatives[0])!;
    const structural = negative.evidence.filter((e): e is StructuralEvidence => e.type === 'structural');
    const fusion = negative.evidence.find((e): e is FusionEvidence => e.type === 'fusion')!;

    console.log(
      `TB-0009 negative: fused ${negative.rank}, deterministic ${fusion.deterministic?.rank}, semantic ${fusion.semantic?.rank}, ` +
        `structural ${structural.map((e) => `${e.signal} ${e.source.path} -> ${e.target.path} line ${e.declarations?.[0]?.startLine}`).join('; ')}`,
    );
    expect(fusion.deterministic).not.toBeNull();
    expect(fusion.semantic).not.toBeNull();
    expect(structural.map((e) => e.signal)).toEqual(['incoming-import']);
    expect(structural[0]!.target.path).toBe('src/utils/stream.ts');
    expect(structural[0]!.declarations![0]!.specifier).toMatch(/utils\/stream/);
    expect(JSON.stringify(run.bundle)).not.toMatch(/impacted|affected|conclusion/i);
  });
});
