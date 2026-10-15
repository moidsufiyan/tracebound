import { describe, expect, it } from 'vitest';
import { MAIN_SEED, mulberry32, percentileInterval, replicateSums, type BootstrapSample } from '../src/evaluation/cochange/bootstrap.js';
import {
  commitMetrics,
  drawStrataSamples,
  linkedTargets,
  macro,
  METRIC_SCALE,
  pairedDifferences,
  STRATA,
  stratumPopulation,
  stratumTargets,
  summarize,
  toRate,
} from '../src/evaluation/cochange/metrics.js';

const L = METRIC_SCALE;
/** A ranking of `length` filler paths with the given paths placed at 1-based positions. */
function rankingWith(length: number, placed: Record<number, string>): string[] {
  return Array.from({ length }, (_, i) => placed[i + 1] ?? `filler/${i + 1}.ts`);
}

describe('the metric scale', () => {
  it('is lcm(1..20), so every registered denominator divides it', () => {
    expect(L).toBe(232_792_560);
    for (let d = 1; d <= 20; d += 1) expect(L % d).toBe(0);
  });
});

describe('per-commit metrics', () => {
  it('computes Recall@K and MRR@20 for one target', () => {
    const at = (rank: number) => commitMetrics(['t.ts'], rankingWith(25, { [rank]: 't.ts' }))!;
    expect(at(1).scaled).toEqual({ recall3: L, recall5: L, recall10: L, recall20: L, mrr20: L });
    expect(at(3).scaled).toEqual({ recall3: L, recall5: L, recall10: L, recall20: L, mrr20: L / 3 });
    expect(at(4).scaled).toEqual({ recall3: 0, recall5: L, recall10: L, recall20: L, mrr20: L / 4 });
    expect(at(10).scaled).toEqual({ recall3: 0, recall5: 0, recall10: L, recall20: L, mrr20: L / 10 });
    expect(at(11).scaled).toEqual({ recall3: 0, recall5: 0, recall10: 0, recall20: L, mrr20: L / 11 });
    expect(at(20).scaled).toEqual({ recall3: 0, recall5: 0, recall10: 0, recall20: L, mrr20: L / 20 });
    expect(at(21).scaled).toEqual({ recall3: 0, recall5: 0, recall10: 0, recall20: 0, mrr20: 0 });
    expect(at(21).firstRank).toBe(21);
  });

  it('divides by the stratum\'s target count and takes the first target for MRR', () => {
    // Three targets at ranks 2, 6 and 30.
    const metrics = commitMetrics(['a.ts', 'b.ts', 'c.ts'], rankingWith(40, { 2: 'b.ts', 6: 'a.ts', 30: 'c.ts' }))!;
    expect(metrics.targetCount).toBe(3);
    expect(metrics.found).toEqual({ 3: 1, 5: 1, 10: 2, 20: 2 });
    expect(metrics.firstRank).toBe(2);
    expect(metrics.scaled).toEqual({ recall3: L / 3, recall5: L / 3, recall10: (2 * L) / 3, recall20: (2 * L) / 3, mrr20: L / 2 });
  });

  it('handles seven targets exactly', () => {
    const targets = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
    const metrics = commitMetrics(targets, rankingWith(30, { 1: 't1', 5: 't2', 9: 't3', 12: 't4' }))!;
    expect(metrics.scaled).toEqual({ recall3: L / 7, recall5: (2 * L) / 7, recall10: (3 * L) / 7, recall20: (4 * L) / 7, mrr20: L });
    expect(Object.values(metrics.scaled).every(Number.isSafeInteger)).toBe(true);
  });

  it('counts a target missing from the ranking as a miss and keeps it in the denominator', () => {
    const metrics = commitMetrics(['found.ts', 'excluded.bin.ts'], rankingWith(5, { 1: 'found.ts' }))!;
    expect(metrics.scaled.recall20).toBe(L / 2);
    expect(commitMetrics(['gone.ts'], [])!.scaled).toEqual({ recall3: 0, recall5: 0, recall10: 0, recall20: 0, mrr20: 0 });
    expect(commitMetrics(['gone.ts'], [])!.firstRank).toBeNull();
  });

  it('returns null for a stratum the commit has no target in', () => {
    expect(commitMetrics([], rankingWith(5, {}))).toBeNull();
  });

  it('rejects duplicates and denominators the scale cannot represent exactly', () => {
    expect(() => commitMetrics(['a', 'a'], ['a'])).toThrow(RangeError);
    expect(() => commitMetrics(['a'], ['a', 'b', 'a'])).toThrow(RangeError);
    // 23 targets with one found: 1/23 has no exact integer at this scale.
    const many = Array.from({ length: 23 }, (_, i) => `t${i}`);
    expect(() => commitMetrics(many, ['t0'])).toThrow(RangeError);
  });
});

describe('strata', () => {
  const relationships = [
    // An input imports a test target (outgoing from the input).
    { kind: 'imports' as const, source: { path: 'src/a.ts' }, target: { path: 'test/helper.ts' } },
    // A test target imports an input, recorded as test-to-source.
    { kind: 'test-to-source' as const, source: { path: 'test/a.test.ts' }, target: { path: 'src/a.ts' } },
    // Unrelated: neither end is an input.
    { kind: 'imports' as const, source: { path: 'test/b.test.ts' }, target: { path: 'src/other.ts' } },
    // A doc cannot be in a link stratum even if a relationship mentions it.
    { kind: 'imports' as const, source: { path: 'src/a.ts' }, target: { path: 'docs/a.md' } },
  ];
  const targets = [
    { path: 'docs/a.md', kind: 'doc' as const, status: 'modified' as const },
    { path: 'test/a.test.ts', kind: 'test' as const, status: 'modified' as const },
    { path: 'test/b.test.ts', kind: 'test' as const, status: 'deleted' as const },
    { path: 'test/helper.ts', kind: 'test' as const, status: 'modified' as const },
  ];

  it('links test targets to inputs in either direction', () => {
    const linked = linkedTargets(['src/a.ts'], ['test/a.test.ts', 'test/b.test.ts', 'test/helper.ts'], relationships);
    expect([...linked].sort()).toEqual(['test/a.test.ts', 'test/helper.ts']);
  });

  it('puts a mixed commit in every stratum it has targets in', () => {
    const linked = linkedTargets(['src/a.ts'], ['test/a.test.ts', 'test/b.test.ts', 'test/helper.ts'], relationships);
    expect(stratumTargets(targets, linked)).toEqual({
      test: ['test/a.test.ts', 'test/b.test.ts', 'test/helper.ts'],
      doc: ['docs/a.md'],
      'test-with-link': ['test/a.test.ts', 'test/helper.ts'],
      'test-without-link': ['test/b.test.ts'],
    });
  });

  it('keeps a doc-only commit out of the test strata', () => {
    const strata = stratumTargets([targets[0]!], new Set());
    expect(strata.test).toEqual([]);
    expect(commitMetrics(strata.test, ['docs/a.md'])).toBeNull();
    expect(commitMetrics(strata.doc, ['docs/a.md'])!.scaled.recall3).toBe(L);
  });

  it('lists a stratum\'s population in manifest order', () => {
    const member = commitMetrics(['a'], ['a']);
    expect(stratumPopulation([null, member, null, member])).toEqual([1, 3]);
    expect(stratumPopulation([null, null])).toEqual([]);
  });
});

describe('macro averages and paired values', () => {
  it('keeps the exact sum and converts only on request', () => {
    const value = macro([L, L / 2, 0]);
    expect(value).toEqual({ sum: (3 * L) / 2, populationSize: 3, scale: L });
    expect(toRate(value)).toBe(0.5);
    expect(() => macro([])).toThrow(RangeError);
    expect(() => macro([0.5])).toThrow(RangeError);
  });

  it('pairs per-commit differences', () => {
    expect(pairedDifferences([L, 0, L / 2], [0, L, L / 2])).toEqual([L, -L, 0]);
    expect(() => pairedDifferences([1], [1, 2])).toThrow(RangeError);
  });
});

describe('stratum samples', () => {
  it('draws in the registered order, consuming B × m per stratum and nothing for an empty one', () => {
    expect(STRATA).toEqual(['test', 'doc', 'test-with-link', 'test-without-link']);
    const generator = mulberry32(MAIN_SEED);
    const samples = drawStrataSamples(generator, { test: 4, doc: 0, 'test-with-link': 2, 'test-without-link': 3 }, 30);
    expect(samples.doc).toBe('unavailable');
    expect(generator.draws).toBe((4 + 2 + 3) * 30);

    // The same draws as taking the strata one after another from a fresh generator.
    const reference = mulberry32(MAIN_SEED);
    for (const [stratum, m] of [['test', 4], ['test-with-link', 2], ['test-without-link', 3]] as const) {
      const expected = Array.from({ length: m * 30 }, () => Math.floor(reference.next() * m));
      expect([...(samples[stratum] as BootstrapSample).indices]).toEqual(expected);
    }
  });

  it('summarizes methods and their paired difference on one shared sample', () => {
    const sample = drawStrataSamples(mulberry32(MAIN_SEED), { test: 5, doc: 0, 'test-with-link': 0, 'test-without-link': 0 }, 200).test as BootstrapSample;
    const hybrid = [L, 0, L / 2, L, L / 3];
    const sibling = [0, 0, L / 2, L, 0];
    const difference = summarize(sample, pairedDifferences(hybrid, sibling));
    expect(difference.point).toEqual({ sum: L + L / 3, populationSize: 5, scale: L });
    expect(difference.interval).toEqual(percentileInterval(replicateSums(sample, pairedDifferences(hybrid, sibling))));
    const h = replicateSums(sample, hybrid);
    const s = replicateSums(sample, sibling);
    expect(replicateSums(sample, pairedDifferences(hybrid, sibling))).toEqual(h.map((value, r) => value - s[r]!));
  });
});
