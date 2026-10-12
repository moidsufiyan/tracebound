import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_PHASE,
  ANNOTATION_SCHEMA_VERSION,
  buildAnnotationTemplate,
  CLASSIFICATIONS,
  EVIDENCE_SUFFICIENCY,
  validateCompletedAnnotation,
  type AnnotationRecord,
  type CandidateIdentity,
} from '../src/evaluation/m9/annotation.js';

const IDENTITY: CandidateIdentity = {
  caseId: 'TB-0009',
  path: 'src/helper/streaming/stream.ts',
  artifactId: 647,
  versionId: 3576,
  contentSha256: '97d240f56482dedd1891067ae12c48e5a99cab8a6611eacef425582801d261d7',
};
const EVIDENCE = new Set(['lexical:3576', 'fusion:3576:k60', 'structural:incoming-import:3576>3774']);

function completed(change: (record: AnnotationRecord) => void = () => undefined): AnnotationRecord {
  const record = buildAnnotationTemplate(IDENTITY);
  record.annotator_id = 'REV-01';
  record.annotated_at = '2026-10-13T09:30:00Z';
  const assessment = record.evaluation_record.reference_assessment;
  assessment.classification = 'potentially_affected';
  assessment.primary_rationale = 'It imports the changed utility but the change is internal.';
  assessment.cited_evidence_ids = ['structural:incoming-import:3576>3774'];
  assessment.evidence_sufficiency = 'partially_sufficient';
  change(record);
  return record;
}

describe('the annotation template (schema 1.1.0)', () => {
  it('matches the authoritative contract field by field, with identity filled and judgments blank', () => {
    expect(buildAnnotationTemplate(IDENTITY)).toStrictEqual({
      schema_version: '1.1.0',
      annotation_phase: 'phase_1_blinded_evidence_judgment',
      annotator_id: '',
      annotated_at: '',
      evaluation_record: {
        case_id: 'TB-0009',
        candidate_path: 'src/helper/streaming/stream.ts',
        candidate_artifact_id: 647,
        candidate_version_id: 3576,
        candidate_content_sha256: IDENTITY.contentSha256,
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
    });
    expect(ANNOTATION_SCHEMA_VERSION).toBe('1.1.0');
    expect(ANNOTATION_PHASE).toBe('phase_1_blinded_evidence_judgment');
    expect(CLASSIFICATIONS).toEqual(['likely_affected', 'potentially_affected', 'no_impact_indicated', 'insufficient_evidence']);
    expect(EVIDENCE_SUFFICIENCY).toEqual(['fully_sufficient', 'partially_sufficient', 'completely_inadequate']);
  });

  it('is not itself an acceptable completed record', () => {
    expect(validateCompletedAnnotation(buildAnnotationTemplate(IDENTITY), IDENTITY, EVIDENCE).length).toBeGreaterThan(4);
  });
});

describe('validateCompletedAnnotation', () => {
  it("accepts a complete, blinded record that cites the candidate's own evidence", () => {
    expect(validateCompletedAnnotation(completed(), IDENTITY, EVIDENCE)).toEqual([]);
  });

  it('accepts a stated ambiguity with its explanation', () => {
    const record = completed((r) => {
      r.evaluation_record.reference_assessment.perceived_ambiguity = { has_contract_ambiguity: true, ambiguity_explanation: 'The contract does not say whether abort listeners may throw.' };
      r.annotator_id = 'REV-02';
    });
    expect(validateCompletedAnnotation(record, IDENTITY, EVIDENCE)).toEqual([]);
  });

  const cases: [string, (r: AnnotationRecord) => void, RegExp][] = [
    ['an unknown classification', (r) => (r.evaluation_record.reference_assessment.classification = 'affected'), /classification/],
    ['a blank classification', (r) => (r.evaluation_record.reference_assessment.classification = ''), /classification/],
    ['an empty rationale', (r) => (r.evaluation_record.reference_assessment.primary_rationale = '  '), /primary_rationale/],
    ['no cited evidence', (r) => (r.evaluation_record.reference_assessment.cited_evidence_ids = []), /cited_evidence_ids/],
    ['evidence of another candidate', (r) => (r.evaluation_record.reference_assessment.cited_evidence_ids = ['lexical:99']), /not evidence of this candidate/],
    ['a repeated evidence id', (r) => (r.evaluation_record.reference_assessment.cited_evidence_ids = ['lexical:3576', 'lexical:3576']), /repeats/],
    ['an unknown sufficiency', (r) => (r.evaluation_record.reference_assessment.evidence_sufficiency = 'enough'), /evidence_sufficiency/],
    ['an ambiguity without explanation', (r) => (r.evaluation_record.reference_assessment.perceived_ambiguity = { has_contract_ambiguity: true, ambiguity_explanation: null }), /needs an explanation/],
    ['an explanation without an ambiguity', (r) => (r.evaluation_record.reference_assessment.perceived_ambiguity = { has_contract_ambiguity: false, ambiguity_explanation: 'x' }), /must be null/],
    ['an unknown annotator', (r) => (r.annotator_id = 'REV-03'), /annotator_id/],
    ['a time that is not UTC', (r) => (r.annotated_at = '2026-10-13T09:30:00+05:30'), /annotated_at/],
    ['another schema version', (r) => (r.schema_version = '1.0.0'), /schema_version/],
    ["another candidate's identity", (r) => (r.evaluation_record.candidate_version_id = 1), /candidate_version_id/],
    ['a changed content hash', (r) => (r.evaluation_record.candidate_content_sha256 = '0'.repeat(64)), /candidate_content_sha256/],
  ];
  for (const [name, change, expected] of cases) {
    it(`rejects ${name}`, () => {
      expect(validateCompletedAnnotation(completed(change), IDENTITY, EVIDENCE).join('\n')).toMatch(expected);
    });
  }

  for (const key of ['reviewed_diffs_or_hindsight', 'reviewed_other_annotator', 'reviewed_model_outputs'] as const) {
    it(`does not count a record claiming ${key} as a blinded judgment`, () => {
      const problems = validateCompletedAnnotation(completed((r) => (r.evaluation_record.blinding_verification[key] = true)), IDENTITY, EVIDENCE);
      expect(problems.join('\n')).toMatch(new RegExp(`blinding violation: ${key}`));
    });
  }

  it('rejects extra, missing and mistyped fields', () => {
    const extra = completed() as unknown as Record<string, unknown>;
    extra['notes'] = 'x';
    expect(validateCompletedAnnotation(extra, IDENTITY, EVIDENCE).join('\n')).toMatch(/unexpected notes/);
    const missing = completed() as unknown as { evaluation_record: Record<string, unknown> };
    delete missing.evaluation_record['blinding_verification'];
    expect(validateCompletedAnnotation(missing, IDENTITY, EVIDENCE).join('\n')).toMatch(/blinding_verification/);
    const mistyped = completed((r) => ((r.evaluation_record.blinding_verification as unknown as Record<string, unknown>)['reviewed_model_outputs'] = 'no'));
    expect(validateCompletedAnnotation(mistyped, IDENTITY, EVIDENCE).join('\n')).toMatch(/must be a boolean/);
    expect(validateCompletedAnnotation(null, IDENTITY, EVIDENCE)).toEqual(['the record is not an object']);
  });
});
