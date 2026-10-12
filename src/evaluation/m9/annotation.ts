// The Phase 1 annotation record (schema 1.1.0): one record per candidate and annotator. The schema
// version is the version of this record format, not of the evaluation protocol. Field names are the
// protocol's (snake_case) and are not translated.

export const ANNOTATION_SCHEMA_VERSION = '1.1.0';
export const ANNOTATION_PHASE = 'phase_1_blinded_evidence_judgment';
export const ANNOTATOR_IDS = ['REV-01', 'REV-02'] as const;
export const CLASSIFICATIONS = ['likely_affected', 'potentially_affected', 'no_impact_indicated', 'insufficient_evidence'] as const;
export const EVIDENCE_SUFFICIENCY = ['fully_sufficient', 'partially_sufficient', 'completely_inadequate'] as const;

/** What the frozen manifest says about one candidate; the template is pre-populated from it. */
export interface CandidateIdentity {
  caseId: string;
  path: string;
  artifactId: number;
  versionId: number;
  contentSha256: string;
}

export interface AnnotationRecord {
  schema_version: string;
  annotation_phase: string;
  annotator_id: string;
  annotated_at: string;
  evaluation_record: {
    case_id: string;
    candidate_path: string;
    candidate_artifact_id: number;
    candidate_version_id: number;
    candidate_content_sha256: string;
    reference_assessment: {
      classification: string;
      primary_rationale: string;
      cited_evidence_ids: string[];
      evidence_sufficiency: string;
      perceived_ambiguity: { has_contract_ambiguity: boolean; ambiguity_explanation: string | null };
      unresolved_uncertainty: string;
    };
    blinding_verification: {
      reviewed_diffs_or_hindsight: boolean;
      reviewed_other_annotator: boolean;
      reviewed_model_outputs: boolean;
    };
  };
}

/**
 * The blank record for one candidate: identity filled from the frozen manifest, everything the
 * reviewer judges left empty, and no blinding violation claimed. The annotator fills in
 * `annotator_id` (REV-01 or REV-02) and `annotated_at`.
 */
export function buildAnnotationTemplate(identity: CandidateIdentity): AnnotationRecord {
  return {
    schema_version: ANNOTATION_SCHEMA_VERSION,
    annotation_phase: ANNOTATION_PHASE,
    annotator_id: '',
    annotated_at: '',
    evaluation_record: {
      case_id: identity.caseId,
      candidate_path: identity.path,
      candidate_artifact_id: identity.artifactId,
      candidate_version_id: identity.versionId,
      candidate_content_sha256: identity.contentSha256,
      reference_assessment: {
        classification: '',
        primary_rationale: '',
        cited_evidence_ids: [],
        evidence_sufficiency: '',
        perceived_ambiguity: { has_contract_ambiguity: false, ambiguity_explanation: null },
        unresolved_uncertainty: '',
      },
      blinding_verification: { reviewed_diffs_or_hindsight: false, reviewed_other_annotator: false, reviewed_model_outputs: false },
    },
  };
}

const TOP_KEYS = ['schema_version', 'annotation_phase', 'annotator_id', 'annotated_at', 'evaluation_record'];
const RECORD_KEYS = [
  'case_id',
  'candidate_path',
  'candidate_artifact_id',
  'candidate_version_id',
  'candidate_content_sha256',
  'reference_assessment',
  'blinding_verification',
];
const ASSESSMENT_KEYS = ['classification', 'primary_rationale', 'cited_evidence_ids', 'evidence_sufficiency', 'perceived_ambiguity', 'unresolved_uncertainty'];
const AMBIGUITY_KEYS = ['has_contract_ambiguity', 'ambiguity_explanation'];
const BLINDING_KEYS = ['reviewed_diffs_or_hindsight', 'reviewed_other_annotator', 'reviewed_model_outputs'];
const ANNOTATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Problems with a completed record for `identity`; an empty list means it is acceptable. `evidenceIds`
 * are the ids of that candidate's own evidence in the packet it was annotated from. A record that
 * claims to have seen hindsight material, another annotator's judgment or model output is reported
 * as a blinding violation: it must not be counted as an independent blinded judgment.
 */
export function validateCompletedAnnotation(record: unknown, identity: CandidateIdentity, evidenceIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (!isObject(record)) return ['the record is not an object'];
  const exactKeys = (value: Obj, keys: string[], label: string): void => {
    for (const key of keys) if (!(key in value)) problems.push(`${label} lacks ${key}`);
    for (const key of Object.keys(value)) if (!keys.includes(key)) problems.push(`${label} has unexpected ${key}`);
  };
  exactKeys(record, TOP_KEYS, 'record');
  if (record['schema_version'] !== ANNOTATION_SCHEMA_VERSION) problems.push(`schema_version must be ${ANNOTATION_SCHEMA_VERSION}`);
  if (record['annotation_phase'] !== ANNOTATION_PHASE) problems.push(`annotation_phase must be ${ANNOTATION_PHASE}`);
  if (!(ANNOTATOR_IDS as readonly unknown[]).includes(record['annotator_id'])) problems.push(`annotator_id must be one of ${ANNOTATOR_IDS.join(', ')}`);
  const at = record['annotated_at'];
  if (typeof at !== 'string' || !ANNOTATED_AT.test(at) || Number.isNaN(Date.parse(at))) problems.push('annotated_at must be a UTC time like 2026-01-31T09:30:00Z');

  const evaluation = record['evaluation_record'];
  if (!isObject(evaluation)) return [...problems, 'evaluation_record is not an object'];
  exactKeys(evaluation, RECORD_KEYS, 'evaluation_record');
  const expected: [string, unknown][] = [
    ['case_id', identity.caseId],
    ['candidate_path', identity.path],
    ['candidate_artifact_id', identity.artifactId],
    ['candidate_version_id', identity.versionId],
    ['candidate_content_sha256', identity.contentSha256],
  ];
  for (const [key, value] of expected) if (evaluation[key] !== value) problems.push(`${key} does not match the frozen candidate`);

  const assessment = evaluation['reference_assessment'];
  if (!isObject(assessment)) {
    problems.push('reference_assessment is not an object');
  } else {
    exactKeys(assessment, ASSESSMENT_KEYS, 'reference_assessment');
    if (!(CLASSIFICATIONS as readonly unknown[]).includes(assessment['classification'])) problems.push(`classification must be one of ${CLASSIFICATIONS.join(', ')}`);
    if (typeof assessment['primary_rationale'] !== 'string' || assessment['primary_rationale'].trim() === '') problems.push('primary_rationale must be a non-empty string');
    const cited = assessment['cited_evidence_ids'];
    if (!Array.isArray(cited) || cited.length === 0 || cited.some((id) => typeof id !== 'string')) {
      problems.push('cited_evidence_ids must be a non-empty list of evidence ids');
    } else {
      if (new Set(cited).size !== cited.length) problems.push('cited_evidence_ids repeats an id');
      for (const id of cited) if (!evidenceIds.has(id as string)) problems.push(`cited evidence id ${String(id)} is not evidence of this candidate`);
    }
    if (!(EVIDENCE_SUFFICIENCY as readonly unknown[]).includes(assessment['evidence_sufficiency'])) problems.push(`evidence_sufficiency must be one of ${EVIDENCE_SUFFICIENCY.join(', ')}`);
    const ambiguity = assessment['perceived_ambiguity'];
    if (!isObject(ambiguity)) {
      problems.push('perceived_ambiguity is not an object');
    } else {
      exactKeys(ambiguity, AMBIGUITY_KEYS, 'perceived_ambiguity');
      const has = ambiguity['has_contract_ambiguity'];
      const explanation = ambiguity['ambiguity_explanation'];
      if (typeof has !== 'boolean') problems.push('has_contract_ambiguity must be a boolean');
      else if (has && (typeof explanation !== 'string' || explanation.trim() === '')) problems.push('an ambiguity needs an explanation');
      else if (!has && explanation !== null) problems.push('ambiguity_explanation must be null without an ambiguity');
    }
    if (typeof assessment['unresolved_uncertainty'] !== 'string') problems.push('unresolved_uncertainty must be a string');
  }

  const blinding = evaluation['blinding_verification'];
  if (!isObject(blinding)) {
    problems.push('blinding_verification is not an object');
  } else {
    exactKeys(blinding, BLINDING_KEYS, 'blinding_verification');
    for (const key of BLINDING_KEYS) {
      if (typeof blinding[key] !== 'boolean') problems.push(`${key} must be a boolean`);
      else if (blinding[key] === true) problems.push(`blinding violation: ${key} is true, so this is not an independent blinded judgment`);
    }
  }
  return problems;
}
