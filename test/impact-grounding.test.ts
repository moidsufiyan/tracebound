import { describe, expect, it } from 'vitest';
import type { FusionEvidence, LexicalEvidence, SemanticEvidence, StructuralEvidence } from '../src/retrieval/evidence.js';
import { IMPACT_REASONING_INSTRUCTIONS } from '../src/reasoning/impact-reasoning.js';
import { IMPACT_CLASSIFICATIONS, InvalidReasoningOutputError, validateImpactOutput } from '../src/reasoning/impact-report.js';
import type { ReasoningCandidate, ReasoningInput } from '../src/reasoning/provider.js';

// Grounding guards: narrowly targeted, deterministic checks of what a finding claims against the
// evidence objects it cites. Each case below is an objective mismatch observed in M8 runs, or a
// valid counterexample that must keep passing. Passing these checks does not make a finding true.

const CHANGED = { artifactId: 9, versionId: 90, path: 'src/utils/ipaddr.ts' };
const excerpt = (text: string) => ({ text, truncated: false, totalChars: text.length });

function structural(candidate: { artifactId: number; versionId: number; path: string }, direction: 'candidate-imports' | 'changed-imports' | 'test', text: string | null): StructuralEvidence {
  const candidateIsSource = direction !== 'changed-imports';
  const signal = direction === 'test' ? 'test-to-source' : direction === 'candidate-imports' ? 'incoming-import' : 'outgoing-import';
  const [source, target] = candidateIsSource ? [candidate, CHANGED] : [CHANGED, candidate];
  return {
    type: 'structural',
    id: `structural:${signal}:${source.versionId}>${target.versionId}`,
    snapshotId: 5,
    signal,
    relationship: signal === 'test-to-source' ? 'test-to-source' : 'imports',
    source,
    target,
    candidateIs: candidateIsSource ? 'source' : 'target',
    changedPath: CHANGED.path,
    declarations: text === null ? null : [{ specifier: './x', startLine: 1, endLine: 1, excerpt: excerpt(text) }],
  };
}
const lexical = (versionId: number, matchedTerms: string[], contentMatchCount: number, pathMatchCount: number): LexicalEvidence => ({
  type: 'lexical',
  id: `lexical:${versionId}`,
  matchedTerms,
  lexicalCategory: pathMatchCount > 0 ? 'path-only' : 'multiple-terms',
  contentMatchCount,
  pathMatchCount,
});
const semantic = (versionId: number, text: string): SemanticEvidence => ({
  type: 'semantic',
  id: `semantic:${versionId}:fake:0`,
  modelId: 'fake',
  similarityScore: 0.73,
  bestChunkIndex: 0,
  chunkCount: 1,
  embeddingInputHash: 'h'.repeat(64),
  chunk: excerpt(text),
});
const fusion = (versionId: number, fusedRank: number): FusionEvidence => ({
  type: 'fusion',
  id: `fusion:${versionId}:k60`,
  fusedRank,
  rrfScore: 2 / (60 + fusedRank),
  k: 60,
  deterministic: { rank: fusedRank, contribution: 1 / (60 + fusedRank) },
  semantic: { rank: fusedRank, contribution: 1 / (60 + fusedRank) },
});

// A test of the changed file: it imports it (test-to-source), and its best chunk is the import list only.
const TEST_ID = { artifactId: 1, versionId: 11, path: 'src/utils/ipaddr.test.ts' };
const IMPORT_ONLY = "import {\n  distinctRemoteAddr,\n  expandIPv6,\n} from './ipaddr'\n";
const TEST: ReasoningCandidate = {
  ...TEST_ID,
  kind: 'code',
  evidence: [
    structural(TEST_ID, 'test', IMPORT_ONLY),
    lexical(11, ['addresses', 'expandipv6', 'expand', 'ipaddr', 'ipv4', 'ipv6', 'utils'], 5, 2),
    semantic(11, IMPORT_ONLY),
    fusion(11, 1),
  ],
};
// A file the changed file imports (outgoing-import): the candidate is the dependency, not the dependent.
const DEP_ID = { artifactId: 2, versionId: 12, path: 'src/helper/conninfo/index.ts' };
const DEP: ReasoningCandidate = {
  ...DEP_ID,
  kind: 'code',
  evidence: [structural(DEP_ID, 'changed-imports', "import type { AddressType } from '../helper/conninfo'"), lexical(12, ['utils'], 1, 0), fusion(12, 20)],
};
// A file with no structural relationship, whose only lexical match is a path term.
const HEADERS_ID = { artifactId: 3, versionId: 13, path: 'src/utils/headers.ts' };
const HEADERS: ReasoningCandidate = {
  ...HEADERS_ID,
  kind: 'code',
  evidence: [lexical(13, ['utils'], 0, 1), semantic(13, "export type RequestHeader =\n  | 'Accept'\n  | 'Accept-Charset'\n"), fusion(13, 4)],
};

const INPUT: ReasoningInput = {
  snapshot: { id: 5, commitSha: 'e'.repeat(40) },
  change: { description: 'fix(utils/ipaddr): avoid truncation on embedded IPv4 addresses in expandIPv6', changedPaths: [CHANGED.path] },
  candidates: [TEST, DEP, HEADERS],
};

type Finding = { statement: string; evidenceIds: string[] };
const abstain = (c: ReasoningCandidate) => ({ artifactId: c.artifactId, versionId: c.versionId, path: c.path, classification: 'insufficient_evidence', findings: [] });

/** Validates one assessment of `candidate` (the others abstain). */
function check(candidate: ReasoningCandidate, classification: string, findings: Finding[]) {
  const assessments = INPUT.candidates.map((c) => (c === candidate ? { artifactId: c.artifactId, versionId: c.versionId, path: c.path, classification, findings } : abstain(c)));
  return () => validateImpactOutput({ snapshotId: 5, assessments }, INPUT);
}
const accepted = (candidate: ReasoningCandidate, classification: string, findings: Finding[]) => {
  expect(check(candidate, classification, findings)).not.toThrow();
};
const rejected = (candidate: ReasoningCandidate, classification: string, findings: Finding[], pattern: RegExp) => {
  expect(check(candidate, classification, findings)).toThrow(InvalidReasoningOutputError);
  expect(check(candidate, classification, findings)).toThrow(pattern);
};
const f = (statement: string, ...evidenceIds: string[]): Finding => ({ statement, evidenceIds });

describe('lexical claims', () => {
  it('rejects a claim that a queried term appears when no cited evidence records it (term fabrication)', () => {
    rejected(HEADERS, 'potentially_affected', [f("The file contains 'expandIPv6'.", 'lexical:13')], /contains "expandipv6", but no cited evidence records it/);
    rejected(HEADERS, 'potentially_affected', [f('The file mentions `ipv4` and `ipv6`.', 'lexical:13', 'fusion:13:k60')], /contains "ipv4"/);
  });

  it('accepts the same claim when the cited evidence records the term', () => {
    accepted(TEST, 'potentially_affected', [f("The file contains 'expandIPv6'.", 'lexical:11')]);
    accepted(TEST, 'potentially_affected', [f("The cited chunk mentions 'expandIPv6'.", 'semantic:11:fake:0')]);
    accepted(DEP, 'potentially_affected', [f("The changed file imports 'AddressType' from this file.", 'structural:outgoing-import:90>12')]);
  });

  it('does not judge quoted words the lexical query never looked for', () => {
    // 'RequestHeader' is not a query term, so lexical evidence is silent about it; the chunk shows it anyway.
    accepted(HEADERS, 'potentially_affected', [f("The file contains 'RequestHeader'.", 'semantic:13:fake:0')]);
    // Not shown by any cited evidence and not a query term: outside what can be checked deterministically.
    accepted(HEADERS, 'potentially_affected', [f("The file contains 'Accept-Language'.", 'lexical:13')]);
  });

  it('rejects a statement that a term is absent when the cited lexical evidence matched it in the content', () => {
    rejected(TEST, 'potentially_affected', [f("The file does not contain any references to 'IPv4'.", 'lexical:11')], /does not contain "ipv4", but the cited lexical evidence matched it in the content/);
    rejected(TEST, 'potentially_affected', [f("There are no references to 'addresses' or 'truncation'.", 'lexical:11')], /"addresses"/);
  });

  it('reads the subject before the verb and only the terms after it', () => {
    // The trailing mention of the change description does not exempt a claim about the candidate.
    rejected(TEST, 'potentially_affected', [f("The candidate file does not contain any references to 'IPv4', which are terms found in the change description.", 'lexical:11')], /does not contain "ipv4"/);
    // A clause whose subject is the change is about the change, not the candidate.
    accepted(HEADERS, 'potentially_affected', [f("The change description mentions 'expandIPv6'.", 'lexical:13')]);
    // 'utils' is the object of "use", not of "contain": only 'ipaddr' and 'truncation' are read.
    accepted(DEP, 'potentially_affected', [f("The candidate does not use the 'utils' module, nor does it contain any references to 'truncation'.", 'lexical:12')]);
  });

  it('accepts an absence statement the evidence does not contradict, including path-only matches', () => {
    // 'truncation' was looked for and not matched.
    accepted(TEST, 'potentially_affected', [f("The file does not contain any references to 'truncation'.", 'lexical:11')]);
    // 'utils' matched only in the path (no content match), so saying the content lacks it is not contradicted.
    accepted(HEADERS, 'potentially_affected', [f("The file content does not mention 'utils'.", 'lexical:13')]);
    // 'ipaddr' is a path term of this candidate, so a match does not prove it is in the content.
    accepted(TEST, 'potentially_affected', [f("The file does not mention 'ipaddr' in its code.", 'lexical:11')]);
  });

  it('does not let a lexical match count stand for a number of tests', () => {
    rejected(TEST, 'potentially_affected', [f("The file contains multiple tests that involve 'expandIPv6'.", 'lexical:11')], /states how many tests/);
    rejected(TEST, 'potentially_affected', [f('There are 5 test cases for this behaviour.', 'lexical:11', 'fusion:11:k60')], /states how many tests/);
    // With source text cited the count is a reading of that text, left to review.
    accepted(TEST, 'potentially_affected', [f('The file contains multiple tests.', 'semantic:11:fake:0')]);
  });
});

describe('import direction', () => {
  it('rejects "the candidate imports the changed file" when the cited edge is the other way round', () => {
    rejected(DEP, 'potentially_affected', [f('The candidate imports the changed file.', 'structural:outgoing-import:90>12')], /says the candidate imports the changed file, but the cited structural evidence records the changed file importing the candidate/);
    rejected(DEP, 'likely_affected', [f("The file imports from 'src/utils/ipaddr.ts', which is the changed file.", 'structural:outgoing-import:90>12')], /says the candidate imports the changed file/);
    rejected(DEP, 'potentially_affected', [f('The file imports conninfo/index.js, which is changed in the commit.', 'structural:outgoing-import:90>12')], /says the candidate imports the changed file/);
  });

  it('rejects "the changed file imports the candidate" when the cited edge is the other way round', () => {
    rejected(TEST, 'potentially_affected', [f('The changed file imports this test file.', 'structural:test-to-source:11>90')], /says the changed file imports the candidate, but the cited structural evidence records the candidate importing the changed file/);
    rejected(TEST, 'potentially_affected', [f('This file is imported by ipaddr.ts.', 'structural:test-to-source:11>90')], /says the changed file imports the candidate/);
  });

  it('accepts correctly directed statements, including ones whose subject is the changed file', () => {
    accepted(TEST, 'potentially_affected', [f('The test file imports the changed file src/utils/ipaddr.ts.', 'structural:test-to-source:11>90')]);
    accepted(DEP, 'potentially_affected', [f('The changed file imports this candidate.', 'structural:outgoing-import:90>12')]);
    accepted(DEP, 'potentially_affected', [f('ipaddr.ts imports AddressType from this file.', 'structural:outgoing-import:90>12')]);
    accepted(DEP, 'potentially_affected', [f('This file is imported by the changed file.', 'structural:outgoing-import:90>12')]);
    // No structural evidence cited: the direction cannot be checked, so the guard does not apply.
    accepted(HEADERS, 'potentially_affected', [f('The candidate imports the changed file.', 'lexical:13')]);
  });

  it('reads negated statements as negations', () => {
    // True statements about the cited edge.
    accepted(DEP, 'potentially_affected', [f('The candidate does not import the changed file.', 'structural:outgoing-import:90>12')]);
    accepted(TEST, 'potentially_affected', [f('The changed file does not import this test.', 'structural:test-to-source:11>90')]);
    // A denial contradicted by the cited edge.
    rejected(TEST, 'potentially_affected', [f('The candidate does not import or use the changed file.', 'structural:test-to-source:11>90')], /says the candidate does not import the changed file, but the cited structural evidence records that it does/);
  });

  it('does not treat a generic base name of a changed file as a reference to it', () => {
    const input: ReasoningInput = { ...INPUT, change: { ...INPUT.change, changedPaths: ['src/middleware/combine/index.ts'] } };
    const dep: ReasoningCandidate = { ...DEP, evidence: [{ ...(DEP.evidence[0] as StructuralEvidence), changedPath: 'src/middleware/combine/index.ts' }, ...DEP.evidence.slice(1)] };
    const assessments = [abstain(TEST), { ...DEP_ID, classification: 'potentially_affected', findings: [f('The candidate imports index.ts from ../utils.', 'structural:outgoing-import:90>12')] }, abstain(HEADERS)];
    expect(() => validateImpactOutput({ snapshotId: 5, assessments }, { ...input, candidates: [TEST, dep, HEADERS] })).not.toThrow();
  });
});

describe('symbol use and execution', () => {
  it('rejects a claim that the candidate uses a symbol when the cited text shows it only in an import', () => {
    rejected(TEST, 'potentially_affected', [f("The test file contains test cases that use the 'expandIPv6' function.", 'semantic:11:fake:0')], /uses "expandIPv6", but the cited source text shows it only in an import declaration/);
    rejected(TEST, 'potentially_affected', [f("It calls `expandIPv6`.", 'structural:test-to-source:11>90')], /only in an import declaration/);
  });

  it('rejects a use claim backed only by a keyword match or a score', () => {
    rejected(TEST, 'potentially_affected', [f("The tests exercise 'expandIPv6'.", 'lexical:11', 'fusion:11:k60')], /uses "expandIPv6", but no cited source text shows it/);
  });

  it('accepts a use claim when cited source text shows the symbol outside an import', () => {
    const calling: ReasoningCandidate = { ...TEST, evidence: [...TEST.evidence.slice(0, 2), semantic(11, `${IMPORT_ONLY}\nexpect(expandIPv6('::ffff:1.2.3.4')).toBe('0:0:0:0:0:ffff:102:304')\n`), TEST.evidence[3]!] };
    const input = { ...INPUT, candidates: [calling, DEP, HEADERS] };
    const assessments = [
      { ...TEST_ID, classification: 'potentially_affected', findings: [f("The test file contains test cases that use the 'expandIPv6' function.", 'semantic:11:fake:0')] },
      abstain(DEP),
      abstain(HEADERS),
    ];
    expect(() => validateImpactOutput({ snapshotId: 5, assessments }, input)).not.toThrow();
  });
});

describe('import stripping stays within import and re-export declarations', () => {
  const USE_CLAIM = "The test file contains test cases that use the 'expandIPv6' function.";
  /** Validates the use claim against a candidate whose cited chunk is `chunk`. */
  const checkChunk = (chunk: string) => {
    const candidate: ReasoningCandidate = { ...TEST, evidence: [...TEST.evidence.slice(0, 2), semantic(11, chunk), TEST.evidence[3]!] };
    const assessments = [{ ...TEST_ID, classification: 'potentially_affected', findings: [f(USE_CLAIM, 'semantic:11:fake:0')] }, abstain(DEP), abstain(HEADERS)];
    return () => validateImpactOutput({ snapshotId: 5, assessments }, { ...INPUT, candidates: [candidate, DEP, HEADERS] });
  };

  it('keeps a use that sits between a side-effect import and a later import', () => {
    expect(checkChunk("import './setup'\nconst padded = expandIPv6('::ffff:1.2.3.4')\nimport { post } from './ledger'\n")).not.toThrow();
  });

  it('keeps a use that follows the word import in a comment and precedes a later import', () => {
    expect(checkChunk("// import is deferred until first use\nexpandIPv6(address)\nimport { post } from './ledger'\n")).not.toThrow();
  });

  it('keeps a statement between a local export and a re-export', () => {
    expect(checkChunk("export { helper }\nexpandIPv6(address)\nexport { post } from './ledger'\n")).not.toThrow();
  });

  it('still strips import type, namespace, default-plus-named, multi-line and re-export declarations, so none of them shows use', () => {
    const only = /uses "expandIPv6", but the cited source text shows it only in an import declaration/;
    for (const declaration of [
      "import type { expandIPv6 } from './ipaddr'",
      "import * as expandIPv6 from './ipaddr'",
      "import ip, { expandIPv6 } from './ipaddr'",
      "import {\n  convertIPv4ToBinary,\n  expandIPv6,\n} from './ipaddr'",
      "export { expandIPv6 } from './ipaddr'",
      "import './setup'\nimport { expandIPv6 } from './ipaddr'",
    ]) {
      expect(checkChunk(`${declaration}\n`), declaration).toThrow(only);
    }
  });
});

describe('classification and evidence compatibility', () => {
  it('rejects likely_affected resting only on scores, ranks, similarity or keyword matches', () => {
    rejected(TEST, 'likely_affected', [f('The similarity score is high.', 'semantic:11:fake:0'), f('It is ranked first.', 'fusion:11:k60')], /likely_affected but cites no located structural relationship/);
    rejected(TEST, 'likely_affected', [f("The file contains 'expandIPv6'.", 'lexical:11')], /likely_affected but cites no located structural relationship/);
  });

  it('rejects likely_affected on a structural relationship whose import declaration was not located', () => {
    const unlocated: ReasoningCandidate = { ...TEST, evidence: [structural(TEST_ID, 'test', null), ...TEST.evidence.slice(1)] };
    const input = { ...INPUT, candidates: [unlocated, DEP, HEADERS] };
    const assessments = [{ ...TEST_ID, classification: 'likely_affected', findings: [f('The test file imports the changed file.', 'structural:test-to-source:11>90')] }, abstain(DEP), abstain(HEADERS)];
    expect(() => validateImpactOutput({ snapshotId: 5, assessments }, input)).toThrow(/cites no located structural relationship/);
  });

  it('accepts likely_affected citing a located structural relationship (necessary, not sufficient)', () => {
    accepted(TEST, 'likely_affected', [f('The test file imports the changed file.', 'structural:test-to-source:11>90'), f('It is ranked first.', 'fusion:11:k60')]);
  });

  it('rejects likely_affected on an outgoing-import edge (the changed file imports the candidate)', () => {
    rejected(
      DEP,
      'likely_affected',
      [f('The changed file imports AddressType from this file.', 'structural:outgoing-import:90>12')],
      /likely_affected but cites no located structural relationship/,
    );
  });

  it('accepts likely_affected on an incoming import (the candidate imports the changed file)', () => {
    const importerId = { artifactId: 4, versionId: 14, path: 'src/consumer.ts' };
    const importer: ReasoningCandidate = {
      ...importerId,
      kind: 'code',
      evidence: [structural(importerId, 'candidate-imports', "import { expandIPv6 } from './utils/ipaddr'"), fusion(14, 2)],
    };
    const input = { ...INPUT, candidates: [TEST, DEP, importer] };
    const assessments = [
      abstain(TEST),
      abstain(DEP),
      { ...importerId, classification: 'likely_affected', findings: [f('The candidate imports the changed file.', 'structural:incoming-import:14>90')] },
    ];
    expect(() => validateImpactOutput({ snapshotId: 5, assessments }, input)).not.toThrow();
  });

  it('rejects no_impact_indicated: no current evidence type can show that the change does not affect a file', () => {
    rejected(HEADERS, 'no_impact_indicated', [f('The change does not affect the candidate.', 'lexical:13')], /no_impact_indicated, but none of its cited evidence can show/);
    rejected(HEADERS, 'no_impact_indicated', [f('The similarity score is low.', 'semantic:13:fake:0'), f('The rank is low.', 'fusion:13:k60')], /no_impact_indicated/);
    rejected(DEP, 'no_impact_indicated', [f('Only the changed file imports this one.', 'structural:outgoing-import:90>12')], /no_impact_indicated/);
  });

  it('still accepts the abstaining classifications on the same evidence', () => {
    accepted(HEADERS, 'insufficient_evidence', [f('Only a path term matched.', 'lexical:13')]);
    accepted(HEADERS, 'potentially_affected', [f('The file is in the same directory as the changed file.', 'lexical:13')]);
  });
});

describe('instructions and validator agree on no_impact_indicated', () => {
  // Temporary policy: no current evidence type can show non-impact, so the validator rejects
  // no_impact_indicated whatever is cited, and the instructions must tell the model not to use it.
  // If an evidence type able to show non-impact is ever added, this test fails until both are changed.
  it('the validator rejects it on every evidence type, alone and together', () => {
    for (const evidence of TEST.evidence) {
      rejected(TEST, 'no_impact_indicated', [f('The change does not affect this file.', evidence.id)], /no_impact_indicated, but none of its cited evidence can show/);
    }
    rejected(TEST, 'no_impact_indicated', [f('The change does not affect this file.', ...TEST.evidence.map((e) => e.id))], /no_impact_indicated/);
  });

  it('the instructions forbid it, say why, and name the classifications to use instead', () => {
    expect(IMPACT_REASONING_INSTRUCTIONS).toMatch(/Do not answer no_impact_indicated\./);
    expect(IMPACT_REASONING_INSTRUCTIONS).toMatch(/An answer that uses it is rejected\./);
    expect(IMPACT_REASONING_INSTRUCTIONS).toMatch(/When you find no relationship, answer insufficient_evidence; when there is a plausible relationship the evidence does not establish, answer potentially_affected\./);
    // It is not offered as one of the classifications to choose from.
    const options = IMPACT_REASONING_INSTRUCTIONS.split('Classify each candidate as exactly one of these three:')[1]!.split('\nDo not answer')[0]!;
    expect(options.match(/^- (\w+):/gm)).toEqual(['- likely_affected:', '- potentially_affected:', '- insufficient_evidence:']);
  });

  it('every classification the instructions offer can be accepted on suitable evidence', () => {
    accepted(TEST, 'likely_affected', [f('The test file imports the changed file.', 'structural:test-to-source:11>90')]);
    accepted(TEST, 'potentially_affected', [f('The test file imports the changed file.', 'structural:test-to-source:11>90')]);
    accepted(HEADERS, 'insufficient_evidence', []);
    expect(IMPACT_CLASSIFICATIONS).toContain('no_impact_indicated'); // the output schema keeps the value
  });
});

describe('existing integrity guarantees come first', () => {
  it('still rejects a citation of another candidate before judging what the statement says', () => {
    rejected(DEP, 'potentially_affected', [f('The test file imports the changed file.', 'structural:test-to-source:11>90')], /cites "structural:test-to-source:11>90", which is not evidence of "src\/helper\/conninfo\/index\.ts"/);
  });
});
