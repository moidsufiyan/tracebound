import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '../m9/canonical.js';
import { fileIdentity } from '../m9/freeze-database.js';
import { MAIN_SEED, mulberry32, REPLICATES, SENSITIVITY_SEED, INTERVAL_PERCENTILES, type BootstrapSample } from './bootstrap.js';
import { decide, BASELINES, type Baseline, type Comparison, type Decision } from './decision.js';
import { PRIMARY_METHODS, verifyRecords } from './evaluate.js';
import {
  inspectJournal,
  journalKeys,
  validateHeader,
  type CochangeJournal,
  type EvaluationFailure,
  type EvaluationHeader,
  type EvaluationRecord,
  type PreparationHeader,
  type PreparationRecord,
} from './journal.js';
import { acquireWorkLock, LockLostError, releaseWorkLock, verifyWorkLock, type LockAcquisition, type WorkLock } from './lock.js';
import {
  commitMetrics,
  drawStrataSamples,
  METRIC_SCALE,
  METRICS,
  pairedDifferences,
  RECALL_KS,
  STRATA,
  stratumTargets,
  summarize,
  toRate,
  type CommitStratumMetrics,
  type MacroValue,
  type Metric,
  type Stratum,
} from './metrics.js';
import { canonicalPath, REGISTERED, validateManifest, WORK_FILES, type Registration } from './preflight.js';
import { SCORED_DEPTH } from './rankings.js';
import { PROTOCOL, type CochangeManifest, type SelectedCommit } from './selector.js';

// Results assembly of the co-change evaluation (protocol 1.0.0, sections 5 and 6): reads the
// complete evaluation journal, checks it against everything it depends on, and computes the
// registered metrics, bootstrap intervals and outcome with the core modules (metrics.ts,
// bootstrap.ts, decision.ts). It runs no retrieval and writes nothing but the run lock, which it
// holds while reading so that no phase appends meanwhile.
//
// What is computed, and when:
// - Case level, always: for every selected commit, every method's status ('succeeded', 'failed',
//   or 'not_run' when its base's preparation failed, so it was never attempted), the position of
//   each target in its whole ranking, and its per-stratum metrics.
// - Primary estimates, only when the primary run is complete (hybrid, deterministic-only,
//   semantic-only and the sibling heuristic succeeded on every selected commit): macro averages
//   and paired percentile-bootstrap intervals for every method, metric and stratum, with the
//   main generator, and the decision of section 6. Otherwise no primary aggregate is computed at
//   all, from any subset, and the outcome is Inconclusive (rule 1). The sibling heuristic is
//   included because the confirmatory comparison needs it on every commit (the S4 reading).
// - Sensitivity (no-description arm), always as registered: on the common population C (commits
//   where both ordinary hybrid and the arm succeeded), per stratum C_s, with the sensitivity
//   generator. It is descriptive and never enters the decision.
//
// Error messages recorded in the journals can hold machine paths; results keep only the stage and
// error name of a failure.

export const RESULTS_SCHEMA = 'tracebound.cochange.results';
export const RESULTS_SCHEMA_VERSION = '1.0.0';
const METHODS = ['hybrid', 'deterministic', 'semantic', 'sibling', 'no-description'] as const;
type Method = (typeof METHODS)[number];
const RANKING_KEY: Record<Method, string> = {
  hybrid: 'hybridPaths',
  deterministic: 'deterministicPaths',
  semantic: 'semanticPaths',
  sibling: 'siblingPaths',
  'no-description': 'noDescriptionPaths',
};
/** The methods whose success on every commit the primary analysis needs. */
const PRIMARY_ANALYSIS_METHODS: readonly Method[] = [...PRIMARY_METHODS, 'sibling'];

export interface AssemblyRequest {
  workDirectory: string;
  /** The frozen manifest file (docs/evaluation/cochange/manifest.json). */
  manifestPath: string;
}

export interface AssemblyDependencies {
  registration?: Registration;
}

export type AssemblyRefusal =
  | 'work-directory-missing'
  | 'manifest-mismatch'
  | 'evaluation-journal-missing'
  | 'evaluation-journal-invalid'
  | 'evaluation-journal-interrupted'
  | 'evaluation-incomplete'
  | 'preparation-journal-invalid'
  | 'frozen-database-mismatch'
  | 'evaluation-records-invalid'
  | 'lock-lost';

export type AssemblyResult =
  | { status: 'assembled'; results: CochangeResults; canonical: string; sha256: string }
  | { status: 'locked'; lock: Exclude<LockAcquisition, { status: 'acquired' }> }
  | { status: 'refused'; reason: AssemblyRefusal; detail: string };

export type MethodStatus = 'succeeded' | 'failed' | 'not_run';

export interface StatisticSummary {
  /** Exact macro value: sum / (scale × populationSize). */
  point: MacroValue;
  rate: number;
  /** The 95% percentile interval in replicate-sum units (sign as the rate's), and as rates. */
  interval: { lower: number; upper: number };
  intervalRate: { lower: number; upper: number };
}

export type StratumSummary =
  | { available: false; populationSize: 0 }
  | {
      available: true;
      populationSize: number;
      /** Population members, in manifest order. */
      commits: string[];
      methods: Partial<Record<Method, Record<Metric, StatisticSummary>>>;
      /** Paired differences: hybrid minus the named method. */
      differences: Partial<Record<Method, Record<Metric, StatisticSummary>>>;
    };

export interface CaseMethod {
  status: MethodStatus;
  failure: { stage: EvaluationFailure['stage']; errorName: string } | null;
  /** 1-based position of each target in the method's whole ranking after input removal; null when absent. */
  targetRanks: Record<string, number | null> | null;
  /** Per stratum; null when the commit has no target in the stratum, when the method has no ranking, or when the link stratum is unknown. */
  metrics: Record<Stratum, CommitStratumMetrics | null> | null;
}

export interface CaseResult {
  commit: string;
  base: string;
  snapshotId: number | null;
  preparation: unknown;
  targets: { path: string; kind: 'test' | 'doc'; linked: boolean | null; missingReason: string | null }[];
  /** Whether the structural links of the inputs are known (they are when the base was prepared). */
  linksKnown: boolean;
  /** Whether the commit has a target in each stratum; null for the link strata when the links are unknown. */
  strata: Record<Stratum, boolean | null>;
  methods: Record<Method, CaseMethod>;
}

export interface CochangeResults {
  schema: typeof RESULTS_SCHEMA;
  schemaVersion: typeof RESULTS_SCHEMA_VERSION;
  protocol: { path: string; version: string };
  provenance: {
    manifestSha256: string;
    repository: { name: string; head: string };
    tracebound: EvaluationHeader['tracebound'];
    nodeVersion: string;
    embeddingModelId: string;
    frozenDatabaseSha256: string;
    preparationJournalSha256: string;
    evaluationJournalSha256: string;
  };
  conventions: {
    metricScale: number;
    recallKs: readonly number[];
    scoredDepth: number;
    replicates: number;
    intervalPercentiles: { lower: number; upper: number };
    mainSeed: number;
    sensitivitySeed: number;
    strataOrder: readonly Stratum[];
  };
  /** 'primary-incomplete' means the primary outcome is Inconclusive by rule 1 and no primary aggregate exists. */
  status: 'complete' | 'primary-incomplete';
  run: {
    commits: number;
    primaryTestPopulation: number;
    primaryIncompleteCommits: string[];
    methodFailures: Record<Method, { failed: string[]; notRun: string[] }>;
  };
  cases: CaseResult[];
  primary: { estimated: false; reason: 'primary-incomplete' } | { estimated: true; strata: Record<Stratum, StratumSummary> };
  sensitivity: {
    descriptive: true;
    commonPopulation: string[];
    ordinaryHybridUnsuccessful: string[];
    noDescriptionFailed: string[];
    noDescriptionNotRun: string[];
    strata: Record<Stratum, StratumSummary>;
  };
  decision: Decision;
}

class Refusal extends Error {
  readonly reason: AssemblyRefusal;
  constructor(reason: AssemblyRefusal, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

/** Checks the evaluation and computes its results. Changes no journal or database. */
export async function assembleResults(request: AssemblyRequest, dependencies: AssemblyDependencies = {}): Promise<AssemblyResult> {
  const work = canonicalPath(request.workDirectory);
  if (!existsSync(work)) return { status: 'refused', reason: 'work-directory-missing', detail: `${work} does not exist` };
  const acquisition = acquireWorkLock(work, 'cochange results assembly');
  if (acquisition.status !== 'acquired') return { status: 'locked', lock: acquisition };
  try {
    return await assembleResultsHeld(acquisition.lock, request, dependencies);
  } finally {
    try {
      releaseWorkLock(acquisition.lock);
    } catch (error) {
      if (!(error instanceof LockLostError)) throw error;
    }
  }
}

/**
 * The same assembly for a caller that already holds the work-directory lock (for example the
 * publication step, whose critical section also covers writing the artifacts). It takes no lock
 * itself, never releases `lock`, and verifies it is still held before computing.
 */
export async function assembleResultsHeld(lock: WorkLock, request: AssemblyRequest, dependencies: AssemblyDependencies = {}): Promise<Exclude<AssemblyResult, { status: 'locked' }>> {
  try {
    const inputs = await readVerifiedInputs(canonicalPath(request.workDirectory), request, dependencies.registration ?? REGISTERED);
    try {
      verifyWorkLock(lock);
    } catch (error) {
      if (error instanceof LockLostError) throw new Refusal('lock-lost', error.message);
      throw error;
    }
    const results = computeResults(inputs);
    const canonical = canonicalJson(results);
    return { status: 'assembled', results, canonical, sha256: sha256Hex(canonical) };
  } catch (error) {
    if (error instanceof Refusal) return { status: 'refused', reason: error.reason, detail: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Inputs

interface VerifiedInputs {
  manifest: CochangeManifest;
  manifestSha256: string;
  header: EvaluationHeader;
  evaluation: Map<string, EvaluationRecord>;
  preparation: Map<string, PreparationRecord>;
  preparationJournalSha256: string;
  evaluationJournalSha256: string;
}

async function readVerifiedInputs(work: string, request: AssemblyRequest, registration: Registration): Promise<VerifiedInputs> {
  // The manifest: the registered bytes, and every invariant the selector guarantees.
  let manifest: CochangeManifest;
  const manifestBytes = readFileSync(request.manifestPath);
  const manifestSha256 = sha256Hex(manifestBytes);
  if (manifestSha256 !== registration.manifestSha256) throw new Refusal('manifest-mismatch', `The manifest is ${manifestSha256}, not the registered ${registration.manifestSha256}`);
  try {
    manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')), registration);
  } catch (error) {
    throw new Refusal('manifest-mismatch', `The manifest is not valid: ${messageOf(error)}`);
  }

  // The evaluation journal: its header must be for this manifest and repository; then the journal
  // must be valid against that header and complete. A torn tail is reported, never recovered here.
  const evaluationPath = join(work, WORK_FILES.evaluationJournal);
  if (!existsSync(evaluationPath)) throw new Refusal('evaluation-journal-missing', `${WORK_FILES.evaluationJournal} does not exist`);
  const evaluationBytes = readFileSync(evaluationPath);
  let header: EvaluationHeader;
  try {
    const firstLine = evaluationBytes.toString('utf8').split('\n')[0]!;
    const parsed = validateHeader(JSON.parse(firstLine));
    if (parsed.phase !== 'evaluation') throw new Error('the header is not an evaluation header');
    header = parsed;
  } catch (error) {
    throw new Refusal('evaluation-journal-invalid', `${WORK_FILES.evaluationJournal} has no valid evaluation header: ${messageOf(error)}`);
  }
  if (header.manifestSha256 !== manifestSha256 || header.repository.name !== manifest.repository.name || header.repository.head !== manifest.repository.head) {
    throw new Refusal('evaluation-journal-invalid', `${WORK_FILES.evaluationJournal} was written for another manifest or repository`);
  }
  if (header.protocolVersion !== PROTOCOL.version) throw new Refusal('evaluation-journal-invalid', `${WORK_FILES.evaluationJournal} is for protocol ${header.protocolVersion}`);
  const evaluationJournal = completeJournal(evaluationPath, header, journalKeys(manifest, 'evaluation'), 'evaluation');

  // The preparation journal: the same run identity, complete.
  const { frozenDatabaseSha256: _frozen, ...common } = header;
  const preparationHeader: PreparationHeader = { ...common, phase: 'preparation' };
  const preparationPath = join(work, WORK_FILES.preparationJournal);
  if (!existsSync(preparationPath)) throw new Refusal('preparation-journal-invalid', `${WORK_FILES.preparationJournal} does not exist`);
  const preparationJournal = completeJournal(preparationPath, preparationHeader, journalKeys(manifest, 'preparation'), 'preparation');

  // The frozen database the evaluation read: the recorded bytes.
  const frozenPath = join(work, WORK_FILES.frozenDatabase);
  if (!existsSync(frozenPath)) throw new Refusal('frozen-database-mismatch', `${WORK_FILES.frozenDatabase} does not exist`);
  const frozen = await fileIdentity(frozenPath);
  if (frozen.sha256 !== header.frozenDatabaseSha256) throw new Refusal('frozen-database-mismatch', `${WORK_FILES.frozenDatabase} is ${frozen.sha256}, not the ${header.frozenDatabaseSha256} the evaluation read`);

  // The records: the evaluation runner's own completion check, then the facts assembly relies on.
  const commits = new Map(manifest.commits.map((c) => [c.sha, c]));
  const preparation = new Map(preparationJournal.records.map((r) => [(r as PreparationRecord).base, r as PreparationRecord]));
  try {
    verifyRecords(evaluationJournal, commits, preparation);
  } catch (error) {
    throw new Refusal('evaluation-records-invalid', messageOf(error));
  }
  const evaluation = new Map(evaluationJournal.records.map((r) => [(r as EvaluationRecord).commit, r as EvaluationRecord]));
  for (const commit of manifest.commits) checkRecordFacts(commit, evaluation.get(commit.sha)!, preparation.get(commit.base)!);

  // The bytes hashed are the bytes checked: the journals must not have changed while being read.
  const evaluationJournalSha256 = sha256Hex(readFileSync(evaluationPath));
  const preparationJournalSha256 = sha256Hex(readFileSync(preparationPath));
  if (evaluationJournalSha256 !== sha256Hex(evaluationBytes)) throw new Refusal('evaluation-journal-invalid', `${WORK_FILES.evaluationJournal} changed while it was read`);
  return { manifest, manifestSha256, header, evaluation, preparation, preparationJournalSha256, evaluationJournalSha256 };
}

function completeJournal(path: string, header: EvaluationHeader | PreparationHeader, keys: string[], phase: 'evaluation' | 'preparation'): CochangeJournal {
  const reasonFor = (kind: 'invalid' | 'interrupted' | 'incomplete'): AssemblyRefusal =>
    phase === 'preparation' ? 'preparation-journal-invalid' : kind === 'invalid' ? 'evaluation-journal-invalid' : kind === 'interrupted' ? 'evaluation-journal-interrupted' : 'evaluation-incomplete';
  const inspection = inspectJournal(path, { header, keys });
  if (inspection.status === 'invalid') throw new Refusal(reasonFor('invalid'), `${path}: ${inspection.reason}: ${inspection.detail}`);
  if (inspection.status === 'interrupted') {
    throw new Refusal(reasonFor('interrupted'), `${path} ends in a torn line; recover it with the run that wrote it (${inspection.records.length} records are complete)`);
  }
  if (inspection.journal.next !== null) {
    throw new Refusal(reasonFor('incomplete'), `${path} records ${inspection.journal.records.length} of ${keys.length}; the missing ones were never evaluated, so they are neither results nor failures`);
  }
  return inspection.journal;
}

/** Links and missing targets must be about the commit's own targets, and links exactly when the base was prepared. */
function checkRecordFacts(commit: SelectedCommit, record: EvaluationRecord, prepared: PreparationRecord): void {
  const evidence = record.evidence as { linkedTargetPaths?: unknown; missingTargets?: unknown };
  const fail = (detail: string) => new Refusal('evaluation-records-invalid', `The record of ${commit.sha} ${detail}`);
  const testTargets = new Set(commit.targets.filter((t) => t.kind === 'test').map((t) => t.path));
  const allTargets = new Set(commit.targets.map((t) => t.path));
  const links = evidence.linkedTargetPaths;
  if (prepared.status === 'succeeded') {
    if (!Array.isArray(links) || links.some((path) => typeof path !== 'string' || !testTargets.has(path)) || new Set(links).size !== links.length) {
      throw fail('does not list its linked test targets correctly');
    }
  } else if (links !== undefined) throw fail('lists links for a base that was not prepared');
  const missing = evidence.missingTargets;
  if (missing !== undefined && (!Array.isArray(missing) || missing.some((m) => typeof m?.path !== 'string' || !allTargets.has(m.path) || typeof m?.reason !== 'string'))) {
    throw fail('lists missing targets that are not its targets');
  }
}

// ---------------------------------------------------------------------------------------------
// Computation (pure)

function computeResults(inputs: VerifiedInputs): CochangeResults {
  const { manifest, header } = inputs;
  const cases = manifest.commits.map((commit) => caseResult(commit, inputs.evaluation.get(commit.sha)!));

  const methodFailures = Object.fromEntries(
    METHODS.map((method) => [
      method,
      {
        failed: cases.filter((c) => c.methods[method].status === 'failed').map((c) => c.commit),
        notRun: cases.filter((c) => c.methods[method].status === 'not_run').map((c) => c.commit),
      },
    ]),
  ) as Record<Method, { failed: string[]; notRun: string[] }>;
  const primaryIncompleteCommits = cases.filter((c) => PRIMARY_ANALYSIS_METHODS.some((m) => c.methods[m].status !== 'succeeded')).map((c) => c.commit);
  const complete = primaryIncompleteCommits.length === 0;
  const primaryTestPopulation = manifest.commits.filter((c) => c.targets.some((t) => t.kind === 'test')).length;

  let primary: CochangeResults['primary'];
  let decision: Decision;
  if (!complete) {
    primary = { estimated: false, reason: 'primary-incomplete' };
    decision = decide({ incompleteRun: true, primaryPopulation: primaryTestPopulation, comparisons: null });
  } else {
    const strata = aggregate(cases, ['hybrid', 'deterministic', 'semantic', 'sibling'], BASELINES, MAIN_SEED);
    primary = { estimated: true, strata };
    const test = strata.test;
    const comparisons: Record<Baseline, Comparison> | null = test.available
      ? (Object.fromEntries(
          BASELINES.map((baseline) => {
            const d = test.differences[baseline]!.recall10;
            return [baseline, { difference: d.point, interval: d.interval }];
          }),
        ) as Record<Baseline, Comparison>)
      : null;
    decision = decide({ incompleteRun: false, primaryPopulation: primaryTestPopulation, comparisons });
  }

  const common = cases.filter((c) => c.methods.hybrid.status === 'succeeded' && c.methods['no-description'].status === 'succeeded');
  const sensitivity: CochangeResults['sensitivity'] = {
    descriptive: true,
    commonPopulation: common.map((c) => c.commit),
    ordinaryHybridUnsuccessful: cases.filter((c) => c.methods.hybrid.status !== 'succeeded').map((c) => c.commit),
    noDescriptionFailed: methodFailures['no-description'].failed,
    noDescriptionNotRun: methodFailures['no-description'].notRun,
    strata: aggregate(common, ['hybrid', 'no-description'], ['no-description'], SENSITIVITY_SEED),
  };

  return {
    schema: RESULTS_SCHEMA,
    schemaVersion: RESULTS_SCHEMA_VERSION,
    protocol: { path: PROTOCOL.path, version: PROTOCOL.version },
    provenance: {
      manifestSha256: inputs.manifestSha256,
      repository: header.repository,
      tracebound: header.tracebound,
      nodeVersion: header.nodeVersion,
      embeddingModelId: header.embeddingModelId,
      frozenDatabaseSha256: header.frozenDatabaseSha256,
      preparationJournalSha256: inputs.preparationJournalSha256,
      evaluationJournalSha256: inputs.evaluationJournalSha256,
    },
    conventions: {
      metricScale: METRIC_SCALE,
      recallKs: RECALL_KS,
      scoredDepth: SCORED_DEPTH,
      replicates: REPLICATES,
      intervalPercentiles: { ...INTERVAL_PERCENTILES },
      mainSeed: MAIN_SEED,
      sensitivitySeed: SENSITIVITY_SEED,
      strataOrder: STRATA,
    },
    status: complete ? 'complete' : 'primary-incomplete',
    run: { commits: cases.length, primaryTestPopulation, primaryIncompleteCommits, methodFailures },
    cases,
    primary,
    sensitivity,
    decision,
  };
}

function caseResult(commit: SelectedCommit, record: EvaluationRecord): CaseResult {
  const evidence = record.evidence as {
    snapshotId: number | null;
    preparation: unknown;
    linkedTargetPaths?: string[];
    missingTargets?: { path: string; reason: string }[];
    rankings: Record<string, string[] | undefined>;
  };
  const linksKnown = Array.isArray(evidence.linkedTargetPaths);
  const linked = new Set(evidence.linkedTargetPaths ?? []);
  const missing = new Map((evidence.missingTargets ?? []).map((m) => [m.path, m.reason]));
  const targetsByStratum = stratumTargets(commit.targets, linked);
  const isLinkStratum = (stratum: Stratum) => stratum === 'test-with-link' || stratum === 'test-without-link';
  const strata = Object.fromEntries(STRATA.map((stratum) => [stratum, isLinkStratum(stratum) && !linksKnown ? null : targetsByStratum[stratum].length > 0])) as Record<Stratum, boolean | null>;

  const methods = Object.fromEntries(
    METHODS.map((method): [Method, CaseMethod] => {
      const failure = record.failures.find((f) => f.method === method);
      const ranking = evidence.rankings[RANKING_KEY[method]];
      if (failure) {
        // A failure at the preparation stage means the method was never attempted.
        return [method, { status: failure.stage === 'preparation' ? 'not_run' : 'failed', failure: { stage: failure.stage, errorName: failure.errorName }, targetRanks: null, metrics: null }];
      }
      const targetRanks = Object.fromEntries(commit.targets.map((t) => [t.path, ranking!.indexOf(t.path) >= 0 ? ranking!.indexOf(t.path) + 1 : null]));
      const metrics = Object.fromEntries(
        STRATA.map((stratum) => [stratum, strata[stratum] === null ? null : commitMetrics(targetsByStratum[stratum], ranking!)]),
      ) as Record<Stratum, CommitStratumMetrics | null>;
      return [method, { status: 'succeeded', failure: null, targetRanks, metrics }];
    }),
  ) as Record<Method, CaseMethod>;

  return {
    commit: commit.sha,
    base: commit.base,
    snapshotId: evidence.snapshotId,
    preparation: evidence.preparation,
    targets: commit.targets.map((t) => ({ path: t.path, kind: t.kind, linked: t.kind === 'test' && linksKnown ? linked.has(t.path) : null, missingReason: missing.get(t.path) ?? null })),
    linksKnown,
    strata,
    methods,
  };
}

/**
 * Macro values and paired 95% intervals per stratum over `population` (cases in manifest order):
 * each stratum's members are the population's commits with at least one target in it (section 5). One
 * generator is created with `seed` and consumed stratum after stratum in the registered order; its
 * draws are shared by every method, metric and difference of the stratum. A stratum without
 * members is unavailable and draws nothing.
 */
function aggregate(
  population: readonly CaseResult[],
  methods: readonly Method[],
  comparedWith: readonly Method[],
  seed: number,
): Record<Stratum, StratumSummary> {
  const members = Object.fromEntries(
    STRATA.map((stratum) => [
      stratum,
      population.filter((c) => {
        if (c.strata[stratum] === null) throw new Error(`${c.commit}: membership of ${stratum} is unknown although the commit is in the population`);
        return c.strata[stratum];
      }),
    ]),
  ) as Record<Stratum, CaseResult[]>;
  const sizes = Object.fromEntries(STRATA.map((stratum) => [stratum, members[stratum].length])) as Record<Stratum, number>;
  const samples = drawStrataSamples(mulberry32(seed), sizes);

  return Object.fromEntries(
    STRATA.map((stratum): [Stratum, StratumSummary] => {
      const sample = samples[stratum];
      if (sample === 'unavailable') return [stratum, { available: false, populationSize: 0 }];
      const cases = members[stratum];
      const valuesOf = (method: Method, metric: Metric) =>
        cases.map((c) => {
          const metrics = c.methods[method].metrics?.[stratum];
          if (!metrics) throw new Error(`${c.commit}: ${method} has no ${stratum} metrics although the commit is in the population`);
          return metrics.scaled[metric];
        });
      const summaryOf = (values: number[]) => summary(sample, values);
      return [
        stratum,
        {
          available: true,
          populationSize: cases.length,
          commits: cases.map((c) => c.commit),
          methods: Object.fromEntries(methods.map((method) => [method, Object.fromEntries(METRICS.map((metric) => [metric, summaryOf(valuesOf(method, metric))]))])),
          differences: Object.fromEntries(
            comparedWith.map((other) => [other, Object.fromEntries(METRICS.map((metric) => [metric, summaryOf(pairedDifferences(valuesOf('hybrid', metric), valuesOf(other, metric)))]))]),
          ),
        },
      ];
    }),
  ) as Record<Stratum, StratumSummary>;
}

function summary(sample: BootstrapSample, values: number[]): StatisticSummary {
  const { point, interval } = summarize(sample, values);
  const denominator = point.scale * point.populationSize;
  return { point, rate: toRate(point), interval, intervalRate: { lower: interval.lower / denominator, upper: interval.upper / denominator } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
