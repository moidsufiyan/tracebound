// Vector storage and comparison. Stored vectors are little-endian float32: the precision the
// provider computes in, so nothing is lost by storing them that way.

export class EmbeddingResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingResponseError';
  }
}

export function encodeVector(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

export function decodeVector(blob: Uint8Array, dimensions: number): Float32Array {
  if (blob.byteLength !== dimensions * 4) {
    throw new EmbeddingResponseError(`Stored vector has ${blob.byteLength} bytes, expected ${dimensions * 4} for ${dimensions} dimensions`);
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) vector[index] = view.getFloat32(index * 4, true);
  return vector;
}

/**
 * Cosine similarity of two vectors of equal length. A zero vector has no direction, so its
 * similarity to anything is defined as 0 rather than NaN; vectors from providers are rejected
 * earlier if they are zero, so this only guards stored data.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`Cannot compare vectors of ${a.length} and ${b.length} dimensions`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Checks a provider's raw response against what was asked: one vector per input, every vector as
 * long as the provider's declared dimensions, every value finite, no all-zero vector. Nothing is
 * truncated, padded or coerced; any mismatch is an error.
 */
export function validateEmbeddings(raw: unknown, inputCount: number, dimensions: number): Float32Array[] {
  if (!Array.isArray(raw)) throw new EmbeddingResponseError('Embedding response is not a list of vectors');
  if (raw.length !== inputCount) {
    throw new EmbeddingResponseError(`Expected ${inputCount} embeddings, received ${raw.length}`);
  }

  return raw.map((entry: unknown, index) => {
    if (!Array.isArray(entry) && !(entry instanceof Float32Array)) {
      throw new EmbeddingResponseError(`Embedding ${index} is not a vector`);
    }
    if (entry.length !== dimensions) {
      throw new EmbeddingResponseError(`Embedding ${index} has ${entry.length} dimensions, expected ${dimensions}`);
    }
    const vector = Float32Array.from(entry as ArrayLike<number>);
    let hasDirection = false;
    for (const value of vector) {
      if (!Number.isFinite(value)) throw new EmbeddingResponseError(`Embedding ${index} contains a non-finite value`);
      if (value !== 0) hasDirection = true;
    }
    if (!hasDirection) throw new EmbeddingResponseError(`Embedding ${index} is a zero vector`);
    return vector;
  });
}
