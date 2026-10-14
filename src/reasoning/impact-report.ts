import type { Evidence } from '../retrieval/evidence.js';
import { classificationGroundingProblem, findingGroundingProblem } from './grounding.js';
import type { ReasoningCandidate, ReasoningInput } from './provider.js';

export const IMPACT_CLASSIFICATIONS = ['likely_affected', 'potentially_affected', 'no_impact_indicated', 'insufficient_evidence'] as const;

/**
 * - `likely_affected`: the evidence supports a specific relationship to the behavior the change
 *   describes. A structural link alone is not enough if that behavior is not established.
 * - `potentially_affected`: a plausible relationship, but the evidence does not establish an actual
 *   behavioral impact.
 * - `no_impact_indicated`: the evidence affirmatively supports that the described change does not
 *   affect the candidate. The absence of a signal is not that.
 * - `insufficient_evidence`: the description and evidence do not support a defensible assessment.
 */
export type ImpactClassification = (typeof IMPACT_CLASSIFICATIONS)[number];

/** A statement about a candidate and the evidence of that candidate it rests on. */
export interface Finding {
  statement: string;
  evidenceIds: readonly string[];
}

export interface CandidateAssessment {
  artifactId: number;
  versionId: number;
  path: string;
  classification: ImpactClassification;
  findings: readonly Finding[];
}

export interface ImpactReport {
  snapshotId: number;
  /** The reasoning model that produced the assessments, as its provider identifies it. */
  modelId: string;
  /** One assessment for each candidate supplied, in the order supplied. */
  assessments: readonly CandidateAssessment[];
}

/** The model's output was not a well-formed, consistent assessment of the candidates it was given. */
export class InvalidReasoningOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidReasoningOutputError';
  }
}

export const MAX_STATEMENT_CHARS = 1000;
export const MAX_FINDINGS_PER_CANDIDATE = 10;
export const MAX_EVIDENCE_IDS_PER_FINDING = 20;
export const MAX_REPORT_STATEMENT_CHARS = 100_000;

/** The shape the model is asked for. The validator, not this schema, decides what is accepted. */
export const IMPACT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['snapshotId', 'assessments'],
  properties: {
    snapshotId: { type: 'integer' },
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['artifactId', 'versionId', 'path', 'classification', 'findings'],
        properties: {
          artifactId: { type: 'integer' },
          versionId: { type: 'integer' },
          path: { type: 'string' },
          classification: { type: 'string', enum: [...IMPACT_CLASSIFICATIONS] },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['statement', 'evidenceIds'],
              properties: {
                statement: { type: 'string' },
                evidenceIds: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Checks a model's raw output against the input it answered and returns the assessments in the
 * order of `input.candidates`. It establishes structure and references only: the shape and types,
 * the snapshot, exactly the candidates supplied (by artifact, version and path, each once), a
 * permitted classification, bounded sizes, and findings that cite evidence of their own candidate.
 * After that, the grounding guards (`grounding.ts`) reject a few explicit, deterministic mismatches
 * between a finding and the evidence it cites (a reversed import direction, a symbol use shown only
 * by an import, a test count from a keyword count, a quoted query term contradicted or not recorded)
 * and two classifications the cited evidence cannot carry (`likely_affected` without a located
 * structural relationship; `no_impact_indicated`, which no current evidence type can show). It still
 * cannot tell whether a statement is true or follows from the evidence it cites.
 *
 * Throws InvalidReasoningOutputError for the first problem found; nothing is repaired or dropped.
 */
export function validateImpactOutput(output: unknown, input: ReasoningInput): CandidateAssessment[] {
  const root = asRecord(output, 'The output', ['snapshotId', 'assessments']);
  if (root['snapshotId'] !== input.snapshot.id) {
    throw new InvalidReasoningOutputError(`The output is for snapshot ${String(root['snapshotId'])}, not snapshot ${input.snapshot.id}`);
  }
  const rawAssessments = root['assessments'];
  if (!Array.isArray(rawAssessments)) throw new InvalidReasoningOutputError('The output has no list of assessments');

  const supplied = new Map(input.candidates.map((candidate) => [candidate.versionId, candidate]));
  if (rawAssessments.length > supplied.size) {
    throw new InvalidReasoningOutputError(`The output has ${rawAssessments.length} assessments for ${supplied.size} candidates`);
  }

  const byVersion = new Map<number, CandidateAssessment>();
  let statementChars = 0;
  rawAssessments.forEach((raw: unknown, index) => {
    const label = `Assessment ${index}`;
    const record = asRecord(raw, label, ['artifactId', 'versionId', 'path', 'classification', 'findings']);
    const versionId = record['versionId'];
    const candidate = typeof versionId === 'number' ? supplied.get(versionId) : undefined;
    if (!candidate) throw new InvalidReasoningOutputError(`${label} is for version ${String(versionId)}, which was not supplied`);
    if (byVersion.has(candidate.versionId)) {
      throw new InvalidReasoningOutputError(`${label} repeats the assessment of version ${candidate.versionId}`);
    }
    if (record['artifactId'] !== candidate.artifactId || record['path'] !== candidate.path) {
      throw new InvalidReasoningOutputError(
        `${label} names artifact ${String(record['artifactId'])} at ${JSON.stringify(record['path'])} for version ${candidate.versionId}, which is artifact ${candidate.artifactId} at ${JSON.stringify(candidate.path)}`,
      );
    }
    const classification = record['classification'];
    if (!isClassification(classification)) {
      throw new InvalidReasoningOutputError(`${label} has classification ${JSON.stringify(classification)}, which is not permitted`);
    }
    const findings = validateFindings(record['findings'], candidate, classification, label, input.change);
    statementChars += findings.reduce((total, finding) => total + finding.statement.length, 0);
    byVersion.set(candidate.versionId, {
      artifactId: candidate.artifactId,
      versionId: candidate.versionId,
      path: candidate.path,
      classification,
      findings,
    });
  });

  const missing = input.candidates.filter((candidate) => !byVersion.has(candidate.versionId));
  if (missing.length > 0) {
    throw new InvalidReasoningOutputError(`The output has no assessment for ${missing.map((m) => JSON.stringify(m.path)).join(', ')}`);
  }
  if (statementChars > MAX_REPORT_STATEMENT_CHARS) {
    throw new InvalidReasoningOutputError(`The findings total ${statementChars} characters; at most ${MAX_REPORT_STATEMENT_CHARS} are accepted`);
  }
  return input.candidates.map((candidate) => byVersion.get(candidate.versionId)!);
}

function validateFindings(
  raw: unknown,
  candidate: ReasoningCandidate,
  classification: ImpactClassification,
  label: string,
  change: ReasoningInput['change'],
): Finding[] {
  if (!Array.isArray(raw)) throw new InvalidReasoningOutputError(`${label} has no list of findings`);
  if (raw.length > MAX_FINDINGS_PER_CANDIDATE) {
    throw new InvalidReasoningOutputError(`${label} has ${raw.length} findings; at most ${MAX_FINDINGS_PER_CANDIDATE} are accepted`);
  }
  if (raw.length === 0 && classification !== 'insufficient_evidence') {
    throw new InvalidReasoningOutputError(`${label} is ${classification} but has no finding to support it`);
  }

  const own = new Map(candidate.evidence.map((evidence) => [evidence.id, evidence]));
  const citedByAssessment: Evidence[] = [];
  const findings = raw.map((entry: unknown, index) => {
    const where = `${label}, finding ${index}`;
    const record = asRecord(entry, where, ['statement', 'evidenceIds']);
    const statement = record['statement'];
    if (typeof statement !== 'string' || statement.trim().length === 0) {
      throw new InvalidReasoningOutputError(`${where} has no statement`);
    }
    if (statement.length > MAX_STATEMENT_CHARS) {
      throw new InvalidReasoningOutputError(`${where} has a statement of ${statement.length} characters; at most ${MAX_STATEMENT_CHARS} are accepted`);
    }
    const ids = record['evidenceIds'];
    if (!Array.isArray(ids) || ids.length === 0) throw new InvalidReasoningOutputError(`${where} cites no evidence`);
    if (ids.length > MAX_EVIDENCE_IDS_PER_FINDING) {
      throw new InvalidReasoningOutputError(`${where} cites ${ids.length} evidence items; at most ${MAX_EVIDENCE_IDS_PER_FINDING} are accepted`);
    }
    const seen = new Set<string>();
    for (const id of ids as unknown[]) {
      if (typeof id !== 'string') throw new InvalidReasoningOutputError(`${where} cites an evidence id that is not a string`);
      if (!own.has(id)) {
        throw new InvalidReasoningOutputError(`${where} cites ${JSON.stringify(id)}, which is not evidence of ${JSON.stringify(candidate.path)}`);
      }
      if (seen.has(id)) throw new InvalidReasoningOutputError(`${where} cites ${JSON.stringify(id)} twice`);
      seen.add(id);
    }
    // Citations are known to be this candidate's own evidence here; only then is what the
    // statement claims compared with the cited objects.
    const cited = (ids as string[]).map((id) => own.get(id)!);
    const problem = findingGroundingProblem(statement, cited, { candidate, change }, where);
    if (problem) throw new InvalidReasoningOutputError(problem);
    citedByAssessment.push(...cited);
    return { statement, evidenceIds: ids as string[] };
  });
  const problem = classificationGroundingProblem(classification, citedByAssessment, label);
  if (problem) throw new InvalidReasoningOutputError(problem);
  return findings;
}

function asRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidReasoningOutputError(`${label} is not an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (!(key in record)) throw new InvalidReasoningOutputError(`${label} has no ${key}`);
  }
  const unexpected = Object.keys(record).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) throw new InvalidReasoningOutputError(`${label} has unexpected fields: ${unexpected.join(', ')}`);
  return record;
}

function isClassification(value: unknown): value is ImpactClassification {
  return typeof value === 'string' && (IMPACT_CLASSIFICATIONS as readonly string[]).includes(value);
}
