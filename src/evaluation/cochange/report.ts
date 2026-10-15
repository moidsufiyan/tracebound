import { canonicalJson, sha256Hex } from '../m9/canonical.js';
import { INTERVAL_PERCENTILES, MAIN_SEED, REPLICATES, SENSITIVITY_SEED } from './bootstrap.js';
import type { CaseResult, CochangeResults, StatisticSummary, StratumSummary } from './assemble.js';
import { RESULTS_SCHEMA, RESULTS_SCHEMA_VERSION } from './assemble.js';
import { BASELINES, decide, MINIMUM_TEST_POPULATION, type Baseline, type Comparison } from './decision.js';
import { METRIC_SCALE, METRICS, RECALL_KS, STRATA, type Metric, type Stratum } from './metrics.js';
import { SCORED_DEPTH } from './rankings.js';
import { PROTOCOL } from './selector.js';

// Validation and rendering of the co-change results (protocol 1.0.0). Pure: nothing here reads a
// file, a journal or the clock.
//
// `validateResults` checks an assembled result (assemble.ts) before anything is published: its
// schema, registered identities, hash, internal consistency, the separation of primary and
// sensitivity results, and that nothing machine-specific is in it. It computes no metric: the one
// calculation it repeats is the decision, with the same `decide` function from the same recorded
// inputs, to show that the recorded decision follows from the recorded primary estimates alone.
//
// `renderReport` writes the human-readable report from the results only. Numbers are formatted
// from the recorded values (rates and interval rates), never recomputed.

export const RESULTS_FILE = 'results.json';
export const REPORT_FILE = 'report.md';

export class ResultsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultsValidationError';
  }
}

/** What a result must be tied to. */
export interface ExpectedIdentity {
  manifestSha256: string;
  repository: { name: string; head: string };
}

export interface AssembledResults {
  results: CochangeResults;
  /** The canonical JSON text of `results`. */
  canonical: string;
  /** SHA-256 of `canonical`. */
  sha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const METHODS = ['hybrid', 'deterministic', 'semantic', 'sibling', 'no-description'] as const;
const PRIMARY_ANALYSIS = ['hybrid', 'deterministic', 'semantic', 'sibling'] as const;
// Text that would reveal where a run happened: Windows drive or UNC paths, and home or temp locations.
const MACHINE_TEXT = /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private|mnt)\/|\\Users\\|AppData/;

function invalid(message: string): never {
  throw new ResultsValidationError(message);
}

/** Throws ResultsValidationError unless `assembled` is a consistent result for `expected`. Returns the results. */
export function validateResults(assembled: AssembledResults, expected: ExpectedIdentity): CochangeResults {
  const { results: r, canonical, sha256 } = assembled;
  // Hash and bytes.
  if (typeof canonical !== 'string' || canonicalJson(r) !== canonical) invalid('The canonical text is not the canonical form of the results');
  if (sha256 !== sha256Hex(canonical)) invalid('The recorded SHA-256 is not the hash of the canonical text');

  // Schema and registered identities.
  if (r.schema !== RESULTS_SCHEMA || r.schemaVersion !== RESULTS_SCHEMA_VERSION) invalid('Unsupported results schema or version');
  if (r.protocol.path !== PROTOCOL.path || r.protocol.version !== PROTOCOL.version) invalid('The results are for another protocol');
  const p = r.provenance;
  if (p.manifestSha256 !== expected.manifestSha256) invalid('The results are for another manifest');
  if (p.repository.name !== expected.repository.name || p.repository.head !== expected.repository.head) invalid('The results are for another repository or head');
  for (const [name, value] of [
    ['manifest', p.manifestSha256],
    ['frozen database', p.frozenDatabaseSha256],
    ['preparation journal', p.preparationJournalSha256],
    ['evaluation journal', p.evaluationJournalSha256],
    ['build', p.tracebound.buildSha256],
  ] as const) {
    if (!SHA256.test(value)) invalid(`The ${name} hash is not a SHA-256`);
  }
  if (!COMMIT.test(p.tracebound.commit) || !COMMIT.test(p.repository.head)) invalid('A commit identity is not a full SHA');
  if (typeof p.tracebound.sourceClean !== 'boolean' || typeof p.nodeVersion !== 'string' || typeof p.embeddingModelId !== 'string' || p.embeddingModelId === '') invalid('Incomplete provenance');

  // Registered statistical settings.
  const c = r.conventions;
  if (
    c.metricScale !== METRIC_SCALE ||
    c.scoredDepth !== SCORED_DEPTH ||
    c.replicates !== REPLICATES ||
    c.mainSeed !== MAIN_SEED ||
    c.sensitivitySeed !== SENSITIVITY_SEED ||
    canonicalJson(c.recallKs) !== canonicalJson(RECALL_KS) ||
    canonicalJson(c.strataOrder) !== canonicalJson(STRATA) ||
    canonicalJson(c.intervalPercentiles) !== canonicalJson(INTERVAL_PERCENTILES)
  ) {
    invalid('The statistical settings are not the registered ones');
  }

  // Cases.
  if (!Array.isArray(r.cases) || r.cases.length === 0 || r.cases.length !== r.run.commits) invalid('The number of cases is not the number of commits');
  const commits = r.cases.map((x) => x.commit);
  if (new Set(commits).size !== commits.length || commits.some((x) => !COMMIT.test(x))) invalid('The cases do not have unique full commit SHAs');
  for (const x of r.cases) {
    for (const method of METHODS) {
      const m = x.methods[method];
      if (!m) invalid(`Case ${x.commit} has no ${method} result`);
      const ok = m.status === 'succeeded' ? m.failure === null && m.targetRanks !== null && m.metrics !== null : m.failure !== null && m.targetRanks === null && m.metrics === null;
      if (!ok || (m.status === 'not_run' && m.failure!.stage !== 'preparation')) invalid(`Case ${x.commit}: the ${method} status does not fit its evidence`);
      if (m.failure && Object.keys(m.failure).sort().join() !== 'errorName,stage') invalid(`Case ${x.commit}: a failure carries more than its stage and error name`);
    }
  }
  const incomplete = r.cases.filter((x) => PRIMARY_ANALYSIS.some((m) => x.methods[m].status !== 'succeeded')).map((x) => x.commit);
  if (canonicalJson(incomplete) !== canonicalJson(r.run.primaryIncompleteCommits)) invalid('The primary-incomplete commits do not follow from the cases');
  const testPopulation = r.cases.filter((x) => x.strata.test).length;
  if (testPopulation !== r.run.primaryTestPopulation) invalid('The primary test population does not follow from the cases');

  // Outcome semantics.
  if (r.status === 'primary-incomplete') {
    if (incomplete.length === 0) invalid('A primary-incomplete result with no incomplete commit');
    if (r.primary.estimated !== false) invalid('A primary-incomplete result has primary estimates');
    if (r.decision.outcome !== 'inconclusive' || r.decision.rule !== 'incomplete-run' || r.decision.evidence !== null || !r.decision.incompleteRun) {
      invalid('A primary-incomplete result must be Inconclusive by the incomplete-run rule');
    }
  } else if (r.status === 'complete') {
    if (incomplete.length > 0) invalid('A complete result with incomplete commits');
    if (r.primary.estimated !== true) invalid('A complete result without primary estimates');
    if (r.decision.incompleteRun) invalid('A complete result with an incomplete-run decision');
    validatePrimary(r, r.primary.strata);
  } else {
    invalid(`Unknown status ${String(r.status)}`);
  }
  if (r.decision.primaryPopulation !== testPopulation) invalid('The decision was made on another population than the test targets');

  validateSensitivity(r);

  // Nothing machine-specific.
  scanForLeaks(r, '$');
  return r;
}

function validatePrimary(r: CochangeResults, strata: Record<Stratum, StratumSummary>): void {
  if (canonicalJson(Object.keys(strata).sort()) !== canonicalJson([...STRATA].sort())) invalid('The primary strata are not the registered ones');
  for (const stratum of STRATA) {
    const members = r.cases.filter((x) => x.strata[stratum]).map((x) => x.commit);
    const s = strata[stratum];
    if (members.length === 0 ? s.available : !s.available || canonicalJson(s.commits) !== canonicalJson(members)) invalid(`The ${stratum} stratum is not the commits that have targets in it`);
    if (s.available) {
      if (s.populationSize !== members.length) invalid(`The ${stratum} population size is wrong`);
      for (const method of PRIMARY_ANALYSIS) if (!s.methods[method]) invalid(`The ${stratum} stratum lacks ${method}`);
      if (canonicalJson(Object.keys(s.differences).sort()) !== canonicalJson([...BASELINES].sort())) invalid(`The ${stratum} differences are not hybrid minus each baseline`);
    }
  }
  // The decision follows from the recorded test-stratum Recall@10 comparisons alone.
  const test = strata.test;
  let comparisons: Record<Baseline, Comparison> | null = null;
  if (test.available) {
    comparisons = Object.fromEntries(BASELINES.map((b) => [b, { difference: test.differences[b]!.recall10.point, interval: test.differences[b]!.recall10.interval }])) as Record<Baseline, Comparison>;
  } else if (r.run.primaryTestPopulation >= MINIMUM_TEST_POPULATION) {
    invalid('The test stratum is unavailable although enough commits have test targets');
  }
  let expected;
  try {
    expected = decide({ incompleteRun: false, primaryPopulation: r.run.primaryTestPopulation, comparisons });
  } catch (error) {
    return invalid(`The decision cannot be reproduced from the primary estimates: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (canonicalJson(expected) !== canonicalJson(r.decision)) invalid('The recorded decision does not follow from the recorded primary estimates');
}

function validateSensitivity(r: CochangeResults): void {
  const s = r.sensitivity;
  if (s.descriptive !== true) invalid('The sensitivity results are not marked descriptive');
  const common = r.cases.filter((x) => x.methods.hybrid.status === 'succeeded' && x.methods['no-description'].status === 'succeeded').map((x) => x.commit);
  if (canonicalJson(s.commonPopulation) !== canonicalJson(common)) invalid('The common population is not the commits where hybrid and the no-description arm both succeeded');
  if (canonicalJson(Object.keys(s.strata).sort()) !== canonicalJson([...STRATA].sort())) invalid('The sensitivity strata are not the registered ones');
  const inCommon = new Set(common);
  for (const stratum of STRATA) {
    const x = s.strata[stratum];
    if (!x.available) continue;
    const members = r.cases.filter((c) => inCommon.has(c.commit) && c.strata[stratum]).map((c) => c.commit);
    if (canonicalJson(x.commits) !== canonicalJson(members) || x.populationSize !== members.length) invalid(`The sensitivity ${stratum} stratum is not the common population's members`);
    if (!x.methods.hybrid || !x.methods['no-description'] || !x.differences['no-description'] || Object.keys(x.differences).length !== 1) invalid(`The sensitivity ${stratum} stratum has other methods than hybrid and the arm`);
  }
}

function scanForLeaks(value: unknown, at: string): void {
  if (typeof value === 'string') {
    if (MACHINE_TEXT.test(value)) invalid(`${at} contains machine-specific text`);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => scanForLeaks(item, `${at}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'message') invalid(`${at} carries a raw message`);
      scanForLeaks(child, `${at}.${key}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering

const METRIC_LABEL: Record<Metric, string> = { recall3: 'Recall@3', recall5: 'Recall@5', recall10: 'Recall@10', recall20: 'Recall@20', mrr20: 'MRR@20' };
const METHOD_LABEL: Record<string, string> = {
  hybrid: 'Hybrid',
  deterministic: 'Deterministic only',
  semantic: 'Semantic only',
  sibling: 'Sibling-test heuristic',
  'no-description': 'Hybrid, no description',
};
const STRATUM_LABEL: Record<Stratum, string> = {
  test: 'Test targets (primary)',
  doc: 'Documentation targets',
  'test-with-link': 'Test targets with a structural link',
  'test-without-link': 'Test targets without a structural link',
};
const OUTCOME_TEXT: Record<string, string> = {
  supported:
    'Supported: hybrid beat the sibling-test heuristic by at least 0.10 macro Recall@10 on test targets with a 95% interval strictly above zero, and neither single-source baseline outperformed hybrid materially.',
  mixed:
    'Mixed: hybrid beat the sibling-test heuristic with an interval strictly above zero, but either by less than 0.10, or while a single-source baseline outperformed hybrid materially.',
  negative:
    'Negative: the sibling-test heuristic outperformed hybrid materially, or a single-source baseline did while hybrid did not beat the sibling-test heuristic. This means the evidence does not show hybrid retrieval to be better than a trivial heuristic on this repository.',
  inconclusive:
    'Inconclusive: no registered rule established a direction, or the run was incomplete, or fewer than 20 commits had a test target. This is not a finding that hybrid retrieval does or does not help.',
};
const RULE_TEXT: Record<string, string> = {
  'incomplete-run': 'A required hybrid, deterministic-only, semantic-only or sibling result is missing or failed on at least one selected commit (rule 1).',
  'minimum-test-targets': `Fewer than ${MINIMUM_TEST_POPULATION} selected commits have a test target (rule 1).`,
  'negative-sibling': 'The sibling-test heuristic outperformed hybrid materially.',
  'negative-baseline': 'A single-source baseline outperformed hybrid materially, and hybrid did not beat the sibling-test heuristic.',
  supported: 'The sibling difference was at least 0.10 with an interval above zero, and no single-source baseline outperformed hybrid materially.',
  'mixed-small-effect': 'Hybrid beat the sibling-test heuristic with an interval above zero, but by less than 0.10.',
  'mixed-baseline': 'Hybrid beat the sibling-test heuristic by at least 0.10, but a single-source baseline outperformed hybrid materially.',
  'none-applies': 'No other rule applied.',
};

const number = (value: number): string => (Object.is(value, -0) || Math.abs(value) < 5e-5 ? 0 : value).toFixed(4);
const cell = (s: StatisticSummary): string => `${number(s.rate)} [${number(s.intervalRate.lower)}, ${number(s.intervalRate.upper)}]`;
const short = (sha: string): string => sha.slice(0, 12);
const escape = (text: string): string => text.replace(/\|/g, '\\|');
const table = (header: string[], rows: string[][]): string[] => [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`), ''];

/** The report for validated results. `resultsSha256` is the SHA-256 of the published results.json. */
export function renderReport(r: CochangeResults, resultsSha256: string): string {
  const out: string[] = [];
  const line = (...text: string[]) => out.push(...text);
  const d = r.decision;

  line('# Co-change evaluation report', '');
  line(`**Result: ${d.outcome.toUpperCase()}** (${d.rule}). ${r.status === 'complete' ? 'Every selected commit has complete primary results.' : 'The primary run is incomplete; no primary estimates are given.'}`, '');
  line(`Rendered from \`${RESULTS_FILE}\` (SHA-256 \`${resultsSha256}\`) only. Protocol \`${r.protocol.path}\`, version ${r.protocol.version}. Repository \`${r.provenance.repository.name}\` at \`${r.provenance.repository.head}\`.`, '');

  line('## Objective', '');
  line(
    'When a developer changes source files, does Tracebound\'s hybrid retrieval surface the test and documentation files that the same commit also changed, better than simple baselines? The comparison runs on selected commits of one repository that took no part in Tracebound\'s design. A file changed in the same commit is a weak proxy for impact: these results speak to retrieval of co-changed files, not to impact accuracy.',
    '',
  );
  line('Registered methods: hybrid (reciprocal rank fusion of the deterministic and semantic rankings), deterministic only, semantic only, and the sibling-test heuristic; plus a descriptive sensitivity arm, hybrid with an empty description. Each ranking has the commit\'s input files removed and its first 20 entries scored.', '');

  line('## Outcome', '');
  line(OUTCOME_TEXT[d.outcome] ?? d.outcome, '');
  line(`Rule that decided: **${d.rule}**. ${RULE_TEXT[d.rule] ?? ''}`, '');
  line(`Selected commits: ${r.run.commits}. Commits with a test target (primary population): ${r.run.primaryTestPopulation}.`, '');
  if (r.status === 'primary-incomplete') {
    line(`The primary analysis is incomplete on ${r.run.primaryIncompleteCommits.length} commit(s). No aggregate estimate is reported for any method, because a subset of the commits is not the registered population. Case-level results below are descriptive.`, '');
  } else if (d.evidence) {
    line('Confirmatory comparison: hybrid against the sibling-test heuristic, macro Recall@10 on test targets (difference = hybrid minus the baseline, 95% percentile bootstrap interval). The other two comparisons are exploratory and can only downgrade the outcome.', '');
    line(
      ...table(
        ['Baseline', 'Difference', '95% interval', 'Interval above 0', 'Interval below 0', 'At least 0.10', 'Outperforms hybrid materially'],
        BASELINES.map((b) => {
          const e = d.evidence![b];
          const t = r.primary.estimated ? r.primary.strata.test : null;
          const s = t && t.available ? t.differences[b]!.recall10 : null;
          return [
            METHOD_LABEL[b]!,
            s ? number(s.rate) : '',
            s ? `[${number(s.intervalRate.lower)}, ${number(s.intervalRate.upper)}]` : '',
            e.intervalAboveZero ? 'yes' : 'no',
            e.intervalBelowZero ? 'yes' : 'no',
            e.atLeastTenth ? 'yes' : 'no',
            e.materiallyOutperforms ? 'yes' : 'no',
          ];
        }),
      ),
    );
  }

  if (r.primary.estimated) {
    line('## Primary results', '');
    line('Macro averages over the commits with at least one target in the stratum, each with its 95% percentile bootstrap interval. Differences are hybrid minus the named method.', '');
    for (const stratum of STRATA) line(...stratumSection(STRATUM_LABEL[stratum], r.primary.strata[stratum], PRIMARY_ANALYSIS, BASELINES));
  }

  line('## Cases', '');
  line('Descriptive. Each cell is the best position of any target in the method\'s ranking after the inputs were removed (positions beyond 20 are not scored), or the method\'s status.', '');
  line(...table(['Commit', 'Test / doc targets', 'Missing targets', ...METHODS_ORDER.map((m) => METHOD_LABEL[m]!)], r.cases.map((c) => caseRow(c))));

  line('## Failures', '');
  const failureRows = METHODS_ORDER.map((m) => {
    const f = r.run.methodFailures[m];
    return [METHOD_LABEL[m]!, String(f.failed.length), String(f.notRun.length)];
  });
  line(...table(['Method', 'Failed commits', 'Not run (base failed preparation)'], failureRows));
  line('A failure keeps only its stage and error name; raw error text is not published. Missing records are never read as failures: an evaluation with missing records is refused before any result exists.', '');

  line('## Sensitivity: hybrid without a description (descriptive only)', '');
  const s = r.sensitivity;
  line(
    `Computed on the common population C: the ${s.commonPopulation.length} selected commit(s) where both ordinary hybrid and the arm succeeded, with a separate generator (seed ${r.conventions.sensitivitySeed}). It measures how much hybrid depends on the commit subject and does not remove all leakage of the commit into the query: the input paths are still given. It plays no part in the decision and cannot change it.`,
    '',
  );
  line(`Ordinary hybrid unsuccessful: ${s.ordinaryHybridUnsuccessful.length}. Arm failed: ${s.noDescriptionFailed.length}. Arm not run: ${s.noDescriptionNotRun.length}.`, '');
  for (const stratum of STRATA) line(...stratumSection(STRATUM_LABEL[stratum], s.strata[stratum], ['hybrid', 'no-description'], ['no-description']));

  line('## Statistical settings', '');
  const c = r.conventions;
  line(
    `- Metrics: Recall@${c.recallKs.join(', Recall@')} and MRR@${c.scoredDepth}, macro-averaged over commits; scored depth ${c.scoredDepth}.`,
    `- Exact arithmetic: every per-commit value is an integer multiple of 1/${c.metricScale}; rates are derived only for display.`,
    `- Paired percentile bootstrap over commits: ${c.replicates} replicates, interval from the ${c.intervalPercentiles.lower} and ${c.intervalPercentiles.upper} percentiles, Mulberry32 seeds ${c.mainSeed} (primary) and ${c.sensitivitySeed} (sensitivity). The streams are distinct deterministic streams; no statistical independence is claimed.`,
    `- Strata, in the order the primary generator is consumed: ${c.strataOrder.join(', ')}.`,
    '',
  );

  line('## Provenance', '');
  const p = r.provenance;
  line('Recorded in the journal headers when the evaluation ran. Assembly did not re-check any of these against the machine that ran the evaluation:', '');
  line(
    `- Tracebound commit \`${p.tracebound.commit}\` (source recorded as ${p.tracebound.sourceClean ? 'clean' : 'not clean'}); build hash \`${p.tracebound.buildSha256}\``,
    `- Node ${p.nodeVersion}`,
    `- Embedding model identity \`${p.embeddingModelId}\` (as configured; this report does not show that the model was reachable or that its weights were verified)`,
    '',
  );
  line('Verified when the results were assembled (assembly refuses otherwise):', '');
  line(
    `- Manifest bytes equal the registered manifest, SHA-256 \`${p.manifestSha256}\``,
    `- Frozen database bytes equal the database the evaluation read, SHA-256 \`${p.frozenDatabaseSha256}\``,
    `- Preparation journal, SHA-256 \`${p.preparationJournalSha256}\`, valid, complete and for the same run identity`,
    `- Evaluation journal, SHA-256 \`${p.evaluationJournalSha256}\`, valid, complete, in manifest order, and its records consistent with the manifest and the preparation`,
    '',
  );
  line('Not verified by assembly or publication: the state of the dataset clone and of the Tracebound checkout and build at evaluation time, and whether the recorded rankings came from the real embedding model.', '');

  line('## What this does and does not show', '');
  line(
    '- It shows how well each method ranked the files that the selected commits co-changed, within the first 20 results, on this one repository.',
    '- It does not show that any file is affected by a change, and it does not measure impact classification accuracy: the repository has no impact-level labels.',
    '- Co-change is a biased subset of what a change touches; commits are drawn from one repository; classification of files into source, test and documentation follows fixed path rules with known gaps (see the protocol); commit subjects can name the files they changed.',
    '- Intervals from at most 50 commits of one repository are approximate; commits are not independent draws.',
    '- The decision applies the registered rules once; nothing was tuned.',
    '',
  );
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

const METHODS_ORDER = METHODS;

function caseRow(c: CaseResult): string[] {
  const test = c.targets.filter((t) => t.kind === 'test').length;
  const doc = c.targets.filter((t) => t.kind === 'doc').length;
  const missing = c.targets.filter((t) => t.missingReason !== null).length;
  return [
    `\`${short(c.commit)}\``,
    `${test} / ${doc}`,
    String(missing),
    ...METHODS_ORDER.map((m) => {
      const x = c.methods[m];
      if (x.status === 'not_run') return 'not run';
      if (x.status === 'failed') return `failed (${x.failure!.stage})`;
      const ranks = Object.values(x.targetRanks!).filter((rank): rank is number => rank !== null);
      return ranks.length === 0 ? 'none' : `@${Math.min(...ranks)}`;
    }),
  ];
}

function stratumSection(label: string, s: StratumSummary, methods: readonly string[], compared: readonly string[]): string[] {
  const out = [`### ${label}`, ''];
  if (!s.available) return [...out, 'Unavailable: no commit has a target in this stratum.', ''];
  out.push(`Population: ${s.populationSize} commit(s).`, '');
  out.push(
    ...table(
      ['Method', ...METRICS.map((m) => METRIC_LABEL[m])],
      methods.map((method) => [METHOD_LABEL[method]!, ...METRICS.map((m) => cell(s.methods[method as keyof typeof s.methods]![m]))]),
    ),
  );
  out.push(
    ...table(
      ['Hybrid minus', ...METRICS.map((m) => METRIC_LABEL[m])],
      compared.map((method) => [METHOD_LABEL[method]!, ...METRICS.map((m) => cell(s.differences[method as keyof typeof s.differences]![m]))]),
    ),
  );
  return out;
}
