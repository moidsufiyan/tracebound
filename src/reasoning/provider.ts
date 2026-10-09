import type { Evidence } from '../retrieval/evidence.js';
import type { ArtifactKind } from '../artifacts/artifacts.js';

/** One candidate as the reasoning model sees it: its identity and the evidence M7 built for it. */
export interface ReasoningCandidate {
  artifactId: number;
  versionId: number;
  path: string;
  kind: ArtifactKind;
  evidence: readonly Evidence[];
}

/**
 * Everything a reasoning model is given. It is data, serialized as JSON and kept apart from the
 * fixed instructions: the change description and the source excerpts inside the evidence are
 * untrusted text that came from a person or a repository.
 */
export interface ReasoningInput {
  snapshot: { id: number; commitSha: string };
  change: { description: string; changedPaths: readonly string[] };
  candidates: readonly ReasoningCandidate[];
}

/** The JSON text of an input; providers send exactly this, and the input budget is measured on it. */
export function serializeReasoningInput(input: ReasoningInput): string {
  return JSON.stringify(input);
}

export interface ReasoningRequest {
  /** Fixed system instructions; never built from the input. */
  instructions: string;
  input: ReasoningInput;
  /** JSON Schema of the answer, for providers that can constrain their output. */
  outputSchema: object;
}

/**
 * What impact reasoning needs from a model. `maxInputChars` is the most the provider accepts in
 * one request, instructions and serialized input together. `reason` returns whatever the model
 * produced as a parsed value; it is validated by the caller and trusted by no one.
 */
export interface ReasoningProvider {
  readonly modelId: string;
  readonly maxInputChars: number;
  reason(request: ReasoningRequest): Promise<unknown>;
}

export class ReasoningProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReasoningProviderError';
  }
}

export class ReasoningProviderTimeoutError extends ReasoningProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'ReasoningProviderTimeoutError';
  }
}
