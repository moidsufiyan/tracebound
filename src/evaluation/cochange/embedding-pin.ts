import { REGISTERED } from './preflight.js';

// The embedding model build the co-change evaluation is pinned to. It is reviewed configuration, never
// taken from the provider it is checked against: the provider's identity comes from the weights digest
// the Ollama server reports for the installed model, and both its model id and its full digest must
// equal the pin before a preparation or evaluation starts.
//
// Provenance: the protocol (section 4) names only the tag `nomic-embed-text:v1.5`. This build is the
// one recorded for the M6/M9 production runs in docs/evaluation/m9/candidate-manifest.json
// (selection.originalRun: embeddingModelId and embeddingWeightsDigest), adopted for this evaluation by
// the developer. Changing it means a different evaluation identity and a new work directory.

export interface EmbeddingPin {
  /** The provider model id, `ollama:<tag>@<first 12 characters of the digest>`. */
  modelId: string;
  /** The full SHA-256 weights digest of the installed model. */
  weightsDigest: string;
}

/** Null would mean no reviewed pin: preparation and evaluation then refuse to start. */
export const EMBEDDING_PIN: Readonly<EmbeddingPin> | null = Object.freeze({
  modelId: 'ollama:nomic-embed-text:v1.5@0a109f422b47',
  weightsDigest: '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f',
});

/** The pin, provided one is configured and it names a full weights digest of the registered model with its model id. */
export function validateEmbeddingPin(pin: EmbeddingPin | null): { status: 'valid'; pin: EmbeddingPin } | { status: 'missing' | 'invalid'; detail: string } {
  if (pin === null) return { status: 'missing', detail: 'No embedding pin is configured (EMBEDDING_PIN in src/evaluation/cochange/embedding-pin.ts)' };
  const expectedId = `ollama:${REGISTERED.embeddingModel}@${pin.weightsDigest.slice(0, 12)}`;
  if (!/^[0-9a-f]{64}$/.test(pin.weightsDigest) || pin.modelId !== expectedId) {
    return { status: 'invalid', detail: `The pin ${pin.modelId} (${pin.weightsDigest}) is not a full SHA-256 digest of ${REGISTERED.embeddingModel} with its matching model id` };
  }
  return { status: 'valid', pin };
}

/** Whether `provider` is the pinned build: the same model id and the same full weights digest. */
export function matchEmbeddingPin(pin: EmbeddingPin, provider: { modelId: string; weightsDigest: string }): { status: 'verified' } | { status: 'mismatch'; detail: string } {
  if (provider.modelId !== pin.modelId || provider.weightsDigest !== pin.weightsDigest) {
    return { status: 'mismatch', detail: `The installed embedding model is ${provider.modelId} (weights ${provider.weightsDigest}), not the pinned ${pin.modelId} (weights ${pin.weightsDigest})` };
  }
  return { status: 'verified' };
}
