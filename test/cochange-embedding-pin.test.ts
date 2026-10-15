import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMBEDDING_PIN, matchEmbeddingPin, validateEmbeddingPin, type EmbeddingPin } from '../src/evaluation/cochange/embedding-pin.js';

const DIGEST = '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f';
const PIN: EmbeddingPin = { modelId: 'ollama:nomic-embed-text:v1.5@0a109f422b47', weightsDigest: DIGEST };

describe('the tracked embedding pin', () => {
  it('is the build the M9 evidence records, and a valid pin of the registered model', () => {
    const m9 = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'docs', 'evaluation', 'm9', 'candidate-manifest.json'), 'utf8'));
    const recorded = m9.selection.originalRun;
    expect(EMBEDDING_PIN).toEqual({ modelId: recorded.embeddingModelId, weightsDigest: recorded.embeddingWeightsDigest });
    expect(validateEmbeddingPin(EMBEDDING_PIN)).toEqual({ status: 'valid', pin: EMBEDDING_PIN });
  });
});

describe('validateEmbeddingPin', () => {
  it('fails closed without a pin', () => {
    expect(validateEmbeddingPin(null)).toMatchObject({ status: 'missing' });
  });

  it.each([
    ['an abbreviated digest', { modelId: PIN.modelId, weightsDigest: DIGEST.slice(0, 12) }],
    ['a digest in upper case', { modelId: 'ollama:nomic-embed-text:v1.5@0A109F422B47', weightsDigest: DIGEST.toUpperCase() }],
    ['a model id of another digest', { modelId: 'ollama:nomic-embed-text:v1.5@ffffffffffff', weightsDigest: DIGEST }],
    ['another model', { modelId: 'ollama:nomic-embed-text:latest@0a109f422b47', weightsDigest: DIGEST }],
  ])('refuses %s', (_label, pin) => {
    expect(validateEmbeddingPin(pin)).toMatchObject({ status: 'invalid' });
  });
});

describe('matchEmbeddingPin', () => {
  it('accepts the pinned build', () => {
    expect(matchEmbeddingPin(PIN, { modelId: PIN.modelId, weightsDigest: DIGEST })).toEqual({ status: 'verified' });
  });

  it('refuses another build, even one whose model id is the same', () => {
    const sameId = { modelId: PIN.modelId, weightsDigest: `${DIGEST.slice(0, 12)}${'0'.repeat(52)}` };
    expect(matchEmbeddingPin(PIN, sameId)).toMatchObject({ status: 'mismatch' });
    expect(matchEmbeddingPin(PIN, { modelId: 'ollama:nomic-embed-text:v1.5@ffffffffffff', weightsDigest: 'f'.repeat(64) })).toMatchObject({ status: 'mismatch' });
  });
});
