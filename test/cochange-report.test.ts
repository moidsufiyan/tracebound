import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleResults, type AssemblyResult, type CochangeResults } from '../src/evaluation/cochange/assemble.js';
import { canonicalJson, sha256Hex } from '../src/evaluation/m9/canonical.js';
import { renderReport, REPORT_FILE, RESULTS_FILE, ResultsValidationError, validateResults, type AssembledResults, type ExpectedIdentity } from '../src/evaluation/cochange/report.js';
import { buildSynthetic, HEAD, STRONG_SIBLING, type Built, type Scenario } from './cochange-synthetic.js';

// Each test assembles 30 synthetic commits with several 10,000-replicate bootstraps; the 5 s default is too tight when the suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracebound-report-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function assembled(scenario: Scenario = {}): Promise<{ built: Built; result: AssembledResults; expected: ExpectedIdentity }> {
  const built = buildSynthetic(dir, scenario);
  const result: AssemblyResult = await assembleResults({ workDirectory: built.work, manifestPath: built.manifestPath }, { registration: built.registration });
  if (result.status !== 'assembled') throw new Error(JSON.stringify(result));
  return { built, result, expected: { manifestSha256: built.registration.manifestSha256, repository: { name: 'owner/repo', head: HEAD } } };
}

/** The same results with `change` applied, re-serialized so that only the named defect is present. */
function tampered(result: AssembledResults, change: (r: any) => void): AssembledResults {
  const copy = JSON.parse(result.canonical) as CochangeResults;
  change(copy);
  const canonical = canonicalJson(copy);
  return { results: copy, canonical, sha256: sha256Hex(canonical) };
}

describe('validation', () => {
  it('accepts a complete result and a primary-incomplete one', async () => {
    const complete = await assembled();
    expect(validateResults(complete.result, complete.expected)).toBe(complete.result.results);
    rmSync(dir, { recursive: true });
    dir = mkdtempSync(join(tmpdir(), 'tracebound-report-test-'));
    const incomplete = await assembled({ failures: [{ i: 3, methods: ['hybrid', 'deterministic', 'semantic'], stage: 'retrieval' }] });
    expect(validateResults(incomplete.result, incomplete.expected).status).toBe('primary-incomplete');
  });

  it.each([
    ['a canonical text that is not the results', (a: AssembledResults) => ({ ...a, canonical: `${a.canonical} ` })],
    ['results that differ from their canonical text', (a: AssembledResults) => ({ ...a, results: { ...a.results, provenance: { ...a.results.provenance, nodeVersion: 'v99.0.0' } } })],
    ['a wrong hash', (a: AssembledResults) => ({ ...a, sha256: 'f'.repeat(64) })],
    ['a hash of the wrong text', (a: AssembledResults) => ({ ...a, sha256: sha256Hex('x') })],
  ])('refuses %s', async (_label, damage) => {
    const { result, expected } = await assembled();
    expect(() => validateResults(damage(result), expected)).toThrow(ResultsValidationError);
  });

  it.each([
    ['another schema', (r: any) => (r.schema = 'other')],
    ['another schema version', (r: any) => (r.schemaVersion = '2.0.0')],
    ['another protocol version', (r: any) => (r.protocol.version = '1.1.0')],
    ['another manifest', (r: any) => (r.provenance.manifestSha256 = 'a'.repeat(64))],
    ['another repository head', (r: any) => (r.provenance.repository.head = 'a'.repeat(40))],
    ['a malformed journal hash', (r: any) => (r.provenance.evaluationJournalSha256 = 'abc')],
    ['an abbreviated Tracebound commit', (r: any) => (r.provenance.tracebound.commit = 'abc')],
    ['another seed', (r: any) => (r.conventions.mainSeed = 1)],
    ['another replicate count', (r: any) => (r.conventions.replicates = 100)],
    ['another metric scale', (r: any) => (r.conventions.metricScale = 1)],
    ['a case count that does not match', (r: any) => (r.run.commits = 29)],
    ['a repeated case', (r: any) => (r.cases[1].commit = r.cases[0].commit)],
    ['a failed method with a ranking', (r: any) => (r.cases[2].methods.hybrid.status = 'failed')],
    ['a failure carrying a message', (r: any) => ((r.cases[2].methods.hybrid = { status: 'failed', failure: { stage: 'retrieval', errorName: 'E', message: 'x' }, targetRanks: null, metrics: null }), (r.run.primaryIncompleteCommits = [r.cases[2].commit]))],
    ['a wrong primary population', (r: any) => (r.run.primaryTestPopulation = 29)],
    ['a primary stratum that is not the commits with targets', (r: any) => r.primary.strata.doc.commits.pop()],
    ['a primary stratum of the wrong size', (r: any) => (r.primary.strata.test.populationSize = 29)],
    ['sensitivity not marked descriptive', (r: any) => (r.sensitivity.descriptive = false)],
    ['a common population that is not hybrid and the arm succeeding', (r: any) => r.sensitivity.commonPopulation.pop()],
  ])('refuses a result with %s', async (_label, change) => {
    const { result, expected } = await assembled();
    expect(() => validateResults(tampered(result, change), expected)).toThrow(ResultsValidationError);
  });

  it('refuses a result for another manifest or repository than the one expected', async () => {
    const { result, expected } = await assembled();
    expect(() => validateResults(result, { ...expected, manifestSha256: 'a'.repeat(64) })).toThrow(/another manifest/);
    expect(() => validateResults(result, { ...expected, repository: { name: 'owner/repo', head: 'a'.repeat(40) } })).toThrow(/another repository/);
  });

  it('refuses a decision that does not follow from the recorded primary estimates', async () => {
    const { result, expected } = await assembled();
    expect(result.results.decision.outcome).toBe('supported');
    expect(() => validateResults(tampered(result, (r) => ((r.decision.outcome = 'negative'), (r.decision.rule = 'negative-sibling'))), expected)).toThrow(/does not follow/);
    expect(() => validateResults(tampered(result, (r) => (r.decision.evidence.sibling.atLeastTenth = false)), expected)).toThrow(/does not follow/);
  });

  it('refuses a decision made from the sensitivity results instead of the primary ones', async () => {
    const { result, expected } = await assembled();
    expect(result.results.decision.outcome).toBe('supported');
    const sensitivityDifference = result.results.sensitivity.strata.test.available ? result.results.sensitivity.strata.test.differences['no-description']!.recall10 : null;
    expect(sensitivityDifference).not.toBeNull();
    expect(() =>
      validateResults(
        tampered(result, (r) => {
          const test = r.primary.strata.test;
          for (const baseline of ['sibling', 'deterministic', 'semantic']) test.differences[baseline].recall10 = r.sensitivity.strata.test.differences['no-description'].recall10;
        }),
        expected,
      ),
    ).toThrow(/does not follow/);
  });

  it('refuses a primary-incomplete result that is not Inconclusive, or that has primary estimates', async () => {
    const { result, expected } = await assembled({ failures: [{ i: 7, methods: ['hybrid', 'deterministic', 'semantic'], stage: 'retrieval' }] });
    expect(() => validateResults(tampered(result, (r) => ((r.decision.outcome = 'supported'), (r.decision.rule = 'supported'))), expected)).toThrow(/Inconclusive/);
    expect(() => validateResults(tampered(result, (r) => (r.decision.evidence = {})), expected)).toThrow(/Inconclusive/);
    expect(() => validateResults(tampered(result, (r) => (r.primary = { estimated: true, strata: {} })), expected)).toThrow(/primary estimates/);
    expect(() => validateResults(tampered(result, (r) => (r.status = 'complete')), expected)).toThrow(ResultsValidationError);
  });

  it('refuses a complete-looking result that has an incomplete case, and one without primary estimates', async () => {
    const { result, expected } = await assembled();
    expect(() => validateResults(tampered(result, (r) => ((r.cases[5].methods.sibling = { status: 'failed', failure: { stage: 'analysis', errorName: 'E' }, targetRanks: null, metrics: null }), (r.run.primaryIncompleteCommits = []))), expected)).toThrow(/incomplete commits|follow/);
    expect(() => validateResults(tampered(result, (r) => (r.primary = { estimated: false, reason: 'primary-incomplete' })), expected)).toThrow(/without primary estimates/);
  });

  it('refuses machine-specific text and raw messages anywhere', async () => {
    const { result, expected } = await assembled();
    for (const leak of ['C:\\Users\\me\\repo', '/Users/me/repo', '/home/me/x', '\\\\server\\share', 'AppData']) {
      expect(() => validateResults(tampered(result, (r) => (r.cases[0].preparation = { status: leak })), expected), leak).toThrow(/machine-specific/);
    }
    expect(() => validateResults(tampered(result, (r) => (r.cases[0].preparation = { message: 'x' })), expected)).toThrow(/raw message/);
  });
});

describe('the report', () => {
  it('is rendered from the results only, deterministically', async () => {
    const { result } = await assembled();
    const first = renderReport(result.results, result.sha256);
    expect(renderReport(JSON.parse(result.canonical), result.sha256)).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(first).not.toMatch(/\n{3}/);
  });

  it('reports a complete result with its decision, metrics, intervals, comparisons and sensitivity', async () => {
    const { result } = await assembled();
    const r = result.results;
    const text = renderReport(r, result.sha256);
    expect(text).toContain('**Result: SUPPORTED** (supported)');
    expect(text).toContain(`SHA-256 \`${result.sha256}\``);
    expect(text).toContain('Rule that decided: **supported**');
    expect(text).toContain('Confirmatory comparison: hybrid against the sibling-test heuristic');
    for (const heading of ['## Objective', '## Outcome', '## Primary results', '### Test targets (primary)', '### Documentation targets', '### Test targets with a structural link', '### Test targets without a structural link', '## Cases', '## Failures', '## Sensitivity: hybrid without a description (descriptive only)', '## Statistical settings', '## Provenance', '## What this does and does not show']) {
      expect(text, heading).toContain(heading);
    }
    for (const label of ['Recall@3', 'Recall@5', 'Recall@10', 'Recall@20', 'MRR@20', 'Hybrid minus', 'Sibling-test heuristic', 'Deterministic only', 'Semantic only']) expect(text, label).toContain(label);
    // Formatted from the recorded values.
    const test = r.primary.estimated && r.primary.strata.test.available ? r.primary.strata.test : null;
    const hybridRecall10 = test!.methods.hybrid!.recall10;
    expect(hybridRecall10.rate).toBe(1);
    expect(text).toContain('1.0000 [1.0000, 1.0000]');
    const semantic = test!.methods.semantic!.recall10;
    expect(text).toContain(`${semantic.rate.toFixed(4)} [${semantic.intervalRate.lower.toFixed(4)}, ${semantic.intervalRate.upper.toFixed(4)}]`);
    // Statistical settings and provenance, as recorded.
    expect(text).toContain('10000 replicates');
    expect(text).toContain('seeds 20261014 (primary) and 2667729199 (sensitivity)');
    expect(text).toContain(r.provenance.frozenDatabaseSha256);
    expect(text).toContain(r.provenance.tracebound.buildSha256);
    expect(text).toContain(r.provenance.embeddingModelId);
    expect(text).toContain('Not verified by assembly or publication');
    expect(text).toContain('Recorded in the journal headers when the evaluation ran');
  });

  it('reports a primary-incomplete result as Inconclusive with no primary estimates, and keeps cases and sensitivity descriptive', async () => {
    const { result } = await assembled({ failures: [{ i: 7, methods: ['hybrid', 'deterministic', 'semantic'], stage: 'retrieval' }], unprepared: [9] });
    const text = renderReport(result.results, result.sha256);
    expect(text).toContain('**Result: INCONCLUSIVE** (incomplete-run)');
    expect(text).toContain('The primary run is incomplete; no primary estimates are given.');
    expect(text).toContain('No aggregate estimate is reported for any method');
    expect(text).not.toContain('## Primary results');
    expect(text).not.toContain('Confirmatory comparison');
    expect(text).toContain('| failed (retrieval) |');
    expect(text).toContain('| not run |');
    expect(text).toContain('## Sensitivity: hybrid without a description (descriptive only)');
    expect(text).toContain('It plays no part in the decision and cannot change it.');
    expect(text).toContain('Computed on the common population C: the 28 selected commit(s)');
  });

  it('shows a negative outcome as a limit of the evidence, not as a claim about the model', async () => {
    const { result } = await assembled({ place: STRONG_SIBLING });
    const text = renderReport(result.results, result.sha256);
    expect(text).toContain('**Result: NEGATIVE** (negative-sibling)');
    expect(text).toContain('does not show hybrid retrieval to be better than a trivial heuristic');
  });

  it('contains no machine-specific text and no raw error message', async () => {
    const { result } = await assembled({ failures: [{ i: 3, methods: ['hybrid', 'deterministic', 'semantic', 'no-description'], stage: 'retrieval' }] });
    const text = renderReport(result.results, result.sha256);
    expect(text).not.toMatch(/path broke|C:\\|\/Users\/|AppData/);
    expect(text).toContain('A failure keeps only its stage and error name');
  });

  it('uses the registered file names', () => {
    expect([RESULTS_FILE, REPORT_FILE]).toEqual(['results.json', 'report.md']);
  });
});
