import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from '../src/evaluation/m9/canonical.js';
import { assembleResults, type AssemblyResult, type CochangeResults } from '../src/evaluation/cochange/assemble.js';
import { MAIN_SEED, mulberry32, SENSITIVITY_SEED } from '../src/evaluation/cochange/bootstrap.js';
import { decide } from '../src/evaluation/cochange/decision.js';
import { createJournal, type EvaluationHeader, type EvaluationRecord, type PreparationHeader, type PreparationRecord } from '../src/evaluation/cochange/journal.js';
import { LOCK_FILE } from '../src/evaluation/cochange/lock.js';
import { drawStrataSamples, METRIC_SCALE, summarize } from '../src/evaluation/cochange/metrics.js';
import { WORK_FILES, type Registration } from '../src/evaluation/cochange/preflight.js';
import { DESIGN_CASE_COMMITS, PROTOCOL, SELECTION_RULES, type CochangeManifest } from '../src/evaluation/cochange/selector.js';

// Each test assembles 30 synthetic commits with several 10,000-replicate bootstraps; the 5 s default is too tight when the suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

const L = METRIC_SCALE;
const N = 30;
const hex = (prefix: string, i: number) => `${prefix}${i.toString(16).padStart(39, '0')}`;
const commitSha = (i: number) => hex('a', i);
const baseSha = (i: number) => hex('b', i);
const HEAD = hex('c', 0);

/** Commit i: input src/m{i}.ts; targets test/m{i}.test.ts always, docs/m{i}.md when i % 3 = 0, test/n{i}.test.ts when i % 5 = 0. */
function targetsOf(i: number) {
  return [
    ...(i % 3 === 0 ? [{ path: `docs/m${i}.md`, kind: 'doc' as const, status: 'modified' as const }] : []),
    { path: `test/m${i}.test.ts`, kind: 'test' as const, status: 'modified' as const },
    ...(i % 5 === 0 ? [{ path: `test/n${i}.test.ts`, kind: 'test' as const, status: 'modified' as const }] : []),
  ];
}
/** Test targets linked to the input: test/m{i} when i is even (test/n{i} never). */
const linkedOf = (i: number) => (i % 2 === 0 ? [`test/m${i}.test.ts`] : []);

function manifestValue(): CochangeManifest {
  return {
    schema: 'tracebound.cochange.manifest',
    schemaVersion: '1.0.0',
    protocol: PROTOCOL,
    repository: { name: 'owner/repo', head: HEAD, since: null },
    rules: SELECTION_RULES,
    exclusions: { designCaseCommits: [...DESIGN_CASE_COMMITS].sort() },
    counts: { reachable: 32, eligible: N, selected: N, rejected: { root: 1, merge: 0, design_case: 0, too_many_changes: 0, no_changes: 0, no_source_input: 1, no_target: 0 } },
    commits: Array.from({ length: N }, (_, i) => {
      const targets = targetsOf(i);
      const changes = [
        ...targets.map((t) => ({ status: 'modified' as const, path: t.path, previousPath: null, similarity: null, basePath: t.path, baseClass: t.kind })),
        { status: 'modified' as const, path: `src/m${i}.ts`, previousPath: null, similarity: null, basePath: `src/m${i}.ts`, baseClass: 'source' as const },
      ].sort((a, b) => (a.path < b.path ? -1 : 1));
      return { sha: commitSha(i), base: baseSha(i), subject: `change ${i}`, eligibleIndex: i, changes, inputs: [`src/m${i}.ts`], targets };
    }),
  };
}

type Method = 'hybrid' | 'deterministic' | 'semantic' | 'sibling' | 'no-description';
const KEYS: Record<Method, string> = { hybrid: 'hybridPaths', deterministic: 'deterministicPaths', semantic: 'semanticPaths', sibling: 'siblingPaths', 'no-description': 'noDescriptionPaths' };
/** Where each method ranks commit i's k-th target (1-based), or null for not ranked at all. */
type Placement = (method: Method, i: number, k: number) => number | null;

/** Hybrid finds everything first; deterministic at 4, 5, ...; semantic at 3 (odd commits) or 12 (even); sibling never in the top 20; the arm at 6, 7, .... */
const STRONG_HYBRID: Placement = (method, i, k) =>
  method === 'hybrid' ? k : method === 'deterministic' ? 3 + k : method === 'semantic' ? (i % 2 === 1 ? 2 + k : 11 + k) : method === 'sibling' ? 20 + k : 5 + k;
/** As STRONG_HYBRID, but semantic and the arm rank at positions that vary by commit, so their MRR@20 values are many and distinct. */
const VARIED: Placement = (method, i, k) => (method === 'semantic' ? (i % 19) + 1 + k : method === 'no-description' ? (i % 17) + 2 + k : STRONG_HYBRID(method, i, k));
const STRONG_SIBLING: Placement = (method, _i, k) => (method === 'sibling' ? k : method === 'hybrid' ? 20 + k : method === 'no-description' ? 5 + k : 3 + k);

function rankingOf(i: number, place: Placement, method: Method): string[] {
  const list = Array.from({ length: 30 }, (_, n) => `filler/f${n}.ts`);
  const targets = method === 'sibling' ? targetsOf(i).filter((t) => t.kind === 'test') : targetsOf(i);
  targets.forEach((t, k) => {
    const rank = place(method, i, k + 1);
    if (rank !== null) list.splice(rank - 1, 0, t.path);
  });
  return list;
}

interface Scenario {
  place?: Placement;
  /** Commits (index) where these methods failed, at this stage. */
  failures?: { i: number; methods: Method[]; stage: 'retrieval' | 'analysis' | 'preparation' }[];
  /** Commits (index) whose base failed preparation (no snapshot). */
  unprepared?: number[];
}

function evaluationRecord(i: number, scenario: Scenario): EvaluationRecord {
  const place = scenario.place ?? STRONG_HYBRID;
  const unprepared = scenario.unprepared?.includes(i) ?? false;
  const failed = new Map<Method, string>();
  for (const f of scenario.failures ?? []) if (f.i === i) for (const m of f.methods) failed.set(m, f.stage);
  if (unprepared) for (const m of ['hybrid', 'deterministic', 'semantic', 'sibling', 'no-description'] as Method[]) failed.set(m, 'preparation');
  const order: Method[] = ['hybrid', 'deterministic', 'semantic', 'sibling', 'no-description'];
  const rankings = Object.fromEntries(order.filter((m) => !failed.has(m)).map((m) => [KEYS[m], rankingOf(i, place, m)]));
  return {
    kind: 'record',
    phase: 'evaluation',
    commit: commitSha(i),
    status: failed.size === 0 ? 'succeeded' : 'failed',
    failures: order.filter((m) => failed.has(m)).map((m) => ({ method: m, stage: failed.get(m) as 'retrieval', errorName: 'Error', message: `C:\\machine\\path broke ${m}` })),
    evidence: {
      base: baseSha(i),
      snapshotId: unprepared ? null : i + 1,
      preparation: unprepared ? { status: 'failed', stage: 'ingestion' } : { status: 'succeeded' },
      query: { description: `change ${i}`, inputPaths: [`src/m${i}.ts`] },
      targets: targetsOf(i).map(({ path, kind }) => ({ path, kind })),
      ...(unprepared ? {} : { missingTargets: i === 4 ? [{ path: `test/m4.test.ts`, reason: 'binary' }] : [], linkedTargetPaths: linkedOf(i) }),
      rankings,
    },
  };
}

let dir: string;
let work: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracebound-assemble-test-'));
  work = join(dir, 'work');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Built {
  manifestPath: string;
  registration: Registration;
  header: EvaluationHeader;
}

/** Writes a manifest, a complete preparation journal, a frozen database file and an evaluation journal for `scenario`. */
function build(scenario: Scenario = {}, options: { records?: number; preparationHeader?: Partial<PreparationHeader> } = {}): Built {
  const manifest = manifestValue();
  const bytes = Buffer.from(canonicalJson(manifest), 'utf8');
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, bytes);
  const registration: Registration = { manifestSha256: sha256Hex(bytes), repositoryName: 'owner/repo', head: HEAD, since: null, embeddingModel: 'nomic-embed-text:v1.5' };
  mkdirSync(work);
  writeFileSync(join(work, WORK_FILES.frozenDatabase), 'frozen database bytes');
  const common = {
    kind: 'header' as const,
    schema: 'tracebound.cochange.journal' as const,
    schemaVersion: '1.0.0' as const,
    protocolVersion: '1.0.0',
    manifestSha256: registration.manifestSha256,
    repository: { name: 'owner/repo', head: HEAD },
    tracebound: { commit: 'e'.repeat(40), sourceClean: true, buildSha256: 'b'.repeat(64) },
    nodeVersion: 'v24.20.0',
    embeddingModelId: 'ollama:nomic-embed-text:v1.5@0a109f422b47',
  };
  const header: EvaluationHeader = { ...common, phase: 'evaluation', frozenDatabaseSha256: sha256Hex('frozen database bytes') };
  const preparation = createJournal(join(work, WORK_FILES.preparationJournal), {
    header: { ...common, phase: 'preparation', ...options.preparationHeader } as PreparationHeader,
    keys: manifest.commits.map((c) => c.base),
  });
  manifest.commits.forEach((c, i) => {
    const unprepared = scenario.unprepared?.includes(i) ?? false;
    const record: PreparationRecord = unprepared
      ? { kind: 'record', phase: 'preparation', base: c.base, status: 'failed', failures: [{ stage: 'ingestion', errorName: 'Error', message: 'tree unreadable' }], evidence: { snapshotId: null } }
      : { kind: 'record', phase: 'preparation', base: c.base, status: 'succeeded', failures: [], evidence: { snapshotId: i + 1 } };
    preparation.append(record);
  });
  const evaluation = createJournal(join(work, WORK_FILES.evaluationJournal), { header, keys: manifest.commits.map((c) => c.sha) });
  for (let i = 0; i < (options.records ?? N); i += 1) evaluation.append(evaluationRecord(i, scenario));
  return { manifestPath, registration, header };
}

const assemble = (built: Built, registration: Registration = built.registration) => assembleResults({ workDirectory: work, manifestPath: built.manifestPath }, { registration });

function assembled(result: AssemblyResult) {
  if (result.status !== 'assembled') throw new Error(JSON.stringify(result));
  return result;
}

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(root, full)] = sha256Hex(readFileSync(full));
    }
  };
  walk(root);
  return out;
}

const strata = (r: CochangeResults) => {
  if (!r.primary.estimated) throw new Error('no primary estimates');
  return r.primary.strata;
};
const available = <T extends { available: boolean }>(s: T) => {
  if (!s.available) throw new Error('unavailable stratum');
  return s as Extract<T, { available: true }>;
};

describe('a complete evaluation', () => {
  it('computes every metric per case and per stratum with the registered populations and denominators', async () => {
    const built = build();
    const r = assembled(await assemble(built)).results;
    expect(r.status).toBe('complete');
    expect(r.run).toMatchObject({ commits: 30, primaryTestPopulation: 30, primaryIncompleteCommits: [] });

    // Case level: commit 0 has docs/m0.md, test/m0.test.ts (linked) and test/n0.test.ts.
    const c0 = r.cases[0]!;
    expect(c0.targets).toEqual([
      { path: 'docs/m0.md', kind: 'doc', linked: null, missingReason: null },
      { path: 'test/m0.test.ts', kind: 'test', linked: true, missingReason: null },
      { path: 'test/n0.test.ts', kind: 'test', linked: false, missingReason: null },
    ]);
    expect(c0.strata).toEqual({ test: true, doc: true, 'test-with-link': true, 'test-without-link': true });
    expect(c0.methods.semantic.targetRanks).toEqual({ 'docs/m0.md': 12, 'test/m0.test.ts': 13, 'test/n0.test.ts': 14 });
    expect(c0.methods.semantic.metrics!.test).toMatchObject({ targetCount: 2, firstRank: 13, scaled: { recall3: 0, recall10: 0, recall20: L, mrr20: L / 13 } });
    expect(c0.methods.deterministic.metrics!.test).toMatchObject({ targetCount: 2, scaled: { recall3: 0, recall5: L / 2, recall10: L, mrr20: L / 5 } });
    expect(c0.methods.sibling.metrics!.test).toMatchObject({ scaled: { recall20: 0, mrr20: 0 }, firstRank: 21 });
    expect(r.cases[1]!.methods.hybrid.metrics!.doc).toBeNull();
    expect(r.cases[4]!.targets[0]).toEqual({ path: 'test/m4.test.ts', kind: 'test', linked: true, missingReason: 'binary' });

    // Populations: test 30; doc i % 3 = 0 (10); with link: even i (15); without link: odd i plus i in {0, 10, 20} (18).
    const s = strata(r);
    expect([s.test, s.doc, s['test-with-link'], s['test-without-link']].map((x) => x.populationSize)).toEqual([30, 10, 15, 18]);
    expect(available(s.doc).commits).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27].map(commitSha));

    // Macro values, exact: hybrid finds everything at the top; semantic within 10 only on odd commits.
    const test = available(s.test);
    expect(test.methods.hybrid!.recall10.point).toEqual({ sum: 30 * L, populationSize: 30, scale: L });
    expect(test.methods.hybrid!.recall10.interval).toEqual({ lower: 30 * L, upper: 30 * L });
    expect(test.methods.semantic!.recall10.point.sum).toBe(15 * L);
    expect(test.methods.semantic!.recall10.rate).toBe(0.5);
    expect(test.differences.sibling!.recall10.point).toEqual({ sum: 30 * L, populationSize: 30, scale: L });
    // MRR@20 of semantic: odd commits first rank 3 or 4 (with a doc target first); even commits 12 or 13.
    const semanticMrr = Array.from({ length: 30 }, (_, i) => L / (i % 2 === 1 ? (i % 3 === 0 ? 4 : 3) : i % 3 === 0 ? 13 : 12)).reduce((a, b) => a + b, 0);
    expect(test.methods.semantic!.mrr20.point.sum).toBe(semanticMrr);
  });

  it('uses the main generator with the registered seed and strata order, shared by every statistic of a stratum', async () => {
    const r = assembled(await assemble(build({ place: VARIED }))).results;
    const sizes = { test: 30, doc: 10, 'test-with-link': 15, 'test-without-link': 18 };
    const samples = drawStrataSamples(mulberry32(MAIN_SEED), sizes);
    const semanticMrr = r.cases.map((c) => c.methods.semantic.metrics!.test!.scaled.mrr20);
    const hybridMrr = r.cases.map((c) => c.methods.hybrid.metrics!.test!.scaled.mrr20);
    expect(new Set(semanticMrr).size).toBeGreaterThan(10);
    const expected = summarize(samples.test as never, semanticMrr);
    const test = available(strata(r).test);
    expect(test.methods.semantic!.mrr20.point).toEqual(expected.point);
    expect(test.methods.semantic!.mrr20.interval).toEqual(expected.interval);
    expect(test.differences.semantic!.mrr20.interval).toEqual(summarize(samples.test as never, hybridMrr.map((h, i) => h - semanticMrr[i]!)).interval);
    // The test can tell the seeds apart: the other stream gives another interval.
    expect(summarize(drawStrataSamples(mulberry32(SENSITIVITY_SEED), sizes).test as never, semanticMrr).interval).not.toEqual(expected.interval);
    // The doc stratum continues the same stream after the test stratum.
    const docSemantic = r.cases.filter((c) => c.strata.doc).map((c) => c.methods.semantic.metrics!.doc!.scaled.mrr20);
    expect(available(strata(r).doc).methods.semantic!.mrr20.interval).toEqual(summarize(samples.doc as never, docSemantic).interval);
    expect(r.conventions).toMatchObject({ replicates: 10_000, mainSeed: 20261014, sensitivitySeed: 2667729199, metricScale: L, scoredDepth: 20 });

    // Sensitivity: its own generator, over C (all 30 here).
    const sensitivitySamples = drawStrataSamples(mulberry32(SENSITIVITY_SEED), sizes);
    const arm = r.cases.map((c) => c.methods['no-description'].metrics!.test!.scaled.mrr20);
    expect(new Set(arm).size).toBeGreaterThan(10);
    const armInterval = available(r.sensitivity.strata.test).methods['no-description']!.mrr20.interval;
    expect(armInterval).toEqual(summarize(sensitivitySamples.test as never, arm).interval);
    expect(armInterval).not.toEqual(summarize(drawStrataSamples(mulberry32(MAIN_SEED), sizes).test as never, arm).interval);
  });

  it('decides with the frozen rules on the confirmatory comparison', async () => {
    const r = assembled(await assemble(build())).results;
    expect(r.decision).toMatchObject({ outcome: 'supported', rule: 'supported', incompleteRun: false, primaryPopulation: 30 });
    const test = available(strata(r).test);
    expect(r.decision).toEqual(
      decide({
        incompleteRun: false,
        primaryPopulation: 30,
        comparisons: {
          sibling: { difference: test.differences.sibling!.recall10.point, interval: test.differences.sibling!.recall10.interval },
          deterministic: { difference: test.differences.deterministic!.recall10.point, interval: test.differences.deterministic!.recall10.interval },
          semantic: { difference: test.differences.semantic!.recall10.point, interval: test.differences.semantic!.recall10.interval },
        },
      }),
    );
    rmSync(work, { recursive: true });
    rmSync(join(dir, 'manifest.json'));
    const negative = assembled(await assemble(build({ place: STRONG_SIBLING }))).results;
    expect(negative.decision).toMatchObject({ outcome: 'negative', rule: 'negative-sibling' });
  });

  it('is deterministic, records its provenance, and changes nothing', async () => {
    const built = build();
    const before = tree(work);
    const first = assembled(await assemble(built));
    const second = assembled(await assemble(built));
    expect(second.canonical).toBe(first.canonical);
    expect(second.sha256).toBe(first.sha256);
    expect(first.sha256).toBe(sha256Hex(first.canonical));
    expect(first.results.provenance).toEqual({
      manifestSha256: built.registration.manifestSha256,
      repository: { name: 'owner/repo', head: HEAD },
      tracebound: built.header.tracebound,
      nodeVersion: 'v24.20.0',
      embeddingModelId: built.header.embeddingModelId,
      frozenDatabaseSha256: built.header.frozenDatabaseSha256,
      preparationJournalSha256: sha256Hex(readFileSync(join(work, WORK_FILES.preparationJournal))),
      evaluationJournalSha256: sha256Hex(readFileSync(join(work, WORK_FILES.evaluationJournal))),
    });
    expect(first.canonical).not.toContain('machine');
    expect(tree(work)).toEqual(before);
    expect(existsSync(join(work, LOCK_FILE))).toBe(false);
  });
});

describe('an incomplete primary run', () => {
  it('reports cases but computes no primary aggregate, and is Inconclusive even when the rest would be favourable', async () => {
    const r = assembled(await assemble(build({ failures: [{ i: 7, methods: ['hybrid', 'deterministic', 'semantic'], stage: 'retrieval' }] }))).results;
    expect(r.status).toBe('primary-incomplete');
    expect(r.primary).toEqual({ estimated: false, reason: 'primary-incomplete' });
    expect(r.decision).toMatchObject({ outcome: 'inconclusive', rule: 'incomplete-run', evidence: null });
    expect(r.run.primaryIncompleteCommits).toEqual([commitSha(7)]);
    expect(r.run.methodFailures.hybrid).toEqual({ failed: [commitSha(7)], notRun: [] });
    expect(r.cases[7]!.methods.hybrid).toEqual({ status: 'failed', failure: { stage: 'retrieval', errorName: 'Error' }, targetRanks: null, metrics: null });
    expect(r.cases[7]!.methods.sibling.status).toBe('succeeded');
    expect(r.cases[8]!.methods.hybrid.metrics!.test!.scaled.recall10).toBe(L);
    expect(JSON.stringify(r)).not.toContain('machine');
  });

  it('marks the methods of an unprepared base as not run, and the run Inconclusive', async () => {
    const r = assembled(await assemble(build({ unprepared: [9] }))).results;
    expect(r.status).toBe('primary-incomplete');
    expect(r.cases[9]).toMatchObject({ snapshotId: null, linksKnown: false, strata: { test: true, 'test-with-link': null, 'test-without-link': null } });
    for (const method of ['hybrid', 'deterministic', 'semantic', 'sibling', 'no-description'] as const) {
      expect(r.cases[9]!.methods[method]).toMatchObject({ status: 'not_run', failure: { stage: 'preparation' } });
    }
    expect(r.run.methodFailures['no-description']).toEqual({ failed: [], notRun: [commitSha(9)] });
    expect(r.sensitivity.noDescriptionNotRun).toEqual([commitSha(9)]);
    expect(r.decision.rule).toBe('incomplete-run');
  });

  it('treats a sibling failure alone as primary-incomplete', async () => {
    const r = assembled(await assemble(build({ failures: [{ i: 2, methods: ['sibling'], stage: 'analysis' }] }))).results;
    expect(r).toMatchObject({ status: 'primary-incomplete', primary: { estimated: false }, decision: { outcome: 'inconclusive' } });
  });
});

describe('the no-description arm', () => {
  it('keeps its failure to the sensitivity analysis: same primary results and decision', async () => {
    const baseline = assembled(await assemble(build())).results;
    rmSync(work, { recursive: true });
    rmSync(join(dir, 'manifest.json'));
    const r = assembled(await assemble(build({ failures: [{ i: 4, methods: ['no-description'], stage: 'retrieval' }] }))).results;
    expect(r.status).toBe('complete');
    expect(r.primary).toEqual(baseline.primary);
    expect(r.decision).toEqual(baseline.decision);
    expect(r.sensitivity.commonPopulation).toHaveLength(29);
    expect(r.sensitivity.commonPopulation).not.toContain(commitSha(4));
    expect(r.sensitivity.noDescriptionFailed).toEqual([commitSha(4)]);
    expect(available(r.sensitivity.strata.test).populationSize).toBe(29);
  });

  it('cannot rescue an incomplete primary run', async () => {
    const r = assembled(await assemble(build({ failures: [{ i: 3, methods: ['hybrid', 'deterministic', 'semantic'], stage: 'retrieval' }] }))).results;
    expect(r.decision.outcome).toBe('inconclusive');
    expect(r.sensitivity.commonPopulation).not.toContain(commitSha(3));
    expect(r.sensitivity.ordinaryHybridUnsuccessful).toEqual([commitSha(3)]);
    expect(available(r.sensitivity.strata.test).populationSize).toBe(29);
  });
});

describe('refusals', () => {
  it('refuses a manifest other than the registered one', async () => {
    const built = build();
    expect(await assemble(built, { ...built.registration, manifestSha256: 'd'.repeat(64) })).toMatchObject({ status: 'refused', reason: 'manifest-mismatch' });
  });

  it('refuses an incomplete evaluation, never reading missing records as failures', async () => {
    const built = build({}, { records: 12 });
    const before = tree(work);
    expect(await assemble(built)).toMatchObject({ status: 'refused', reason: 'evaluation-incomplete' });
    expect(tree(work)).toEqual(before);
  });

  it('refuses a missing journal and a torn one, without recovering it', async () => {
    const built = build();
    const path = join(work, WORK_FILES.evaluationJournal);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"kind":"rec`);
    const before = tree(work);
    expect(await assemble(built)).toMatchObject({ status: 'refused', reason: 'evaluation-journal-interrupted' });
    expect(tree(work)).toEqual(before);
    rmSync(path);
    expect(await assemble(built)).toMatchObject({ status: 'refused', reason: 'evaluation-journal-missing' });
  });

  it('refuses out-of-order and duplicate records', async () => {
    const built = build();
    const path = join(work, WORK_FILES.evaluationJournal);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, `${[lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n')}\n`);
    expect(await assemble(built)).toMatchObject({ status: 'refused', reason: 'evaluation-journal-invalid' });
    writeFileSync(path, `${[lines[0], lines[1], lines[1], ...lines.slice(3)].join('\n')}\n`);
    expect(await assemble(built)).toMatchObject({ status: 'refused', reason: 'evaluation-journal-invalid' });
  });

  it.each([
    ['another query', (e: any) => (e.query.description = 'tampered')],
    ['another snapshot', (e: any) => (e.snapshotId = 99)],
    ['a duplicate in a ranking', (e: any) => e.rankings.hybridPaths.push(e.rankings.hybridPaths[0])],
    ['an input in a ranking', (e: any) => e.rankings.semanticPaths.unshift('src/m5.ts')],
    ['a missing ranking', (e: any) => delete e.rankings.siblingPaths],
    ['a link to a path that is not a test target', (e: any) => (e.linkedTargetPaths = ['docs/m5.md'])],
    ['missing targets that are not targets', (e: any) => (e.missingTargets = [{ path: 'src/m5.ts', reason: 'binary' }])],
  ])('refuses a record with %s', async (_label, tamper) => {
    const built = build();
    const path = join(work, WORK_FILES.evaluationJournal);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const record = JSON.parse(lines[6]!) as EvaluationRecord;
    tamper(record.evidence);
    lines[6] = canonicalJson(record);
    writeFileSync(path, `${lines.join('\n')}\n`);
    expect(await assemble(built)).toMatchObject({ status: 'refused', reason: 'evaluation-records-invalid' });
  });

  it('refuses a frozen database other than the one the evaluation read', async () => {
    const built = build();
    writeFileSync(join(work, WORK_FILES.frozenDatabase), 'another database');
    expect(await assemble(built)).toMatchObject({ status: 'refused', reason: 'frozen-database-mismatch' });
    rmSync(join(work, WORK_FILES.frozenDatabase));
    expect(await assemble(built)).toMatchObject({ status: 'refused', reason: 'frozen-database-mismatch' });
  });

  it('refuses a preparation journal of another run identity', async () => {
    const built = build({}, { preparationHeader: { tracebound: { commit: 'e'.repeat(40), sourceClean: true, buildSha256: 'f'.repeat(64) } } });
    expect(await assemble(built)).toMatchObject({ status: 'refused', reason: 'preparation-journal-invalid' });
  });

  it('refuses while another invocation holds the lock, touching nothing', async () => {
    const built = build();
    const foreign = `${JSON.stringify({ schema: 'tracebound.cochange.lock', version: 1, token: 'x', purpose: 'other', pid: 1, hostname: 'elsewhere.invalid', startedAt: '2026-10-15T00:00:00.000Z' })}\n`;
    writeFileSync(join(work, LOCK_FILE), foreign);
    const before = tree(work);
    expect(await assemble(built)).toMatchObject({ status: 'locked' });
    expect(tree(work)).toEqual(before);
  });
});
