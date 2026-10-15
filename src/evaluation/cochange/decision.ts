import type { MacroValue } from './metrics.js';

// The decision rules of the co-change evaluation (protocol section 6), applied in the registered
// precedence. Thresholds are checked on exact integers: D = sum / (scale × m), so D >= 0.10 is
// 10 × sum >= scale × m and D <= -0.05 is 20 × sum <= -(scale × m). Interval endpoints are in
// replicate-sum units, whose sign is the rate's; an endpoint of exactly 0 is neither above nor below.

export type Outcome = 'supported' | 'mixed' | 'negative' | 'inconclusive';
export type DecisionRule =
  | 'incomplete-run'
  | 'minimum-test-targets'
  | 'negative-sibling'
  | 'negative-baseline'
  | 'supported'
  | 'mixed-small-effect'
  | 'mixed-baseline'
  | 'none-applies';

export const BASELINES = ['sibling', 'deterministic', 'semantic'] as const;
export type Baseline = (typeof BASELINES)[number];
/** Selected commits with a test target needed for a conclusive outcome. */
export const MINIMUM_TEST_POPULATION = 20;

/** Hybrid minus a baseline on macro Recall@10 over test targets: exact point estimate and paired 95% interval. */
export interface Comparison {
  difference: MacroValue;
  interval: { lower: number; upper: number };
}

export interface DecisionInput {
  /** Hybrid, deterministic-only or semantic-only failed on a selected commit. */
  incompleteRun: boolean;
  /** Selected commits contributing at least one test target. */
  primaryPopulation: number;
  /** Null only when the run is incomplete or the population is below the minimum. */
  comparisons: Readonly<Record<Baseline, Comparison>> | null;
}

export interface ComparisonEvidence {
  difference: MacroValue;
  interval: { lower: number; upper: number };
  intervalAboveZero: boolean;
  intervalBelowZero: boolean;
  /** D >= 0.10 (meaningful for the sibling comparison). */
  atLeastTenth: boolean;
  /** The baseline materially outperforms hybrid: D <= -0.05 with the interval below zero. */
  materiallyOutperforms: boolean;
}

export interface Decision {
  outcome: Outcome;
  rule: DecisionRule;
  incompleteRun: boolean;
  primaryPopulation: number;
  evidence: Record<Baseline, ComparisonEvidence> | null;
}

export function decide(input: DecisionInput): Decision {
  if (!Number.isSafeInteger(input.primaryPopulation) || input.primaryPopulation < 0) {
    throw new RangeError(`The primary population must be a non-negative integer, received ${input.primaryPopulation}`);
  }
  const base = { incompleteRun: input.incompleteRun, primaryPopulation: input.primaryPopulation };
  const evidence = input.comparisons === null ? null : evaluate(input.comparisons);
  const result = (outcome: Outcome, rule: DecisionRule): Decision => ({ outcome, rule, ...base, evidence });

  if (input.incompleteRun) return result('inconclusive', 'incomplete-run');
  if (input.primaryPopulation < MINIMUM_TEST_POPULATION) return result('inconclusive', 'minimum-test-targets');
  if (evidence === null) throw new RangeError('A complete run with enough test targets needs the three comparisons');

  const sibling = evidence.sibling;
  const baselineMaterial = evidence.deterministic.materiallyOutperforms || evidence.semantic.materiallyOutperforms;
  const beatsSibling = sibling.intervalAboveZero;

  if (sibling.materiallyOutperforms) return result('negative', 'negative-sibling');
  if (baselineMaterial && !beatsSibling) return result('negative', 'negative-baseline');
  if (sibling.atLeastTenth && beatsSibling && !baselineMaterial) return result('supported', 'supported');
  if (beatsSibling && !sibling.atLeastTenth) return result('mixed', 'mixed-small-effect');
  if (sibling.atLeastTenth && beatsSibling && baselineMaterial) return result('mixed', 'mixed-baseline');
  return result('inconclusive', 'none-applies');
}

function evaluate(comparisons: Readonly<Record<Baseline, Comparison>>): Record<Baseline, ComparisonEvidence> {
  const out = {} as Record<Baseline, ComparisonEvidence>;
  for (const baseline of BASELINES) {
    const comparison = comparisons[baseline];
    if (!comparison) throw new RangeError(`The ${baseline} comparison is missing`);
    const { difference, interval } = comparison;
    const { sum, scale, populationSize } = difference;
    if (!Number.isSafeInteger(sum) || !Number.isSafeInteger(scale) || scale <= 0 || !Number.isSafeInteger(populationSize) || populationSize <= 0) {
      throw new RangeError(`The ${baseline} difference is not an exact macro value`);
    }
    if (!Number.isFinite(interval.lower) || !Number.isFinite(interval.upper) || interval.lower > interval.upper) {
      throw new RangeError(`The ${baseline} interval is malformed: [${interval.lower}, ${interval.upper}]`);
    }
    const denominator = safeProduct(scale, populationSize);
    const intervalBelowZero = interval.upper < 0;
    out[baseline] = {
      difference,
      interval,
      intervalAboveZero: interval.lower > 0,
      intervalBelowZero,
      atLeastTenth: safeProduct(10, sum) >= denominator,
      materiallyOutperforms: safeProduct(20, sum) <= -denominator && intervalBelowZero,
    };
  }
  return out;
}

function safeProduct(a: number, b: number): number {
  const product = a * b;
  if (!Number.isSafeInteger(product)) throw new RangeError(`${a} × ${b} exceeds the safe integer range`);
  return product;
}
