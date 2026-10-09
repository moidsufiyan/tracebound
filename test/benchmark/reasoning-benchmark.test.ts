import { beforeAll, describe, expect, it } from 'vitest';
import { indexSnapshotStructurally } from '../../src/analysis/structural-index.js';
import { openDatabase, type Database } from '../../src/db/database.js';
import { ingestSnapshot } from '../../src/ingestion/ingest-snapshot.js';
import { createProject, registerRepository, type Repository } from '../../src/projects/projects.js';
import { constructEvidence, type EvidenceBundle } from '../../src/retrieval/evidence.js';
import { searchHybridDetailed } from '../../src/retrieval/hybrid-search.js';
import { indexSnapshotLexically } from '../../src/retrieval/lexical-index.js';
import { assessImpact } from '../../src/reasoning/impact-reasoning.js';
import type { ImpactReport } from '../../src/reasoning/impact-report.js';
import { createOllamaReasoningProvider } from '../../src/reasoning/ollama-reasoning-provider.js';
import type { ReasoningProvider } from '../../src/reasoning/provider.js';
import { createOllamaEmbeddingProvider } from '../../src/semantic/ollama-provider.js';
import type { EmbeddingProvider } from '../../src/semantic/provider.js';
import { indexSnapshotSemantically } from '../../src/semantic/semantic-index.js';
import { loadCases, ollamaUrl, repositoryPath, resolveCommit, semanticBenchmarkAvailable, type BenchmarkCase } from './benchmark.js';

// An optional run of impact reasoning with a real local model over the Phase 1 cases. It needs the
// semantic benchmark's configuration (a running Ollama with the embedding model, both repositories)
// and a reasoning model, named by TRACEBOUND_REASONING_MODEL together with its input budget in
// characters, TRACEBOUND_REASONING_MAX_INPUT_CHARS. Optional: TRACEBOUND_REASONING_CONTEXT_TOKENS
// (num_ctx), TRACEBOUND_REASONING_CANDIDATES (candidates per case, default 5),
// TRACEBOUND_REASONING_CASES (comma-separated case ids, default all) and
// TRACEBOUND_REASONING_TIMEOUT_MS. Without them the tests are skipped.
//
// What it can and cannot show. It reports (1) whether the model's answers are valid against the
// schema and the evidence they cite, and (2) which classifications it produced. It does not report
// accuracy: the repository's labels are retrieval relevance labels, not impact classifications, so
// there is no ground truth to score against (3), and the claims worth a person's review are listed
// (4) rather than judged. The one structural expectation is about TB-0009 and is stated below.

const MODEL = process.env['TRACEBOUND_REASONING_MODEL'];
const MAX_INPUT_CHARS = Number(process.env['TRACEBOUND_REASONING_MAX_INPUT_CHARS']);
const optionalNumber = (name: string) => (process.env[name] ? Number(process.env[name]) : undefined);
const CANDIDATES = optionalNumber('TRACEBOUND_REASONING_CANDIDATES') ?? 5;
const SELECTED_CASES = process.env['TRACEBOUND_REASONING_CASES']?.split(',').map((id) => id.trim());

const configured = semanticBenchmarkAvailable() && Boolean(MODEL) && Number.isInteger(MAX_INPUT_CHARS) && MAX_INPUT_CHARS > 0;

interface CaseRun {
  testCase: BenchmarkCase;
  bundle: EvidenceBundle;
  report: ImpactReport | undefined;
  failure: string | undefined;
}

const runs = new Map<string, CaseRun>();
let db: Database;
let embedder: EmbeddingProvider;
let reasoner: ReasoningProvider;

function getOrCreateProject(name: string): number {
  const row = db.prepare('SELECT id FROM project WHERE name = ?').get(name) as { id: number } | undefined;
  return row?.id ?? createProject(db, name).id;
}

async function getOrRegisterRepository(projectId: number, name: string, sourcePath: string): Promise<Repository> {
  const row = db.prepare('SELECT id FROM repository WHERE project_id = ? AND name = ?').get(projectId, name) as { id: number } | undefined;
  if (row) return { id: row.id, projectId, name, sourcePath, createdAt: '' };
  return registerRepository(db, { projectId, name, sourcePath });
}

describe.skipIf(!configured)('impact reasoning with a real model on the Phase 1 benchmark', () => {
  beforeAll(async () => {
    db = openDatabase(process.env['TRACEBOUND_BENCHMARK_DB'] ?? ':memory:');
    embedder = await createOllamaEmbeddingProvider({ endpoint: ollamaUrl()! });
    const contextTokens = optionalNumber('TRACEBOUND_REASONING_CONTEXT_TOKENS');
    const timeoutMs = optionalNumber('TRACEBOUND_REASONING_TIMEOUT_MS');
    reasoner = await createOllamaReasoningProvider({
      model: MODEL!,
      maxInputChars: MAX_INPUT_CHARS,
      endpoint: ollamaUrl()!,
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    console.log(`reasoning model: ${reasoner.modelId}, input budget ${reasoner.maxInputChars} characters, ${CANDIDATES} candidates per case`);

    const projectId = getOrCreateProject('benchmark');
    const repositories = new Map<string, Repository>();
    for (const testCase of loadCases()) {
      if (SELECTED_CASES && !SELECTED_CASES.includes(testCase.id)) continue;
      const sourcePath = repositoryPath(testCase.repositoryName)!;
      let repository = repositories.get(testCase.repositoryName);
      if (!repository) {
        repository = await getOrRegisterRepository(projectId, testCase.repositoryName, sourcePath);
        repositories.set(testCase.repositoryName, repository);
      }
      const { snapshot } = await ingestSnapshot(db, repository.id, resolveCommit(sourcePath, testCase.baseCommit));
      indexSnapshotLexically(db, snapshot.id);
      indexSnapshotStructurally(db, snapshot.id);
      await indexSnapshotSemantically(db, snapshot.id, embedder);

      const result = await searchHybridDetailed(db, snapshot.id, embedder, {
        description: testCase.description,
        changedPaths: [...testCase.changedPaths],
        ...(testCase.query.symbols ? { symbols: testCase.query.symbols } : {}),
      });
      const bundle = constructEvidence(db, snapshot.id, embedder, result, { limit: CANDIDATES });

      const started = Date.now();
      let report: ImpactReport | undefined;
      let failure: string | undefined;
      try {
        report = await assessImpact(db, snapshot.id, reasoner, { description: testCase.description, bundle });
      } catch (error) {
        failure = `${(error as Error).name}: ${(error as Error).message}`;
      }
      console.log(`${testCase.id}: ${report ? 'valid report' : `FAILED ${failure}`} in ${Math.round((Date.now() - started) / 1000)}s`);
      runs.set(testCase.id, { testCase, bundle, report, failure });
    }
  }, 14_400_000);

  it('reports how many answers were valid against the schema and the evidence they cite', () => {
    const valid = [...runs.values()].filter((run) => run.report).length;
    console.log(`schema and reference validity: ${valid} of ${runs.size} cases produced a valid report`);
    for (const run of runs.values()) if (run.failure) console.log(`  ${run.testCase.id}: ${run.failure}`);
    expect(runs.size).toBeGreaterThan(0);
  });

  it('reports the classifications the model produced (not their accuracy)', () => {
    const tally: Record<string, number> = {};
    for (const run of runs.values()) for (const a of run.report?.assessments ?? []) tally[a.classification] = (tally[a.classification] ?? 0) + 1;
    console.log('model-produced classifications:', JSON.stringify(tally));
    for (const run of runs.values()) {
      for (const a of run.report?.assessments ?? []) {
        console.log(`  ${run.testCase.id} ${a.classification.padEnd(21)} ${a.path}`);
      }
    }
    expect(Object.values(tally).every((n) => n > 0)).toBe(true);
  });

  it('lists the strongest claims for human review; the repository has no impact labels to score them against', () => {
    const needsReview: string[] = [];
    for (const run of runs.values()) {
      for (const a of run.report?.assessments ?? []) {
        if (a.classification !== 'likely_affected' && a.classification !== 'no_impact_indicated') continue;
        const candidate = run.bundle.candidates.find((c) => c.versionId === a.versionId)!;
        const cited = new Set(a.findings.flatMap((f) => f.evidenceIds));
        const types = new Set(candidate.evidence.filter((e) => cited.has(e.id)).map((e) => e.type));
        needsReview.push(`${run.testCase.id} ${a.classification} ${a.path} (cites ${[...types].join('+')})`);
      }
    }
    console.log(`claims needing human review (no ground truth): ${needsReview.length}`);
    for (const line of needsReview) console.log(`  ${line}`);
    console.log('human-reviewed accuracy: not available; impact-level annotations do not exist for these cases');
    expect(Array.isArray(needsReview)).toBe(true);
  });

  it.skipIf(SELECTED_CASES !== undefined && !SELECTED_CASES.includes('TB-0009'))(
    'does not rest a likely_affected assessment of the TB-0009 negative on the retrieval consensus alone',
    () => {
      const run = runs.get('TB-0009');
      if (!run?.report) {
        console.log('TB-0009: no valid report to check');
        return;
      }
      const negative = run.report.assessments.find((a) => a.path === run.testCase.negatives[0]);
      if (!negative) {
        console.log('TB-0009: the negative was not among the candidates described');
        return;
      }
      console.log(`TB-0009 negative ${negative.path}: ${negative.classification}`);
      for (const finding of negative.findings) console.log(`  - ${finding.statement} [${finding.evidenceIds.join(', ')}]`);
      if (negative.classification === 'likely_affected') {
        const candidate = run.bundle.candidates.find((c) => c.versionId === negative.versionId)!;
        const cited = new Set(negative.findings.flatMap((f) => f.evidenceIds));
        const citedTypes = candidate.evidence.filter((e) => cited.has(e.id)).map((e) => e.type);
        // Rank and score agreement (fusion evidence) alone must not carry a likely_affected claim.
        expect(citedTypes.some((type) => type !== 'fusion')).toBe(true);
      }
    },
  );
});
