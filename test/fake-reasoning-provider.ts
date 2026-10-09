import type { ReasoningInput, ReasoningProvider, ReasoningRequest } from '../src/reasoning/provider.js';

export type Respond = (request: ReasoningRequest, callIndex: number) => unknown | Promise<unknown>;

/** A well-formed answer for `input`: every candidate potentially affected, citing its first evidence item. */
export function wellFormedAnswer(input: ReasoningInput, classification = 'potentially_affected'): unknown {
  return {
    snapshotId: input.snapshot.id,
    assessments: input.candidates.map((candidate) => ({
      artifactId: candidate.artifactId,
      versionId: candidate.versionId,
      path: candidate.path,
      classification,
      findings: [{ statement: `Evidence ${candidate.evidence[0]!.id} was retrieved for ${candidate.path}.`, evidenceIds: [candidate.evidence[0]!.id] }],
    })),
  };
}

/** A reasoning provider that records its requests and answers from a function. */
export class FakeReasoningProvider implements ReasoningProvider {
  readonly modelId: string;
  readonly maxInputChars: number;
  readonly requests: ReasoningRequest[] = [];
  maxInFlight = 0;

  private inFlight = 0;
  private readonly respond: Respond;

  constructor(options: { modelId?: string; maxInputChars?: number; respond?: Respond } = {}) {
    this.modelId = options.modelId ?? 'fake:reasoner';
    this.maxInputChars = options.maxInputChars ?? 10_000_000;
    this.respond = options.respond ?? ((request) => wellFormedAnswer(request.input));
  }

  async reason(request: ReasoningRequest): Promise<unknown> {
    const index = this.requests.length;
    this.requests.push(request);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await this.respond(request, index);
    } finally {
      this.inFlight -= 1;
    }
  }
}
