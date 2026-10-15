import { describe, expect, it } from 'vitest';
import { BASELINES, decide, MINIMUM_TEST_POPULATION, type Comparison, type DecisionInput } from '../src/evaluation/cochange/decision.js';
import { METRIC_SCALE } from '../src/evaluation/cochange/metrics.js';

const L = METRIC_SCALE;
const M = 20;
/** A comparison with D = hundredths / 100 exactly, as a scaled sum over M commits (D = sum / (L × M)). */
const comparison = (d: { hundredths: number }, interval: [number, number]): Comparison => ({
  difference: { sum: (d.hundredths * L * M) / 100, populationSize: M, scale: L },
  interval: { lower: interval[0], upper: interval[1] },
});
const neutral = comparison({ hundredths: 0 }, [-1, 1]);
const input = (overrides: Partial<Record<'sibling' | 'deterministic' | 'semantic', Comparison>>, extra: Partial<DecisionInput> = {}): DecisionInput => ({
  incompleteRun: false,
  primaryPopulation: 47,
  comparisons: { sibling: neutral, deterministic: neutral, semantic: neutral, ...overrides },
  ...extra,
});
const ruleOf = (value: DecisionInput) => {
  const decision = decide(value);
  return `${decision.outcome}/${decision.rule}`;
};

describe('the decision rules', () => {
  it('uses the registered minimum and baselines', () => {
    expect(MINIMUM_TEST_POPULATION).toBe(20);
    expect(BASELINES).toEqual(['sibling', 'deterministic', 'semantic']);
  });

  it('decides each row of the table', () => {
    const strongWin = comparison({ hundredths: 15 }, [10, 30]);
    const smallWin = comparison({ hundredths: 5 }, [1, 9]);
    const baselineMuchBetter = comparison({ hundredths: -8 }, [-20, -1]);
    expect(ruleOf(input({ sibling: strongWin }))).toBe('supported/supported');
    expect(ruleOf(input({ sibling: smallWin }))).toBe('mixed/mixed-small-effect');
    expect(ruleOf(input({ sibling: strongWin, semantic: baselineMuchBetter }))).toBe('mixed/mixed-baseline');
    expect(ruleOf(input({ sibling: baselineMuchBetter }))).toBe('negative/negative-sibling');
    expect(ruleOf(input({ deterministic: baselineMuchBetter }))).toBe('negative/negative-baseline');
    expect(ruleOf(input({}))).toBe('inconclusive/none-applies');
  });

  it('lets the incomplete-run rule override everything', () => {
    const strongWin = comparison({ hundredths: 15 }, [10, 30]);
    expect(ruleOf(input({ sibling: strongWin }, { incompleteRun: true }))).toBe('inconclusive/incomplete-run');
    expect(ruleOf(input({ sibling: comparison({ hundredths: -8 }, [-20, -1]) }, { incompleteRun: true }))).toBe('inconclusive/incomplete-run');
    expect(ruleOf({ incompleteRun: true, primaryPopulation: 47, comparisons: null })).toBe('inconclusive/incomplete-run');
  });

  it('lets the minimum test population override everything else', () => {
    const strongWin = comparison({ hundredths: 15 }, [10, 30]);
    expect(ruleOf(input({ sibling: strongWin }, { primaryPopulation: 19 }))).toBe('inconclusive/minimum-test-targets');
    expect(ruleOf(input({ sibling: strongWin }, { primaryPopulation: 20 }))).toBe('supported/supported');
    expect(ruleOf({ incompleteRun: false, primaryPopulation: 0, comparisons: null })).toBe('inconclusive/minimum-test-targets');
  });

  it('treats D exactly 0.10 as reaching the threshold, and just below as not', () => {
    const exact = { difference: { sum: 2 * L, populationSize: 20, scale: L }, interval: { lower: 1, upper: 5 } };
    expect(ruleOf(input({ sibling: exact }))).toBe('supported/supported');
    const below = { difference: { sum: 2 * L - 1, populationSize: 20, scale: L }, interval: { lower: 1, upper: 5 } };
    expect(ruleOf(input({ sibling: below }))).toBe('mixed/mixed-small-effect');
  });

  it('treats D exactly -0.05 as material, and just above as not', () => {
    const exact = { difference: { sum: -L, populationSize: 20, scale: L }, interval: { lower: -5, upper: -1 } };
    expect(ruleOf(input({ sibling: exact }))).toBe('negative/negative-sibling');
    const above = { difference: { sum: -L + 1, populationSize: 20, scale: L }, interval: { lower: -5, upper: -1 } };
    expect(ruleOf(input({ sibling: above }))).toBe('inconclusive/none-applies');
  });

  it('does not count an endpoint of exactly zero as above or below zero', () => {
    expect(ruleOf(input({ sibling: comparison({ hundredths: 15 }, [0, 30]) }))).toBe('inconclusive/none-applies');
    expect(ruleOf(input({ sibling: comparison({ hundredths: -8 }, [-20, 0]) }))).toBe('inconclusive/none-applies');
    expect(ruleOf(input({ deterministic: comparison({ hundredths: -8 }, [-20, 0]) }))).toBe('inconclusive/none-applies');
  });

  it('establishes no direction from an interval containing zero', () => {
    expect(ruleOf(input({ sibling: comparison({ hundredths: 15 }, [-3, 30]) }))).toBe('inconclusive/none-applies');
    expect(ruleOf(input({ sibling: comparison({ hundredths: -8 }, [-20, 4]) }))).toBe('inconclusive/none-applies');
  });

  it('never lets a single-source baseline establish support, only downgrade', () => {
    const baselineBeaten = comparison({ hundredths: 30 }, [10, 40]);
    expect(ruleOf(input({ deterministic: baselineBeaten, semantic: baselineBeaten }))).toBe('inconclusive/none-applies');
  });

  it('records the evidence the rules were applied to', () => {
    const decision = decide(input({ sibling: comparison({ hundredths: 15 }, [10, 30]) }));
    expect(decision.evidence!.sibling).toMatchObject({ intervalAboveZero: true, intervalBelowZero: false, atLeastTenth: true, materiallyOutperforms: false });
    expect(decision.evidence!.sibling.difference).toEqual({ sum: 3 * L, populationSize: 20, scale: L });
    expect(decision.primaryPopulation).toBe(47);
  });

  it('rejects malformed input', () => {
    expect(() => decide({ incompleteRun: false, primaryPopulation: 47, comparisons: null })).toThrow(RangeError);
    expect(() => decide(input({ sibling: comparison({ hundredths: 15 }, [30, 10]) }))).toThrow(RangeError);
    expect(() => decide(input({ sibling: { difference: { sum: 0.5, populationSize: 20, scale: L }, interval: { lower: 0, upper: 1 } } }))).toThrow(RangeError);
    expect(() => decide(input({ sibling: { difference: { sum: 1, populationSize: 0, scale: L }, interval: { lower: 0, upper: 1 } } }))).toThrow(RangeError);
    expect(() => decide(input({ sibling: comparison({ hundredths: 15 }, [Number.NaN, 1]) }))).toThrow(RangeError);
    expect(() => decide(input({}, { primaryPopulation: -1 }))).toThrow(RangeError);
  });
});

describe('the outcome table as a whole', () => {
  // Every combination of the predicates that matter, each realised by a concrete comparison.
  const siblingCases = {
    'large win, interval above 0': comparison({ hundredths: 12 }, [5, 20]),
    'small win, interval above 0': comparison({ hundredths: 4 }, [1, 9]),
    'large point, interval containing 0': comparison({ hundredths: 12 }, [-1, 20]),
    'sibling materially better': comparison({ hundredths: -6 }, [-20, -1]),
    'sibling slightly better, interval below 0': comparison({ hundredths: -2 }, [-9, -1]),
    'sibling materially better by point, interval containing 0': comparison({ hundredths: -6 }, [-20, 1]),
  };
  const baselineCases = {
    neutral,
    'materially better': comparison({ hundredths: -6 }, [-20, -1]),
    'better by point only': comparison({ hundredths: -6 }, [-20, 2]),
  };

  it('fires at most one of Negative, Supported and Mixed, and the precedence result matches the table', () => {
    for (const [siblingLabel, sibling] of Object.entries(siblingCases)) {
      for (const [deterministicLabel, deterministic] of Object.entries(baselineCases)) {
        for (const [semanticLabel, semantic] of Object.entries(baselineCases)) {
          const decision = decide(input({ sibling, deterministic, semantic }));
          const e = decision.evidence!;
          const beats = e.sibling.intervalAboveZero;
          const baselineMaterial = e.deterministic.materiallyOutperforms || e.semantic.materiallyOutperforms;
          const negative = e.sibling.materiallyOutperforms || (baselineMaterial && !beats);
          const supported = e.sibling.atLeastTenth && beats && !baselineMaterial;
          const mixed = (beats && !e.sibling.atLeastTenth) || (e.sibling.atLeastTenth && beats && baselineMaterial);
          const label = `${siblingLabel} / ${deterministicLabel} / ${semanticLabel}`;
          expect([negative, supported, mixed].filter(Boolean).length, label).toBeLessThanOrEqual(1);
          const expected = negative ? 'negative' : supported ? 'supported' : mixed ? 'mixed' : 'inconclusive';
          expect(decision.outcome, label).toBe(expected);
        }
      }
    }
  });
});
