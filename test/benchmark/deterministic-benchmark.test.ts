import { posix } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseDialectFor } from '../../src/analysis/import-extraction.js';
import { resolveRelativeImport } from '../../src/analysis/module-resolution.js';
import { indexSnapshotStructurally } from '../../src/analysis/structural-index.js';
import { listSnapshotArtifacts, readContent } from '../../src/artifacts/artifacts.js';
import { openDatabase, type Database } from '../../src/db/database.js';
import { ingestSnapshot } from '../../src/ingestion/ingest-snapshot.js';
import { createProject, registerRepository, type Repository } from '../../src/projects/projects.js';
import { retrieveCandidates, type DeterministicCandidate } from '../../src/retrieval/deterministic-retrieval.js';
import { indexSnapshotLexically } from '../../src/retrieval/lexical-index.js';
import { searchLexical } from '../../src/retrieval/lexical-search.js';
import { compareSnapshots } from '../../src/snapshots/compare-snapshots.js';
import {
  benchmarkAvailable,
  loadCases,
  loadResearchB6CandidateCount,
  loadResearchB6TruthRank,
  loadResearchStructural,
  repositoryPath,
  resolveCommit,
  type BenchmarkCase,
  type ResearchStructuralKind,
} from './benchmark.js';

// Runs the production deterministic retrieval (lexical + structural) over the 9-case Phase 1
// benchmark, searching each case's base commit, and compares it with B1/B5/B6. Needs the source
// repositories named by TRACEBOUND_WOLLYWAY_REPO and TRACEBOUND_HONO_REPO; skipped without them.
//
// Pinned values are measurements of this implementation, not targets; ground truth is never edited.

const K_VALUES = [1, 3, 5, 10, 20] as const;

/** Rank of the case's labelled candidate and the number of candidates, as measured. */
const EXPECTED: Record<string, { rank: number | null; candidates: number; category: string | null }> = {
  'TB-0001': { rank: 7, candidates: 186, category: 'path-and-multi-content' },
  'TB-0002': { rank: 35, candidates: 209, category: 'path-and-multi-content' },
  'TB-0003': { rank: 1, candidates: 345, category: 'critical-structural' },
  'TB-0004': { rank: 1, candidates: 298, category: 'critical-structural' },
  'TB-0005': { rank: 2, candidates: 155, category: 'critical-structural' },
  'TB-0006': { rank: 20, candidates: 196, category: 'path-and-multi-content' },
  'TB-0007': { rank: 11, candidates: 264, category: 'path-and-multi-content' },
  'TB-0008': { rank: null, candidates: 366, category: null }, // docs-only change, no labelled candidate
  'TB-0009': { rank: 3, candidates: 284, category: 'critical-structural' }, // negative: NOT relevant
};

interface CaseRun {
  testCase: BenchmarkCase;
  baseSnapshotId: number;
  laterSnapshotId: number;
  /** Candidates with the case's changed files removed unless labelled, as B1/B2/B6 were evaluated. */
  candidates: DeterministicCandidate[];
  lexicalRanks: Map<string, number>;
  rankOf: (path: string) => number;
}

const runs = new Map<string, CaseRun>();
let db: Database;

const label = (testCase: BenchmarkCase) => testCase.positives[0] ?? testCase.negatives[0];

describe.skipIf(!benchmarkAvailable())('deterministic retrieval on the Phase 1 benchmark', () => {
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
        indexSnapshotStructurally(db, snapshot.id);
        return snapshot.id;
      };
      const baseSnapshotId = await snapshotOf(testCase.baseCommit);
      const laterSnapshotId = await snapshotOf('HEAD');

      const keep = new Set([...testCase.positives, ...testCase.negatives]);
      const visible = (path: string) => !testCase.changedPaths.has(path) || keep.has(path);
      const query = { ...testCase.query, changedPaths: [...testCase.changedPaths] };
      const candidates = retrieveCandidates(db, baseSnapshotId, query)
        .filter((c) => visible(c.path))
        .map((c, index) => ({ ...c, rank: index + 1 }));
      const ranks = new Map(candidates.map((c) => [c.path, c.rank]));
      const lexicalRanks = new Map(
        searchLexical(db, baseSnapshotId, testCase.query)
          .filter((c) => visible(c.path))
          .map((c, index) => [c.path, index + 1] as const),
      );
      runs.set(testCase.id, {
        testCase,
        baseSnapshotId,
        laterSnapshotId,
        candidates,
        lexicalRanks,
        rankOf: (path) => ranks.get(path) ?? -1,
      });
    }
  }, 900_000);

  it('reports recall at K and the rank of every labelled candidate', () => {
    const positives = [...runs.values()].flatMap((run) => run.testCase.positives.map((path) => ({ run, path })));
    const hits = (k: number) => positives.filter(({ run, path }) => run.rankOf(path) >= 1 && run.rankOf(path) <= k).length;
    console.log(
      'deterministic recall:',
      JSON.stringify(Object.fromEntries(K_VALUES.map((k) => [`top${k}`, `${hits(k)}/${positives.length}`]))),
    );
    expect(positives).toHaveLength(7);
    expect(positives.every(({ run, path }) => run.rankOf(path) >= 1)).toBe(true);
    expect(K_VALUES.map(hits)).toEqual([2, 3, 3, 4, 6]);
  });

  it('matches the pinned per-case ranks, categories and candidate volumes', () => {
    for (const [caseId, expected] of Object.entries(EXPECTED)) {
      const run = runs.get(caseId)!;
      const target = label(run.testCase);
      const candidate = run.candidates.find((c) => c.path === target);
      expect(
        { rank: target ? run.rankOf(target) : null, candidates: run.candidates.length, category: candidate?.category ?? null },
        caseId,
      ).toEqual(expected);
    }
  });

  it('finds the structural relationship of every positive that is labelled structurally, as B1 did', () => {
    const structural = new Set(['test-of', 'direct_structural', 'transitive_structural']);
    let labelled = 0;
    for (const run of runs.values()) {
      run.testCase.positives.forEach((path, index) => {
        if (!structural.has(run.testCase.positiveRelationships[index]!)) return;
        labelled += 1;
        const candidate = run.candidates.find((c) => c.path === path)!;
        expect(candidate.structuralSignals.length, run.testCase.id).toBeGreaterThan(0);
        expect(candidate.category, run.testCase.id).toBe('critical-structural');
      });
    }
    expect(labelled).toBe(3); // TB-0003, TB-0004, TB-0005
  });

  it('keeps TB-0009 structurally flagged: the negative is not suppressed by deterministic signals', () => {
    const run = runs.get('TB-0009')!;
    const negative = run.candidates.find((c) => c.path === run.testCase.negatives[0])!;
    // Documented limitation, as in B6: it imports the changed file, so it ranks high although the
    // change is internal and needs no investigation of it.
    expect(negative.structuralSignals.map((s) => s.kind)).toEqual(['incoming-import']);
    expect(negative.rank).toBeGreaterThan(1);
  });

  it('is deterministic: repeating a retrieval returns the identical ordered list', () => {
    for (const run of runs.values()) {
      const query = { ...run.testCase.query, changedPaths: [...run.testCase.changedPaths] };
      expect(retrieveCandidates(db, run.baseSnapshotId, query)).toEqual(retrieveCandidates(db, run.baseSnapshotId, query));
    }
  });

  it('only returns artifacts of the searched snapshot and never anything from a later one', () => {
    let visibleLater = 0;
    for (const run of runs.values()) {
      const inBase = new Set(listSnapshotArtifacts(db, run.baseSnapshotId).map((a) => a.path));
      expect(run.candidates.every((c) => inBase.has(c.path)), run.testCase.id).toBe(true);

      const added = new Set(
        compareSnapshots(db, run.baseSnapshotId, run.laterSnapshotId)
          .filter((c) => c.change === 'added')
          .map((c) => c.path),
      );
      const query = { ...run.testCase.query, changedPaths: [...run.testCase.changedPaths] };
      const later = retrieveCandidates(db, run.laterSnapshotId, query).filter((c) => added.has(c.path));
      visibleLater += later.length;
      expect(run.candidates.filter((c) => added.has(c.path)), run.testCase.id).toEqual([]);
    }

    // Not vacuous: files that exist only later do become candidates once their own snapshot is used.
    expect(visibleLater).toBeGreaterThan(0);
  });

  it('every structural signal is backed by an import that an independent extraction also finds', () => {
    let checked = 0;
    for (const run of runs.values()) {
      const paths = new Set(listSnapshotArtifacts(db, run.baseSnapshotId).map((a) => a.path));
      const importsOf = (path: string) => independentImports(db, run.baseSnapshotId, path, paths);

      for (const candidate of run.candidates) {
        for (const { kind, changedPath } of candidate.structuralSignals) {
          const [importer, imported] = kind === 'outgoing-import' ? [changedPath, candidate.path] : [candidate.path, changedPath];
          expect(importsOf(importer), `${run.testCase.id}: ${importer} imports ${imported}`).toContain(imported);
          if (kind === 'test-to-source') expect(importer).toMatch(/\.(test|spec)\./);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('finds exactly the import edges touching the changed artifacts that the independent extraction finds', () => {
    for (const run of runs.values()) {
      const paths = new Set(listSnapshotArtifacts(db, run.baseSnapshotId).map((a) => a.path));
      const changed = [...run.testCase.changedPaths].filter((path) => paths.has(path));
      const expected = new Set<string>();
      for (const importer of paths) {
        if (!parseDialectFor(importer)) continue;
        for (const imported of independentImports(db, run.baseSnapshotId, importer, paths)) {
          if (changed.includes(importer) || changed.includes(imported)) expected.add(`${importer}>${imported}`);
        }
      }

      const found = new Set<string>();
      for (const candidate of retrieveCandidates(db, run.baseSnapshotId, { text: '', changedPaths: changed })) {
        for (const { kind, changedPath } of candidate.structuralSignals) {
          found.add(kind === 'outgoing-import' ? `${changedPath}>${candidate.path}` : `${candidate.path}>${changedPath}`);
        }
      }
      expect([...found].sort(), run.testCase.id).toEqual([...expected].sort());
    }
  });

  it('reports the production-vs-research comparison', () => {
    const rows = [...runs.values()].map((run) => {
      const { testCase } = run;
      const target = label(testCase);
      const b1 = loadResearchStructural(testCase.id);
      const production = new Map<string, Set<ResearchStructuralKind>>();
      for (const candidate of run.candidates) {
        const kinds = new Set(candidate.structuralSignals.map((s) => s.kind));
        if (kinds.size > 0) production.set(candidate.path, kinds);
      }
      const edge = (side: Map<string, Set<ResearchStructuralKind>>) =>
        new Set([...side].flatMap(([path, kinds]) => [...kinds].map((kind) => `${path}|${kind}`)));
      const prodEdges = edge(production);
      const b1Edges = edge(b1);
      const targetCandidate = run.candidates.find((c) => c.path === target);

      return {
        case: testCase.id,
        polarity: testCase.positives.length > 0 ? 'positive' : testCase.negatives.length > 0 ? 'negative' : 'none',
        candidates: run.candidates.length,
        resB6Candidates: loadResearchB6CandidateCount(testCase.id),
        structuralCandidates: production.size,
        b1Structural: b1.size,
        structuralBoth: [...prodEdges].filter((e) => b1Edges.has(e)).length,
        structuralOnlyProd: [...prodEdges].filter((e) => !b1Edges.has(e)).length,
        structuralOnlyB1: [...b1Edges].filter((e) => !prodEdges.has(e)).length,
        keepsEveryB1Edge: [...b1Edges].every((e) => prodEdges.has(e)),
        lexicalRank: target ? (run.lexicalRanks.get(target) ?? -1) : '-',
        rank: target ? run.rankOf(target) : '-',
        resB6Rank: target ? loadResearchB6TruthRank(testCase.id) : '-',
        category: targetCandidate?.category ?? '-',
        signals: targetCandidate?.structuralSignals.map((s) => s.kind).join(',') ?? '-',
      };
    });
    console.table(rows);
    expect(rows).toHaveLength(9);
    expect(rows.filter((row) => !row.keepsEveryB1Edge).map((row) => row.case)).toEqual([]);
  });

  it('gains structural candidates only in the WollyWay cases whose imports use .js, and each new edge is a .js substitution', () => {
    const gained: Record<string, number> = {};
    for (const run of runs.values()) {
      const b1 = loadResearchStructural(run.testCase.id);
      const paths = new Set(listSnapshotArtifacts(db, run.baseSnapshotId).map((a) => a.path));
      let newEdges = 0;

      for (const candidate of run.candidates) {
        for (const { kind, changedPath } of candidate.structuralSignals) {
          if (b1.get(candidate.path)?.has(kind)) continue;
          newEdges += 1;
          const [importer, imported] = kind === 'outgoing-import' ? [changedPath, candidate.path] : [candidate.path, changedPath];
          expect(isJsSubstitutionEdge(db, run.baseSnapshotId, importer, imported, paths), `${run.testCase.id}: ${importer} -> ${imported}`).toBe(true);
        }
      }
      gained[run.testCase.id] = newEdges;
    }
    // Only the WollyWay cases whose changed files are imported with .js specifiers gain edges. TB-0007's
    // changed file is a .tsx component that nothing imports statically, so it gains none.
    // Counted as signals (a candidate related to both changed files has two): the new structural
    // candidates are 19, 34 and 11 artifacts.
    expect(Object.fromEntries(Object.entries(gained).filter(([, count]) => count > 0))).toEqual({
      'TB-0001': 21,
      'TB-0002': 34,
      'TB-0006': 13,
    });
  });
});

/**
 * True when `importer` has a relative `.js` specifier that names `imported` only through the
 * .js to .ts/.tsx substitution: the exact path does not exist, and the stem plus .ts or .tsx does.
 * Written without the production resolver.
 */
function isJsSubstitutionEdge(
  database: Database,
  snapshotId: number,
  importer: string,
  imported: string,
  snapshotPaths: ReadonlySet<string>,
): boolean {
  const artifact = listSnapshotArtifactsCache(database, snapshotId).get(importer);
  if (!artifact) return false;
  const text = readContent(database, artifact.contentSha256) ?? '';
  const directory = importer.includes('/') ? importer.slice(0, importer.lastIndexOf('/')) : '.';
  for (const match of text.matchAll(/(?:^|\n)[ \t]*import\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]*\.js)['"]/g)) {
    const joined = posix.join(directory, match[1]!);
    const stem = joined.slice(0, -'.js'.length);
    if (!snapshotPaths.has(joined) && (imported === `${stem}.ts` || imported === `${stem}.tsx`)) return true;
  }
  return false;
}

/**
 * Imports of one file by a deliberately simple regex over its text, resolved with the same B1
 * rules: a second opinion on the Babel-based extraction, not a copy of it.
 */
function independentImports(database: Database, snapshotId: number, path: string, snapshotPaths: ReadonlySet<string>): string[] {
  const artifact = listSnapshotArtifactsCache(database, snapshotId).get(path);
  if (!artifact) return [];
  const text = readContent(database, artifact.contentSha256) ?? '';
  const resolved: string[] = [];
  for (const match of text.matchAll(/(?:^|\n)[ \t]*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    const target = resolveRelativeImport(path, match[1]!, snapshotPaths);
    if (target !== undefined && target !== path) resolved.push(target);
  }
  return resolved;
}

const artifactCache = new Map<number, Map<string, { contentSha256: string }>>();
function listSnapshotArtifactsCache(database: Database, snapshotId: number): Map<string, { contentSha256: string }> {
  let cached = artifactCache.get(snapshotId);
  if (!cached) {
    cached = new Map(listSnapshotArtifacts(database, snapshotId).map((a) => [a.path, { contentSha256: a.contentSha256 }]));
    artifactCache.set(snapshotId, cached);
  }
  return cached;
}
