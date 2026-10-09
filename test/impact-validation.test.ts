import { describe, expect, it } from 'vitest';
import type { FusionEvidence } from '../src/retrieval/evidence.js';
import {
  IMPACT_CLASSIFICATIONS,
  InvalidReasoningOutputError,
  MAX_EVIDENCE_IDS_PER_FINDING,
  MAX_FINDINGS_PER_CANDIDATE,
  MAX_REPORT_STATEMENT_CHARS,
  MAX_STATEMENT_CHARS,
  validateImpactOutput,
} from '../src/reasoning/impact-report.js';
import type { ReasoningCandidate, ReasoningInput } from '../src/reasoning/provider.js';

function evidence(id: string): FusionEvidence {
  return { type: 'fusion', id, fusedRank: 1, rrfScore: 2 / 61, k: 60, deterministic: { rank: 1, contribution: 1 / 61 }, semantic: { rank: 1, contribution: 1 / 61 } };
}

function candidate(n: number, path = `src/f${n}.ts`, ids: string[] = [`e${n}a`, `e${n}b`]): ReasoningCandidate {
  return { artifactId: n, versionId: 100 + n, path, kind: 'code', evidence: ids.map(evidence) };
}

const INPUT: ReasoningInput = {
  snapshot: { id: 7, commitSha: 'a'.repeat(40) },
  change: { description: 'Fix the lock', changedPaths: ['src/lock.ts'] },
  candidates: [candidate(1), candidate(2), candidate(3)],
};

type Assessment = Record<string, unknown>;

function assessment(n: number, overrides: Assessment = {}): Assessment {
  return {
    artifactId: n,
    versionId: 100 + n,
    path: `src/f${n}.ts`,
    classification: 'potentially_affected',
    findings: [{ statement: `Candidate ${n} imports the changed file.`, evidenceIds: [`e${n}a`] }],
    ...overrides,
  };
}

function output(assessments: unknown[] = [assessment(1), assessment(2), assessment(3)], overrides: Assessment = {}): unknown {
  return { snapshotId: 7, assessments, ...overrides };
}

const rejects = (value: unknown, pattern: RegExp, input: ReasoningInput = INPUT) => {
  expect(() => validateImpactOutput(value, input)).toThrow(InvalidReasoningOutputError);
  expect(() => validateImpactOutput(value, input)).toThrow(pattern);
};

describe('validateImpactOutput accepts', () => {
  it('a complete, consistent assessment of every candidate', () => {
    const result = validateImpactOutput(output(), INPUT);

    expect(result.map((a) => [a.artifactId, a.versionId, a.path, a.classification])).toEqual([
      [1, 101, 'src/f1.ts', 'potentially_affected'],
      [2, 102, 'src/f2.ts', 'potentially_affected'],
      [3, 103, 'src/f3.ts', 'potentially_affected'],
    ]);
    expect(result[0]!.findings).toEqual([{ statement: 'Candidate 1 imports the changed file.', evidenceIds: ['e1a'] }]);
  });

  it('each permitted classification', () => {
    for (const classification of IMPACT_CLASSIFICATIONS) {
      const result = validateImpactOutput(output([assessment(1, { classification }), assessment(2), assessment(3)]), INPUT);
      expect(result[0]!.classification).toBe(classification);
    }
  });

  it('an abstention with no findings, or with cited ones', () => {
    const none = validateImpactOutput(output([assessment(1, { classification: 'insufficient_evidence', findings: [] }), assessment(2), assessment(3)]), INPUT);
    expect(none[0]).toMatchObject({ classification: 'insufficient_evidence', findings: [] });

    const cited = validateImpactOutput(
      output([assessment(1, { classification: 'insufficient_evidence', findings: [{ statement: 'Only a similarity score.', evidenceIds: ['e1b'] }] }), assessment(2), assessment(3)]),
      INPUT,
    );
    expect(cited[0]!.findings).toHaveLength(1);
  });

  it('several findings citing several evidence items of the candidate', () => {
    const findings = [
      { statement: 'First.', evidenceIds: ['e1a', 'e1b'] },
      { statement: 'Second.', evidenceIds: ['e1b'] },
    ];
    expect(validateImpactOutput(output([assessment(1, { findings }), assessment(2), assessment(3)]), INPUT)[0]!.findings).toEqual(findings);
  });

  it('assessments in any order, and returns them in the order of the candidates supplied', () => {
    const shuffled = validateImpactOutput(output([assessment(3), assessment(1), assessment(2)]), INPUT);
    expect(shuffled.map((a) => a.artifactId)).toEqual([1, 2, 3]);
    expect(shuffled).toEqual(validateImpactOutput(output(), INPUT));
  });

  it('is deterministic', () => {
    expect(validateImpactOutput(output(), INPUT)).toEqual(validateImpactOutput(output(), INPUT));
  });

  it('an empty list for an empty input', () => {
    expect(validateImpactOutput({ snapshotId: 7, assessments: [] }, { ...INPUT, candidates: [] })).toEqual([]);
  });
});

describe('validateImpactOutput rejects malformed output', () => {
  it('output that is not an object', () => {
    for (const value of [undefined, null, 'likely_affected', 42, [], [assessment(1)]]) rejects(value, /is not an object/);
  });

  it('missing or unexpected top-level fields', () => {
    rejects({ assessments: [] }, /has no snapshotId/);
    rejects({ snapshotId: 7 }, /has no assessments/);
    rejects(output(undefined, { verdict: 'all affected' }), /unexpected fields: verdict/);
    rejects(output('nope' as unknown as unknown[]), /no list of assessments/);
  });

  it('an assessment that is missing a field, has an unexpected one, or the wrong types', () => {
    const without = (key: string) => {
      const copy = assessment(1);
      delete copy[key];
      return copy;
    };
    for (const key of ['artifactId', 'versionId', 'path', 'classification', 'findings']) {
      rejects(output([without(key), assessment(2), assessment(3)]), new RegExp(`has no ${key}`));
    }
    rejects(output([assessment(1, { confidence: 0.9 }), assessment(2), assessment(3)]), /unexpected fields: confidence/);
    rejects(output([assessment(1, { versionId: '101' }), assessment(2), assessment(3)]), /which was not supplied/);
    rejects(output([assessment(1, { artifactId: '1' }), assessment(2), assessment(3)]), /names artifact/);
    rejects(output([assessment(1, { findings: 'many' }), assessment(2), assessment(3)]), /no list of findings/);
    rejects(output([null, assessment(2), assessment(3)]), /Assessment 0 is not an object/);
  });

  it('a classification outside the approved set', () => {
    for (const classification of ['definitely_affected', 'LIKELY_AFFECTED', 'affected', '', null, 3, undefined]) {
      rejects(output([assessment(1, { classification }), assessment(2), assessment(3)]), /which is not permitted/);
    }
  });

  it('a different snapshot', () => {
    rejects(output(undefined, { snapshotId: 8 }), /snapshot 8, not snapshot 7/);
    rejects(output(undefined, { snapshotId: '7' }), /snapshot 7, not snapshot 7/);
  });
});

describe('validateImpactOutput checks candidate membership exactly', () => {
  it('a missing candidate', () => {
    rejects(output([assessment(1), assessment(3)]), /no assessment for "src\/f2\.ts"/);
    rejects({ snapshotId: 7, assessments: [] }, /no assessment for/);
  });

  it('a duplicated candidate', () => {
    rejects(output([assessment(1), assessment(1), assessment(3)]), /repeats the assessment of version 101/);
  });

  it('an unexpected candidate', () => {
    rejects(output([assessment(1), assessment(2), assessment(9)]), /version 109, which was not supplied/);
    rejects(output([assessment(1), assessment(2), assessment(3), assessment(9)]), /4 assessments for 3 candidates/);
  });

  it('an artifact, version or path that differs from the one supplied', () => {
    rejects(output([assessment(1, { artifactId: 2 }), assessment(2), assessment(3)]), /names artifact 2 at "src\/f1\.ts" for version 101, which is artifact 1/);
    rejects(output([assessment(1, { path: 'src/other.ts' }), assessment(2), assessment(3)]), /names artifact 1 at "src\/other\.ts"/);
    rejects(output([assessment(1, { versionId: 102 }), assessment(2), assessment(3)]), /names artifact 1 at "src\/f1\.ts" for version 102, which is artifact 2/);
  });
});

describe('validateImpactOutput checks findings and their citations', () => {
  const withFindings = (findings: unknown) => output([assessment(1, { findings }), assessment(2), assessment(3)]);

  it('a hallucinated evidence id', () => {
    rejects(withFindings([{ statement: 'Made up.', evidenceIds: ['e1z'] }]), /cites "e1z", which is not evidence of "src\/f1\.ts"/);
  });

  it('evidence that belongs to another candidate', () => {
    rejects(withFindings([{ statement: 'Borrowed.', evidenceIds: ['e2a'] }]), /cites "e2a", which is not evidence of "src\/f1\.ts"/);
    rejects(withFindings([{ statement: 'Partly borrowed.', evidenceIds: ['e1a', 'e3b'] }]), /"e3b"/);
  });

  it('a substantive classification with no findings', () => {
    for (const classification of ['likely_affected', 'potentially_affected', 'no_impact_indicated']) {
      rejects(output([assessment(1, { classification, findings: [] }), assessment(2), assessment(3)]), new RegExp(`is ${classification} but has no finding`));
    }
  });

  it('a finding that cites nothing, in any form', () => {
    rejects(withFindings([{ statement: 'Uncited.', evidenceIds: [] }]), /cites no evidence/);
    rejects(withFindings([{ statement: 'Uncited.', evidenceIds: 'e1a' }]), /cites no evidence/);
    rejects(withFindings([{ statement: 'Uncited.' }]), /has no evidenceIds/);
  });

  it('cited ids that are not strings, or are repeated', () => {
    rejects(withFindings([{ statement: 'x', evidenceIds: [1] }]), /not a string/);
    rejects(withFindings([{ statement: 'x', evidenceIds: ['e1a', 'e1a'] }]), /cites "e1a" twice/);
  });

  it('an empty, missing or non-string statement, and unexpected finding fields', () => {
    rejects(withFindings([{ statement: '   ', evidenceIds: ['e1a'] }]), /has no statement/);
    rejects(withFindings([{ statement: 7, evidenceIds: ['e1a'] }]), /has no statement/);
    rejects(withFindings([{ evidenceIds: ['e1a'] }]), /has no statement/);
    rejects(withFindings([{ statement: 'x', evidenceIds: ['e1a'], severity: 'high' }]), /unexpected fields: severity/);
    rejects(withFindings(['just text']), /finding 0 is not an object/);
  });

  it('is bounded: statement length, findings per candidate, citations per finding, total size', () => {
    rejects(withFindings([{ statement: 'x'.repeat(MAX_STATEMENT_CHARS + 1), evidenceIds: ['e1a'] }]), /at most 1000 are accepted/);
    expect(validateImpactOutput(withFindings([{ statement: 'x'.repeat(MAX_STATEMENT_CHARS), evidenceIds: ['e1a'] }]), INPUT)).toHaveLength(3);

    const tooMany = Array.from({ length: MAX_FINDINGS_PER_CANDIDATE + 1 }, (_, i) => ({ statement: `s${i}`, evidenceIds: ['e1a'] }));
    rejects(withFindings(tooMany), /at most 10 are accepted/);

    const manyIds = Array.from({ length: MAX_EVIDENCE_IDS_PER_FINDING + 1 }, (_, i) => `id${i}`);
    const crowded: ReasoningInput = { ...INPUT, candidates: [candidate(1, 'src/f1.ts', manyIds), candidate(2), candidate(3)] };
    rejects(withFindings([{ statement: 'x', evidenceIds: manyIds }]), /at most 20 are accepted/, crowded);

    const many = Array.from({ length: 200 }, (_, n) => candidate(n + 1));
    const large: ReasoningInput = { ...INPUT, candidates: many };
    const verbose = many.map((c) =>
      assessment(c.artifactId, {
        findings: Array.from({ length: 10 }, (_, i) => ({ statement: 'y'.repeat(MAX_STATEMENT_CHARS), evidenceIds: [`e${c.artifactId}a`] })),
      }),
    );
    expect(MAX_REPORT_STATEMENT_CHARS).toBeLessThan(200 * 10 * MAX_STATEMENT_CHARS);
    rejects(output(verbose), /findings total/, large);
  });
});

describe('what validation does not establish', () => {
  it('accepts a well-formed claim whose truth it cannot check', () => {
    // Structure and references are verified; whether the statement follows from the evidence is not.
    const claim = [{ statement: 'This file is certainly broken by the change.', evidenceIds: ['e1a'] }];
    const result = validateImpactOutput(output([assessment(1, { classification: 'likely_affected', findings: claim }), assessment(2), assessment(3)]), INPUT);
    expect(result[0]).toMatchObject({ classification: 'likely_affected', findings: claim });
  });
});
