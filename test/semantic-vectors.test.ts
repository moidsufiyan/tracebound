import { describe, expect, it } from 'vitest';
import { cosineSimilarity, decodeVector, encodeVector, EmbeddingResponseError, validateEmbeddings } from '../src/semantic/vectors.js';

describe('vector BLOB encoding', () => {
  it('round-trips float32 values exactly, as little-endian bytes', () => {
    const vector = Float32Array.from([0, 1, -1, 0.5, 3.4028234663852886e38, 1.4e-45, 0.1]);
    const bytes = encodeVector(vector);

    expect(bytes.byteLength).toBe(vector.length * 4);
    expect([...bytes.slice(4, 8)]).toEqual([0x00, 0x00, 0x80, 0x3f]); // 1.0f little-endian
    expect(decodeVector(bytes, vector.length)).toEqual(vector);
  });

  it('decodes from a view that does not start at the beginning of its buffer', () => {
    const vector = Float32Array.from([1.5, -2.5, 3.5]);
    const padded = new Uint8Array(40);
    padded.set(encodeVector(vector), 13);
    expect(decodeVector(padded.subarray(13, 13 + 12), 3)).toEqual(vector);
  });

  it('refuses a blob whose length does not match the dimensions', () => {
    expect(() => decodeVector(new Uint8Array(11), 3)).toThrow(EmbeddingResponseError);
    expect(() => decodeVector(encodeVector(Float32Array.from([1, 2])), 3)).toThrow(/expected 12/);
  });
});

describe('cosineSimilarity', () => {
  const v = (...values: number[]) => Float32Array.from(values);

  it('is 1 for parallel vectors regardless of length, -1 for opposite, 0 for orthogonal', () => {
    expect(cosineSimilarity(v(1, 2, 3), v(2, 4, 6))).toBeCloseTo(1, 12);
    expect(cosineSimilarity(v(1, 2, 3), v(-1, -2, -3))).toBeCloseTo(-1, 12);
    expect(cosineSimilarity(v(1, 0), v(0, 5))).toBe(0);
  });

  it('matches a hand-computed value', () => {
    // dot = 1*4 + 2*5 + 3*6 = 32; norms = sqrt(14) * sqrt(77)
    expect(cosineSimilarity(v(1, 2, 3), v(4, 5, 6))).toBeCloseTo(32 / Math.sqrt(14 * 77), 12);
  });

  it('is symmetric', () => {
    expect(cosineSimilarity(v(1, 2, 3), v(3, 1, 2))).toBe(cosineSimilarity(v(3, 1, 2), v(1, 2, 3)));
  });

  it('defines a zero vector as having no similarity instead of returning NaN', () => {
    expect(cosineSimilarity(v(0, 0, 0), v(1, 2, 3))).toBe(0);
    expect(cosineSimilarity(v(1, 2, 3), v(0, 0, 0))).toBe(0);
    expect(cosineSimilarity(v(0, 0), v(0, 0))).toBe(0);
  });

  it('refuses vectors of different dimensions', () => {
    expect(() => cosineSimilarity(v(1, 2), v(1, 2, 3))).toThrow(/dimensions/);
  });
});

describe('validateEmbeddings', () => {
  it('accepts exactly one vector of the declared size per input and returns float32 vectors', () => {
    const result = validateEmbeddings([[1, 2, 3], [0, 0, 0.5]], 2, 3);
    expect(result).toEqual([Float32Array.from([1, 2, 3]), Float32Array.from([0, 0, 0.5])]);
  });

  it('rejects a response that is not a list', () => {
    expect(() => validateEmbeddings(undefined, 1, 3)).toThrow(/not a list/);
    expect(() => validateEmbeddings({ embeddings: [] }, 1, 3)).toThrow(/not a list/);
  });

  it('rejects a different number of vectors than inputs, in either direction', () => {
    expect(() => validateEmbeddings([[1, 2, 3]], 2, 3)).toThrow(/Expected 2 embeddings, received 1/);
    expect(() => validateEmbeddings([[1, 2, 3], [1, 2, 3]], 1, 3)).toThrow(/Expected 1 embeddings, received 2/);
  });

  it('rejects vectors of the wrong or inconsistent dimensionality without padding or truncating', () => {
    expect(() => validateEmbeddings([[1, 2]], 1, 3)).toThrow(/2 dimensions, expected 3/);
    expect(() => validateEmbeddings([[1, 2, 3, 4]], 1, 3)).toThrow(/4 dimensions, expected 3/);
    expect(() => validateEmbeddings([[1, 2, 3], [1, 2]], 2, 3)).toThrow(/Embedding 1 has 2 dimensions/);
  });

  it('rejects entries that are not vectors, non-finite values and zero vectors', () => {
    expect(() => validateEmbeddings(['abc'], 1, 3)).toThrow(/not a vector/);
    expect(() => validateEmbeddings([null], 1, 3)).toThrow(/not a vector/);
    expect(() => validateEmbeddings([[1, Number.NaN, 3]], 1, 3)).toThrow(/non-finite/);
    expect(() => validateEmbeddings([[1, Number.POSITIVE_INFINITY, 3]], 1, 3)).toThrow(/non-finite/);
    expect(() => validateEmbeddings([[0, 0, 0]], 1, 3)).toThrow(/zero vector/);
  });
});
