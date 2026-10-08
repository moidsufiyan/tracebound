import { EmbeddingInputTooLongError, type EmbeddingProvider } from '../src/semantic/provider.js';

/**
 * An in-memory provider with predictable geometry: a text's vector counts occurrences of each
 * vocabulary word, plus a small constant last component so no vector is ever zero. Two texts that
 * share vocabulary words are therefore similar, with no model involved.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxInputChars: number;
  /** Every text passed to embed, in call order. */
  readonly embedded: string[] = [];
  calls = 0;
  /** Makes the n-th call to embed (1-based) throw. */
  failOnCall: number | undefined;

  private readonly vocabulary: readonly string[];
  private readonly rejects: ((text: string) => boolean) | undefined;

  constructor(
    vocabulary: readonly string[],
    options: { modelId?: string; maxInputChars?: number; rejects?: (text: string) => boolean } = {},
  ) {
    this.vocabulary = vocabulary;
    this.rejects = options.rejects;
    this.modelId = options.modelId ?? 'fake:model';
    this.dimensions = vocabulary.length + 1;
    this.maxInputChars = options.maxInputChars ?? 2000;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls += 1;
    if (this.calls === this.failOnCall) throw new Error('provider unavailable');
    // Like a real model, refuse the whole call when any input is beyond its context.
    if (texts.some((text) => this.rejects?.(text))) throw new EmbeddingInputTooLongError('input exceeds the context length');
    this.embedded.push(...texts);
    return texts.map((text) => {
      const lower = text.toLowerCase();
      const vector = new Float32Array(this.dimensions);
      this.vocabulary.forEach((word, index) => {
        vector[index] = lower.split(word).length - 1;
      });
      vector[this.vocabulary.length] = 0.01;
      return vector;
    });
  }
}
