// The paired percentile bootstrap of the co-change evaluation (docs/evaluation/cochange/protocol.md,
// version 1.0.0, section 5). Pure: callers create the generators, decide which stratum consumes
// them in which order, and keep them alive across strata; nothing here holds global state.
//
// Per-commit values are passed as safe integers (each metric scaled by a common factor chosen by
// the caller), so replicate sums are exact and the sign of an interval endpoint never depends on
// floating-point residue. A replicate mean is its sum divided by the population size, and the
// percentile interpolation is linear, so dividing the result by (scale × population size) gives
// the protocol's value.

/** Seed of the main generator, used for the methods of protocol section 6. */
export const MAIN_SEED = 20261014;
/** Seed of the sensitivity generator (no-description arm): the main seed XOR 0x9E3779B9, as uint32. */
export const SENSITIVITY_SEED = (MAIN_SEED ^ 0x9e3779b9) >>> 0;
/** Replicates per bootstrap (B). */
export const REPLICATES = 10_000;
/** Percentiles of the 95% interval: lower and upper endpoint. */
export const INTERVAL_PERCENTILES = Object.freeze({ lower: 0.025, upper: 0.975 });

const UINT32_RANGE = 4294967296;

/** A Mulberry32 stream. `draws` counts the values taken so far, so stream consumption can be checked. */
export interface UniformGenerator {
  /** The next u in [0, 1). */
  next(): number;
  readonly draws: number;
}

/**
 * The protocol's reference Mulberry32, seeded with a uint32. The seed is validated rather than
 * coerced, so a mistyped seed fails instead of silently becoming another stream.
 */
export function mulberry32(seed: number): UniformGenerator {
  if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_RANGE) throw new RangeError(`The seed must be an unsigned 32-bit integer, received ${seed}`);
  let a = seed >>> 0;
  let draws = 0;
  return {
    next() {
      draws += 1;
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    },
    get draws() {
      return draws;
    },
  };
}

/**
 * The resampled population indices of one bootstrap: replicate r holds
 * `indices[r * populationSize .. (r + 1) * populationSize - 1]`. One sample is drawn per stratum and
 * reused for every method, metric and paired difference of that stratum.
 */
export interface BootstrapSample {
  readonly populationSize: number;
  readonly replicates: number;
  readonly indices: Uint32Array;
}

/**
 * Draws `replicates` resamples of a population of `populationSize` members, each exactly
 * `populationSize` indices with replacement, index = floor(u × populationSize), one u per draw in
 * order. Consumes exactly replicates × populationSize values of `generator`, and none for an empty
 * population, leaving the generator where the next stratum continues.
 */
export function drawBootstrapSample(generator: UniformGenerator, populationSize: number, replicates: number = REPLICATES): BootstrapSample {
  if (!Number.isSafeInteger(populationSize) || populationSize < 0) throw new RangeError(`The population size must be a non-negative integer, received ${populationSize}`);
  if (!Number.isSafeInteger(replicates) || replicates < 1) throw new RangeError(`The replicate count must be a positive integer, received ${replicates}`);
  const indices = new Uint32Array(replicates * populationSize);
  for (let i = 0; i < indices.length; i += 1) {
    const u = generator.next();
    if (!(u >= 0 && u < 1)) throw new RangeError(`The generator returned ${u}, outside [0, 1)`);
    indices[i] = Math.floor(u * populationSize);
  }
  return { populationSize, replicates, indices };
}

/**
 * The sum, for each replicate of `sample`, of the values of the drawn members (a member drawn twice
 * counts twice). `values[i]` is the safe-integer value of population member i; pass per-member
 * differences to get the paired difference of two methods. Fails on an empty population, a length
 * mismatch, a value that is not a safe integer, an out-of-range index, or sums that could exceed
 * the safe integer range.
 */
export function replicateSums(sample: BootstrapSample, values: readonly number[]): number[] {
  const m = sample.populationSize;
  if (m === 0) throw new RangeError('An empty population has no replicate statistic');
  if (values.length !== m) throw new RangeError(`Expected ${m} values, one per population member, received ${values.length}`);
  if (sample.indices.length !== m * sample.replicates) throw new RangeError('The sample does not hold populationSize × replicates indices');
  let largest = 0;
  for (const [i, value] of values.entries()) {
    if (!Number.isSafeInteger(value)) throw new RangeError(`Value ${i} is ${value}, not a safe integer`);
    largest = Math.max(largest, Math.abs(value));
  }
  if (largest > Math.floor(Number.MAX_SAFE_INTEGER / m)) throw new RangeError(`Sums of ${m} values up to ${largest} can exceed the safe integer range`);

  const sums = new Array<number>(sample.replicates);
  for (let r = 0; r < sample.replicates; r += 1) {
    let sum = 0;
    for (let j = r * m; j < (r + 1) * m; j += 1) {
      const index = sample.indices[j]!;
      if (index >= m) throw new RangeError(`Index ${index} is outside a population of ${m}`);
      sum += values[index]!;
    }
    sums[r] = sum;
  }
  return sums;
}

/**
 * Percentile p of `values` as the protocol defines it: sort ascending, then interpolate linearly
 * at the zero-based position x = (B − 1) × p, giving v[k] + f × (v[k+1] − v[k]) with k = floor(x)
 * and f = x − k (v[k] when f = 0).
 */
export function percentile(values: readonly number[], p: number): number {
  return percentileOfSorted(sortedCopy(values), p);
}

/** The 95% interval (p = 0.025 and 0.975) of `values`, sorted once. */
export function percentileInterval(values: readonly number[]): { lower: number; upper: number } {
  const sorted = sortedCopy(values);
  return { lower: percentileOfSorted(sorted, INTERVAL_PERCENTILES.lower), upper: percentileOfSorted(sorted, INTERVAL_PERCENTILES.upper) };
}

function sortedCopy(values: readonly number[]): number[] {
  if (values.length === 0) throw new RangeError('A percentile needs at least one value');
  for (const [i, value] of values.entries()) {
    if (!Number.isFinite(value)) throw new RangeError(`Value ${i} is ${value}, not a finite number`);
  }
  return [...values].sort((a, b) => a - b);
}

function percentileOfSorted(sorted: readonly number[], p: number): number {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`The percentile must be in [0, 1], received ${p}`);
  const x = (sorted.length - 1) * p;
  const k = Math.floor(x);
  const f = x - k;
  const low = sorted[k]!;
  return f === 0 ? low : low + f * (sorted[k + 1]! - low);
}
