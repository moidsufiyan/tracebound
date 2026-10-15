import { describe, expect, it } from 'vitest';
import {
  drawBootstrapSample,
  INTERVAL_PERCENTILES,
  MAIN_SEED,
  mulberry32,
  percentile,
  percentileInterval,
  REPLICATES,
  replicateSums,
  SENSITIVITY_SEED,
} from '../src/evaluation/cochange/bootstrap.js';

// The reference code exactly as printed in docs/evaluation/cochange/protocol.md, section 5.
function referenceMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const take = (next: () => number, n: number) => Array.from({ length: n }, () => next());

describe('the registered generators', () => {
  it('uses the registered seeds', () => {
    expect(MAIN_SEED).toBe(20261014);
    expect(SENSITIVITY_SEED).toBe(2667729199);
    expect(SENSITIVITY_SEED.toString(16)).toBe('9f02512f');
    expect(REPLICATES).toBe(10_000);
    expect(INTERVAL_PERCENTILES).toEqual({ lower: 0.025, upper: 0.975 });
  });

  it('gives the first three values documented in the protocol for both seeds', () => {
    const main = mulberry32(MAIN_SEED);
    expect(take(() => main.next(), 3)).toEqual([0.19576451717875898, 0.89535868098028, 0.07554438407532871]);
    const sensitivity = mulberry32(SENSITIVITY_SEED);
    expect(take(() => sensitivity.next(), 3)).toEqual([0.6837100561242551, 0.702551462687552, 0.8209013962186873]);
  });

  it('matches the reference code value for value, including at the uint32 boundaries', () => {
    for (const seed of [MAIN_SEED, SENSITIVITY_SEED, 0, 1, 0x7fffffff, 0x80000000, 0xffffffff]) {
      const generator = mulberry32(seed);
      const values = take(() => generator.next(), 10_000);
      expect(values).toEqual(take(referenceMulberry32(seed), 10_000));
      expect(values.every((u) => u >= 0 && u < 1)).toBe(true);
      expect(generator.draws).toBe(10_000);
    }
  });

  it('is reproducible, and two instances with different seeds are distinct streams', () => {
    const a = mulberry32(MAIN_SEED);
    const b = mulberry32(MAIN_SEED);
    expect(take(() => a.next(), 100)).toEqual(take(() => b.next(), 100));
    const sensitivity = mulberry32(SENSITIVITY_SEED);
    expect(take(() => mulberry32(MAIN_SEED).next(), 1)).not.toEqual(take(() => sensitivity.next(), 1));
  });

  it('rejects a seed that is not an unsigned 32-bit integer instead of coercing it', () => {
    for (const seed of [-1, 4294967296, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => mulberry32(seed)).toThrow(RangeError);
    }
  });
});

describe('bootstrap samples', () => {
  it('draws index = floor(u × m) for each of B × m draws, in order', () => {
    const sample = drawBootstrapSample(mulberry32(MAIN_SEED), 7, 50);
    const expected = take(referenceMulberry32(MAIN_SEED), 7 * 50).map((u) => Math.floor(u * 7));
    expect([...sample.indices]).toEqual(expected);
    expect(sample.populationSize).toBe(7);
    expect(sample.replicates).toBe(50);
  });

  it('samples with replacement and stays inside the population', () => {
    const sample = drawBootstrapSample(mulberry32(MAIN_SEED), 3, 1000);
    const indices = [...sample.indices];
    expect(Math.min(...indices)).toBe(0);
    expect(Math.max(...indices)).toBe(2);
    const replicates = Array.from({ length: 1000 }, (_, r) => indices.slice(r * 3, r * 3 + 3));
    expect(replicates.some((draw) => new Set(draw).size < 3)).toBe(true);
  });

  it('uses the default B = 10,000 and consumes exactly B × m values', () => {
    const generator = mulberry32(MAIN_SEED);
    const sample = drawBootstrapSample(generator, 47);
    expect(sample.replicates).toBe(10_000);
    expect(sample.indices.length).toBe(470_000);
    expect(generator.draws).toBe(470_000);
  });

  it('consumes nothing for an empty population', () => {
    const generator = mulberry32(MAIN_SEED);
    const sample = drawBootstrapSample(generator, 0);
    expect(sample.indices.length).toBe(0);
    expect(generator.draws).toBe(0);
  });

  it('continues the stream across strata without resetting it', () => {
    const generator = mulberry32(MAIN_SEED);
    const sizes = [4, 0, 2, 3];
    const samples = sizes.map((m) => drawBootstrapSample(generator, m, 20));
    expect(generator.draws).toBe((4 + 0 + 2 + 3) * 20);

    const reference = referenceMulberry32(MAIN_SEED);
    for (const [s, m] of sizes.entries()) {
      expect([...samples[s]!.indices]).toEqual(take(reference, m * 20).map((u) => Math.floor(u * m)));
    }
  });

  it('rejects invalid population sizes and replicate counts', () => {
    for (const m of [-1, 1.5, Number.NaN]) expect(() => drawBootstrapSample(mulberry32(1), m, 10)).toThrow(RangeError);
    for (const b of [0, -1, 2.5, Number.NaN]) expect(() => drawBootstrapSample(mulberry32(1), 3, b)).toThrow(RangeError);
  });

  it('rejects a generator value outside [0, 1)', () => {
    const broken = { next: () => 1, draws: 0 };
    expect(() => drawBootstrapSample(broken, 2, 1)).toThrow(RangeError);
  });
});

describe('replicate sums', () => {
  const sampleOf = (populationSize: number, rows: number[][]) => ({ populationSize, replicates: rows.length, indices: Uint32Array.from(rows.flat()) });

  it('sums the drawn members, counting a member drawn twice twice', () => {
    const sample = sampleOf(3, [[0, 1, 2], [2, 2, 0], [1, 1, 1]]);
    expect(replicateSums(sample, [10, 20, 30])).toEqual([60, 70, 60]);
  });

  it('pairs methods, metrics and differences on one shared sample', () => {
    const sample = drawBootstrapSample(mulberry32(MAIN_SEED), 5, 200);
    const hybrid = [3, 0, 7, 7, 1];
    const sibling = [1, 2, 7, 0, 1];
    const mrr = [12, 6, 4, 0, 3];
    const differences = hybrid.map((value, i) => value - sibling[i]!);

    const hybridSums = replicateSums(sample, hybrid);
    const siblingSums = replicateSums(sample, sibling);
    expect(replicateSums(sample, differences)).toEqual(hybridSums.map((sum, r) => sum - siblingSums[r]!));
    // Reusing the sample for another metric draws nothing new: the same members are summed.
    const mrrSums = replicateSums(sample, mrr);
    const firstReplicate = [...sample.indices.subarray(0, 5)];
    expect(mrrSums[0]).toBe(firstReplicate.reduce((sum, i) => sum + mrr[i]!, 0));
    expect(hybridSums[0]).toBe(firstReplicate.reduce((sum, i) => sum + hybrid[i]!, 0));
  });

  it('keeps sums of scaled values exact', () => {
    // The scale the metrics will use: lcm(1..20), so Recall@K and MRR@20 are integers.
    const scale = 232_792_560;
    const sample = sampleOf(50, [Array.from({ length: 50 }, () => 0)]);
    const values = Array.from({ length: 50 }, (_, i) => (i === 0 ? scale : 0));
    expect(replicateSums(sample, values)).toEqual([scale * 50]);
  });

  it('rejects unsafe or invalid input instead of coercing it', () => {
    const sample = sampleOf(2, [[0, 1]]);
    expect(() => replicateSums(sampleOf(0, []), [])).toThrow(RangeError);
    expect(() => replicateSums(sample, [1])).toThrow(RangeError);
    expect(() => replicateSums(sample, [1, 0.5])).toThrow(RangeError);
    expect(() => replicateSums(sample, [1, Number.NaN])).toThrow(RangeError);
    expect(() => replicateSums(sample, [1, Number.MAX_SAFE_INTEGER])).toThrow(RangeError);
    expect(() => replicateSums(sampleOf(2, [[0, 2]]), [1, 1])).toThrow(RangeError);
    expect(() => replicateSums({ populationSize: 2, replicates: 2, indices: Uint32Array.from([0, 1]) }, [1, 1])).toThrow(RangeError);
  });

  it('accepts the largest values whose sums stay safe', () => {
    const limit = Math.floor(Number.MAX_SAFE_INTEGER / 2);
    expect(replicateSums(sampleOf(2, [[0, 1]]), [limit, -limit])).toEqual([0]);
  });
});

describe('percentiles', () => {
  it('takes v[k] at an exact position', () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 0.25)).toBe(2);
    expect(percentile([5, 1, 4, 2, 3], 0)).toBe(1);
    expect(percentile([5, 1, 4, 2, 3], 1)).toBe(5);
    expect(percentile([7], 0.975)).toBe(7);
  });

  it('interpolates linearly at a fractional position', () => {
    // B = 6, p = 0.1: x = 0.5, halfway between the two smallest values.
    expect(percentile([30, 10, 20, 40, 50, 60], 0.1)).toBe(15);
    // B = 11, p = 0.025: x = 0.25.
    expect(percentile([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40], 0.025)).toBe(1);
  });

  it('sorts numerically, not as strings', () => {
    expect(percentile([10, 9, 100, -2], 0)).toBe(-2);
    expect(percentile([10, 9, 100, -2], 1)).toBe(100);
  });

  it('gives the 95% interval of B = 10,000 values at positions 249.975 and 9749.025', () => {
    const generator = mulberry32(MAIN_SEED);
    const values = Array.from({ length: 10_000 }, (_, i) => i * 2);
    // Shuffle deterministically so the function has to sort.
    for (let i = values.length - 1; i > 0; i -= 1) {
      const j = Math.floor(generator.next() * (i + 1));
      [values[i], values[j]] = [values[j]!, values[i]!];
    }
    const lowerAt = 9999 * 0.025;
    const upperAt = 9999 * 0.975;
    const expectedLower = 2 * Math.floor(lowerAt) + (lowerAt - Math.floor(lowerAt)) * 2;
    const expectedUpper = 2 * Math.floor(upperAt) + (upperAt - Math.floor(upperAt)) * 2;
    expect(percentileInterval(values)).toEqual({ lower: expectedLower, upper: expectedUpper });
    expect(expectedLower).toBeCloseTo(499.95, 9);
    expect(expectedUpper).toBeCloseTo(19498.05, 9);
  });

  it('keeps an endpoint of exactly zero at zero', () => {
    expect(percentileInterval([0, 0, 0, 0, 0])).toEqual({ lower: 0, upper: 0 });
  });

  it('does not reorder the caller\'s values', () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });

  it('rejects empty input, non-finite values and p outside [0, 1]', () => {
    expect(() => percentile([], 0.5)).toThrow(RangeError);
    expect(() => percentile([1, Number.NaN], 0.5)).toThrow(RangeError);
    expect(() => percentile([1, Number.POSITIVE_INFINITY], 0.5)).toThrow(RangeError);
    for (const p of [-0.1, 1.1, Number.NaN]) expect(() => percentile([1, 2], p)).toThrow(RangeError);
  });
});
