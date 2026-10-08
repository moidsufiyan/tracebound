/**
 * What semantic retrieval needs from an embedding model. `modelId` names the model unambiguously
 * enough that two ids never denote vectors from different spaces; embeddings are stored and
 * searched per id. `embed` returns one vector per input, in order, each `dimensions` long.
 */
export interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  /** The longest input, in characters, that the model accepts without truncating it. */
  readonly maxInputChars: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export class EmbeddingProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EmbeddingProviderError';
  }
}

/** The provider refused an input as longer than the model's context. */
export class EmbeddingInputTooLongError extends EmbeddingProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingInputTooLongError';
  }
}
