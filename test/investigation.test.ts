import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexSnapshotStructurally } from '../src/analysis/structural-index.js';
import { runInvestigateCli } from '../src/cli/investigate.js';
import { openDatabase, type Database } from '../src/db/database.js';
import { ingestSnapshot } from '../src/ingestion/ingest-snapshot.js';
import { investigateChange, type InvestigationReport } from '../src/investigation/investigate.js';
import { renderInvestigationMarkdown } from '../src/investigation/render.js';
import { createProject, registerRepository, type Repository } from '../src/projects/projects.js';
import { ReasoningProviderError } from '../src/reasoning/provider.js';
import { constructEvidence } from '../src/retrieval/evidence.js';
import { searchHybridDetailed, type HybridQuery } from '../src/retrieval/hybrid-search.js';
import { indexSnapshotLexically } from '../src/retrieval/lexical-index.js';
import { indexSnapshotSemantically, SemanticIndexNotBuiltError } from '../src/semantic/semantic-index.js';
import { FakeEmbeddingProvider } from './fake-embedding-provider.js';
import { FakeReasoningProvider, wellFormedAnswer } from './fake-reasoning-provider.js';
import { FixtureRepo } from './git-fixture.js';

// End-to-end investigation of a change: retrieval, evidence and (optionally) the validated
// assessment, rendered as a report that stays useful when the assessment abstains or fails.

const VOCABULARY = ['billing', 'ledger', 'refund', 'invoice', 'money'];
const FILES: Record<string, string> = {
  'src/billing.ts': `import { post } from './ledger';\nimport type { Money } from "./money";\nexport const billing = post;\n`,
  'src/ledger.ts': `export const post = 1;\n`,
  'src/money.ts': `export type Money = number;\n`,
  'src/invoice.ts': `import {\n  billing,\n} from './billing';\nexport const invoice = billing;\n`,
  'src/billing.test.ts': `import { billing } from './billing.js';\nexport const check = billing;\n`,
  'docs/refunds.md': `A refund is posted to the billing ledger.\n`,
  'docs/other.md': `Nothing to do with it.\n`,
  'package-lock.json': `{"lockfileVersion": 3}\n`,
};
const CHANGE: HybridQuery = { description: 'fix refund billing', changedPaths: ['src/billing.ts'] };

let db: Database;
let fixture: FixtureRepo;
let repository: Repository;
let embedder: FakeEmbeddingProvider;
let snapshotId: number;
let sha: string;

beforeEach(async () => {
  db = openDatabase(':memory:');
  fixture = new FixtureRepo();
  repository = await registerRepository(db, { projectId: createProject(db, 'p').id, name: 'r', sourcePath: fixture.path });
  embedder = new FakeEmbeddingProvider(VOCABULARY);
  sha = fixture.commit(FILES);
  snapshotId = (await ingestSnapshot(db, repository.id, sha)).snapshot.id;
  indexSnapshotLexically(db, snapshotId);
  indexSnapshotStructurally(db, snapshotId);
  await indexSnapshotSemantically(db, snapshotId, embedder);
});

afterEach(() => {
  db.close();
  fixture.remove();
});

const byPath = (report: InvestigationReport, path: string) => report.candidates.find((c) => c.path === path)!;

describe('investigateChange without an impact assessment', () => {
  it('reports the candidates with exactly the evidence the production pipeline built for them', async () => {
    const report = await investigateChange(db, snapshotId, embedder, CHANGE);

    // Same run, same evidence: compare with the pipeline called directly.
    const bundle = constructEvidence(db, snapshotId, embedder, await searchHybridDetailed(db, snapshotId, embedder, CHANGE));
    expect(report.candidates.map((c) => [c.rank, c.artifactId, c.versionId, c.path])).toEqual(bundle.candidates.map((c) => [c.rank, c.artifactId, c.versionId, c.path]));
    report.candidates.forEach((c, i) => expect(c.evidence).toEqual(bundle.candidates[i]!.evidence));
    // Each summary line describes the evidence item with the same id, in order.
    for (const c of report.candidates) expect(c.summary.map((l) => l.id)).toEqual(c.evidence.map((e) => e.id));

    expect(report.snapshot).toMatchObject({ id: snapshotId, commitSha: sha });
    expect(report.reasoning).toEqual({ status: 'not_requested' });
    expect(report.candidates.every((c) => c.assessment === null)).toBe(true);
    expect(report.candidates.some((c) => c.path === 'src/billing.ts')).toBe(false);
    expect(report.changedFiles).toEqual([expect.objectContaining({ path: 'src/billing.ts', inSnapshot: true, excludedBecause: null })]);
    expect(report.changedFiles[0]!.fusedRank).toBeGreaterThan(0);
  });

  it('says what each relationship is and what it cannot show', async () => {
    const report = await investigateChange(db, snapshotId, embedder, CHANGE);

    const invoice = byPath(report, 'src/invoice.ts');
    expect(invoice.summary.find((l) => l.type === 'structural')!.text).toMatch(/this file imports the changed file src\/billing\.ts; src\/invoice\.ts:1-3 \("\.\/billing"\)/);
    expect(invoice.limitations).toContain('An import is a file-level relationship: it does not show which symbols are used or whether the changed behavior is reached.');
    expect(invoice.openQuestions[0]).toMatch(/use the behavior the change modifies/);

    const ledger = byPath(report, 'src/ledger.ts');
    expect(ledger.summary.find((l) => l.type === 'structural')!.text).toMatch(/is imported by the changed file/);
    expect(ledger.limitations).toContain('Only the changed file imports this file: it is a dependency of the changed code, not a dependent of it.');

    const refunds = byPath(report, 'docs/refunds.md');
    expect(refunds.limitations).toContain('No import relationship with a changed file: surfaced by matched terms and similarity only.');
    // Distinct-term counts overlap (a term can match in content and path), so they are not presented as a sum.
    expect(refunds.summary.find((l) => l.type === 'lexical')!.text).toMatch(/^Matched \d+ distinct query terms?: .* \(\d+ found in the content, \d+ in the path; a term can be in both\)\.$/);

    expect(report.limitations[0]).toMatch(/None of them shows that the change affects it/);
    expect(report.limitations).toContain('No impact assessment was requested: candidates are described by their evidence only.');
  });

  it('renders a report that keeps every evidence id and never presents signals as proof', async () => {
    const report = await investigateChange(db, snapshotId, embedder, CHANGE);
    const md = renderInvestigationMarkdown(report);
    for (const c of report.candidates) for (const e of c.evidence) expect(md).toContain(`\`${e.id}\``);
    expect(md).toMatch(/it does not show that the change affects the file/);
    expect(md).toMatch(/is not a finding that the file is unaffected/);
    expect(md).toMatch(/## Impact assessment\n\nNot requested/);
    expect(md).not.toMatch(/likely_affected|no_impact_indicated/);
  });

  it('is deterministic', async () => {
    expect(await investigateChange(db, snapshotId, embedder, CHANGE)).toEqual(await investigateChange(db, snapshotId, embedder, CHANGE));
  });
});

describe('incomplete or missing evidence', () => {
  it('reports a changed path that is not in the snapshot, and one the file policy excluded', async () => {
    const report = await investigateChange(db, snapshotId, embedder, { description: 'fix refund billing', changedPaths: ['src/billing.ts', 'src/removed.ts', 'package-lock.json'] });
    expect(report.changedFiles.map((f) => [f.path, f.inSnapshot, f.excludedBecause])).toEqual([
      ['src/billing.ts', true, null],
      ['src/removed.ts', false, null],
      ['package-lock.json', false, 'generated'],
    ]);
    expect(report.limitations.some((l) => l.includes('src/removed.ts is not in snapshot'))).toBe(true);
    expect(report.limitations.some((l) => l.includes('package-lock.json') && l.includes('excluded by the file policy: generated'))).toBe(true);
    expect(renderInvestigationMarkdown(report)).toMatch(/\| `src\/removed\.ts` \| \*\*no\*\* \|/);
  });

  it('says how many ranked files were not described when the limit cuts the list', async () => {
    const full = await investigateChange(db, snapshotId, embedder, CHANGE);
    const short = await investigateChange(db, snapshotId, embedder, CHANGE, { limit: 2 });
    expect(short.candidates).toHaveLength(2);
    expect(short.retrieval.notDescribed).toBe(full.candidates.length - 2);
    expect(short.limitations).toContain(`${full.candidates.length - 2} further ranked files are not described (limit 2).`);
  });

  it('fails with the typed error when an index is missing, instead of reporting partial evidence', async () => {
    const other = new FakeEmbeddingProvider(VOCABULARY, { modelId: 'fake:other-model' });
    await expect(investigateChange(db, snapshotId, other, CHANGE)).rejects.toThrow(SemanticIndexNotBuiltError);
  });

  it('rejects an empty change description', async () => {
    await expect(investigateChange(db, snapshotId, embedder, { description: '  ', changedPaths: [] })).rejects.toThrow(RangeError);
  });
});

describe('with the impact assessment', () => {
  it('shows an abstention as insufficient evidence, not as non-impact', async () => {
    const reasoner = new FakeReasoningProvider({ respond: (request) => wellFormedAnswerWith(request.input, 'insufficient_evidence', false) });
    const report = await investigateChange(db, snapshotId, embedder, CHANGE, { reasoning: reasoner });

    expect(report.reasoning).toMatchObject({ status: 'accepted', modelId: 'fake:reasoner', instructionsVersion: '1.3.0' });
    expect(report.candidates.every((c) => c.assessment?.classification === 'insufficient_evidence' && c.assessment.findings.length === 0)).toBe(true);
    expect(report.candidates[0]!.assessment!.meaning).toMatch(/not a finding that the file is unaffected/);
    // The evidence is the same with or without the assessment.
    const plain = await investigateChange(db, snapshotId, embedder, CHANGE);
    expect(report.candidates.map((c) => c.evidence)).toEqual(plain.candidates.map((c) => c.evidence));
    expect(renderInvestigationMarkdown(report)).toMatch(/Assessment: \*\*insufficient_evidence\*\*\. The model did not find the evidence sufficient/);
  });

  it('includes accepted classifications with the findings and the ids they cite', async () => {
    const reasoner = new FakeReasoningProvider();
    const report = await investigateChange(db, snapshotId, embedder, CHANGE, { reasoning: reasoner });
    const first = report.candidates[0]!;
    expect(first.assessment).toMatchObject({ classification: 'potentially_affected' });
    expect(first.assessment!.findings[0]!.evidenceIds).toEqual([first.evidence[0]!.id]);
  });

  it('shows no classification when the validator rejects the answer, and keeps the evidence', async () => {
    const reasoner = new FakeReasoningProvider({ respond: (request) => wellFormedAnswer(request.input, 'no_impact_indicated') });
    const report = await investigateChange(db, snapshotId, embedder, CHANGE, { reasoning: reasoner });
    expect(report.reasoning).toMatchObject({ status: 'rejected' });
    expect(report.reasoning.status === 'rejected' && report.reasoning.error).toMatch(/InvalidReasoningOutputError: .*no_impact_indicated/);
    expect(report.candidates.length).toBeGreaterThan(0);
    expect(report.candidates.every((c) => c.assessment === null)).toBe(true);
    expect(renderInvestigationMarkdown(report)).toMatch(/\*\*Rejected by the validator\*\*/);
  });

  it('shows no classification when the provider fails, and keeps the evidence', async () => {
    const reasoner = new FakeReasoningProvider({
      respond: () => {
        throw new ReasoningProviderError('Cannot reach Ollama');
      },
    });
    const report = await investigateChange(db, snapshotId, embedder, CHANGE, { reasoning: reasoner });
    expect(report.reasoning).toMatchObject({ status: 'failed', error: 'ReasoningProviderError: Cannot reach Ollama' });
    expect(report.candidates.every((c) => c.assessment === null)).toBe(true);
  });
});

describe('tracebound-investigate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tracebound-cli-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { createEmbedder: async () => new FakeEmbeddingProvider(VOCABULARY), stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) } };
  };

  it('ingests and indexes a commit, then prints the report; a second run reuses the snapshot', async () => {
    const dbFile = join(dir, 'tb.sqlite');
    const first = capture();
    const code = await runInvestigateCli(['--db', dbFile, '--repo', fixture.path, '--commit', sha, '--description', 'fix refund billing', '--changed', 'src/billing.ts'], first.deps);
    expect(code).toBe(0);
    expect(first.err.join('')).toMatch(/Registered repository[\s\S]*Ingested snapshot 1 of [0-9a-f]{40}[\s\S]*Built the lexical index[\s\S]*Built the structural index[\s\S]*Building the semantic index/);
    const md = first.out.join('');
    expect(md).toMatch(/^# Change investigation/);
    expect(md).toContain('`src/invoice.ts`');

    const second = capture();
    const out = join(dir, 'report.json');
    expect(await runInvestigateCli(['--db', dbFile, '--snapshot', '1', '--description', 'fix refund billing', '--changed', 'src/billing.ts', '--format', 'json', '--out', out], second.deps)).toBe(0);
    expect(second.err.join('')).not.toMatch(/Built|Building/);
    const report = JSON.parse(readFileSync(out, 'utf8')) as InvestigationReport;
    expect(report.snapshot).toMatchObject({ id: 1, commitSha: sha });
    expect(report.reasoning).toEqual({ status: 'not_requested' });
  });

  it('runs the assessment only when a reasoning model is named, and reports a rejection without failing', async () => {
    const dbFile = join(dir, 'tb.sqlite');
    const run = capture();
    const reasoner = new FakeReasoningProvider({ respond: (request) => wellFormedAnswer(request.input, 'no_impact_indicated') });
    const code = await runInvestigateCli(
      ['--db', dbFile, '--repo', fixture.path, '--commit', sha, '--description', 'fix refund billing', '--changed', 'src/billing.ts', '--reasoning-model', 'fake', '--reasoning-max-input-chars', '100000'],
      { ...run.deps, createReasoner: async () => reasoner },
    );
    expect(code).toBe(0);
    expect(reasoner.requests.length).toBeGreaterThan(0);
    expect(run.out.join('')).toMatch(/Rejected by the validator/);
    expect(run.err.join('')).toMatch(/Impact assessment rejected/);
  });

  it('refuses invalid usage and reports errors explicitly', async () => {
    const usage = capture();
    expect(await runInvestigateCli(['--db', join(dir, 'x.sqlite'), '--snapshot', '1'], usage.deps)).toBe(2);
    expect(usage.err.join('')).toMatch(/--description is required/);
    expect(await runInvestigateCli(['--db', join(dir, 'x.sqlite'), '--snapshot', '1', '--repo', '.', '--commit', sha, '--description', 'x'], usage.deps)).toBe(2);
    expect(await runInvestigateCli(['--db', join(dir, 'x.sqlite'), '--snapshot', '1', '--description', 'x', '--reasoning-model', 'm'], usage.deps)).toBe(2);

    const missing = capture();
    expect(await runInvestigateCli(['--db', join(dir, 'x.sqlite'), '--snapshot', '99', '--description', 'x'], missing.deps)).toBe(1);
    expect(missing.err.join('')).toMatch(/error: NotFoundError: .*99/);
    expect(missing.out).toEqual([]);

    const badCommit = capture();
    expect(await runInvestigateCli(['--db', join(dir, 'y.sqlite'), '--repo', fixture.path, '--commit', 'HEAD', '--description', 'x'], badCommit.deps)).toBe(1);
    expect(badCommit.err.join('')).toMatch(/error: InvalidCommitShaError/);
  });
});

function wellFormedAnswerWith(input: Parameters<typeof wellFormedAnswer>[0], classification: string, withFindings: boolean): unknown {
  const answer = wellFormedAnswer(input, classification) as { assessments: { findings: unknown[] }[] };
  if (!withFindings) for (const a of answer.assessments) a.findings = [];
  return answer;
}
