import type { RelationshipKind } from '../../analysis/relationships.js';
import { drawBootstrapSample, percentileInterval, REPLICATES, replicateSums, type BootstrapSample, type UniformGenerator } from './bootstrap.js';
import { SCORED_DEPTH } from './rankings.js';
import type { SelectedCommit } from './selector.js';

// Per-commit metrics, strata and macro averages of the co-change evaluation (protocol section 5).
// Every per-commit value is an exact integer: the metric multiplied by METRIC_SCALE. A commit has
// at most 10 targets and MRR@20 takes 1 / rank with rank <= 20, so every denominator divides
// lcm(1..20). Sums are exact; the only conversion to a fraction is `toRate`, for reports.

/** lcm(1, ..., 20): every Recall@K and MRR@20 value times this is an integer. */
export const METRIC_SCALE = 232_792_560;
export const RECALL_KS = [3, 5, 10, 20] as const;
/** The strata in the registered bootstrap order: primary test, doc, test with and without a structural link. */
export const STRATA = ['test', 'doc', 'test-with-link', 'test-without-link'] as const;
export type Stratum = (typeof STRATA)[number];
export const METRICS = ['recall3', 'recall5', 'recall10', 'recall20', 'mrr20'] as const;
export type Metric = (typeof METRICS)[number];

/** The relationship facts the structural-link stratum needs: `source` imports `target`. */
export interface LinkRelationship {
  kind: RelationshipKind;
  source: { path: string };
  target: { path: string };
}

/**
 * The test targets joined to an input by an `imports` or `test-to-source` relationship of the base
 * snapshot, in either direction. Pass the relationships of the input artifacts in both directions
 * (findIncomingRelationships and findOutgoingRelationships with the inputs' artifact ids).
 */
export function linkedTargets(inputs: readonly string[], testTargets: readonly string[], relationships: readonly LinkRelationship[]): Set<string> {
  const inputSet = new Set(inputs);
  const targetSet = new Set(testTargets);
  const linked = new Set<string>();
  for (const { kind, source, target } of relationships) {
    if (kind !== 'imports' && kind !== 'test-to-source') continue;
    if (inputSet.has(source.path) && targetSet.has(target.path)) linked.add(target.path);
    if (inputSet.has(target.path) && targetSet.has(source.path)) linked.add(source.path);
  }
  return linked;
}

/** The commit's targets per stratum. Doc targets are never in a link stratum. */
export function stratumTargets(targets: SelectedCommit['targets'], linked: ReadonlySet<string>): Record<Stratum, string[]> {
  const tests = targets.filter((t) => t.kind === 'test').map((t) => t.path);
  return {
    test: tests,
    doc: targets.filter((t) => t.kind === 'doc').map((t) => t.path),
    'test-with-link': tests.filter((path) => linked.has(path)),
    'test-without-link': tests.filter((path) => !linked.has(path)),
  };
}

export interface CommitStratumMetrics {
  targetCount: number;
  /** Targets found within the first K entries. */
  found: Record<(typeof RECALL_KS)[number], number>;
  /** Position of the first target in the post-removal list, or null if none is listed. */
  firstRank: number | null;
  /** Each metric times METRIC_SCALE, exactly. */
  scaled: Record<Metric, number>;
}

/**
 * The metrics of one commit in one stratum, from the whole post-removal ranking (paths, best
 * first). Null when the stratum has no target in this commit: the commit is not in its population.
 * A target missing from the ranking is a miss and stays in the denominator.
 */
export function commitMetrics(targets: readonly string[], ranking: readonly string[]): CommitStratumMetrics | null {
  const unique = new Set(targets);
  if (unique.size !== targets.length) throw new RangeError('A stratum lists a target more than once');
  if (targets.length === 0) return null;
  const positions = new Map<string, number>();
  ranking.forEach((path, index) => {
    if (positions.has(path)) throw new RangeError(`The ranking lists ${JSON.stringify(path)} more than once`);
    positions.set(path, index + 1);
  });

  const ranks = targets.map((path) => positions.get(path) ?? null).filter((rank): rank is number => rank !== null);
  const firstRank = ranks.length === 0 ? null : Math.min(...ranks);
  const foundWithin = (k: number) => ranks.filter((rank) => rank <= k).length;
  const found = { 3: foundWithin(3), 5: foundWithin(5), 10: foundWithin(10), 20: foundWithin(20) };
  const n = targets.length;
  const scaled = {
    recall3: exactQuotient(found[3] * METRIC_SCALE, n),
    recall5: exactQuotient(found[5] * METRIC_SCALE, n),
    recall10: exactQuotient(found[10] * METRIC_SCALE, n),
    recall20: exactQuotient(found[20] * METRIC_SCALE, n),
    mrr20: firstRank !== null && firstRank <= SCORED_DEPTH ? exactQuotient(METRIC_SCALE, firstRank) : 0,
  };
  return { targetCount: n, found, firstRank, scaled };
}

function exactQuotient(numerator: number, denominator: number): number {
  if (numerator % denominator !== 0) throw new RangeError(`${numerator} / ${denominator} is not an integer; the metric scale does not cover this denominator`);
  return numerator / denominator;
}

/** Positions (in manifest order) of the commits that are members of a stratum. Empty means unavailable. */
export function stratumPopulation(perCommit: readonly (CommitStratumMetrics | null)[]): number[] {
  return perCommit.flatMap((metrics, index) => (metrics === null ? [] : [index]));
}

/** An exact macro average: sum / (scale × populationSize). */
export interface MacroValue {
  sum: number;
  populationSize: number;
  scale: number;
}

export function macro(values: readonly number[]): MacroValue {
  if (values.length === 0) throw new RangeError('An empty population has no macro average');
  let sum = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${value} is not a safe integer`);
    sum += value;
  }
  if (!Number.isSafeInteger(sum)) throw new RangeError('The sum exceeds the safe integer range');
  return { sum, populationSize: values.length, scale: METRIC_SCALE };
}

/** Per-commit paired differences a − b of two methods over the same population. */
export function pairedDifferences(a: readonly number[], b: readonly number[]): number[] {
  if (a.length !== b.length) throw new RangeError(`Paired values differ in length: ${a.length} and ${b.length}`);
  return a.map((value, i) => value - b[i]!);
}

/** The macro average as a number, for reports only; decisions use the exact sum. */
export function toRate(value: MacroValue): number {
  return value.sum / (value.scale * value.populationSize);
}

/**
 * One bootstrap sample per stratum, drawn in the registered STRATA order from `generator`, which
 * the caller owns and keeps across strata. A stratum of size 0 is unavailable and draws nothing.
 * Pass the main generator with the main populations, or the sensitivity generator with the
 * common populations C_s.
 */
export function drawStrataSamples(
  generator: UniformGenerator,
  sizes: Readonly<Record<Stratum, number>>,
  replicates: number = REPLICATES,
): Record<Stratum, BootstrapSample | 'unavailable'> {
  const samples = {} as Record<Stratum, BootstrapSample | 'unavailable'>;
  for (const stratum of STRATA) {
    samples[stratum] = sizes[stratum] === 0 ? 'unavailable' : drawBootstrapSample(generator, sizes[stratum], replicates);
  }
  return samples;
}

/** A statistic over a stratum's population: its exact macro value and 95% interval, in scaled-sum units (sign as the rate's). */
export interface StratumStatistic {
  point: MacroValue;
  interval: { lower: number; upper: number };
}

/**
 * The point estimate and percentile interval of per-member values (one method's metric, or a paired
 * difference) on the stratum's sample. The interval is in units of replicate sums: divide by
 * scale × populationSize for a rate; its sign is the rate's.
 */
export function summarize(sample: BootstrapSample, values: readonly number[]): StratumStatistic {
  return { point: macro(values), interval: percentileInterval(replicateSums(sample, values)) };
}
