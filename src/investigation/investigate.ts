import type { Database } from '../db/database.js';
import { listExcludedEntries } from '../ingestion/ingest-snapshot.js';
import { IMPACT_REASONING_INSTRUCTIONS_VERSION, assessImpact } from '../reasoning/impact-reasoning.js';
import { InvalidReasoningOutputError, type CandidateAssessment, type Finding, type ImpactClassification } from '../reasoning/impact-report.js';
import type { ReasoningProvider } from '../reasoning/provider.js';
import { constructEvidence, DEFAULT_EVIDENCE_LIMIT, type Evidence, type EvidenceBundle } from '../retrieval/evidence.js';
import { searchHybridDetailed, type HybridQuery } from '../retrieval/hybrid-search.js';
import type { FusedCandidate } from '../retrieval/rrf.js';
import type { EmbeddingProvider } from '../semantic/provider.js';
import { requireReadySnapshot } from '../snapshots/snapshots.js';
import { changedPathsOf, describeChangeOf, type CommitRange } from './change-set.js';

// The end-to-end investigation of one change in one ready snapshot: hybrid retrieval, evidence for
// the best candidates, and, only when a reasoning provider is supplied, the validated M8
// assessment. The report is useful without the assessment: every candidate carries its evidence,
// its retrieval signals, what that evidence cannot show, and the questions it leaves open. Nothing
// here turns a rank, a score or an import into a statement that the change affects a file.

export interface InvestigationOptions {
  /** How many candidates to describe after removing the changed files. Defaults to 20. */
  limit?: number;
  /** When given, the M8 impact assessment is attempted; a rejected or failed attempt is reported, never hidden. */
  reasoning?: ReasoningProvider;
  /**
   * The commits the change was derived from. The snapshot must be the base commit's, and the
   * changed paths must be exactly those derived from the range (`changedPathsOf`). It is recorded
   * in the report and labels each changed file with how it changed; it does not affect retrieval.
   */
  commitRange?: CommitRange;
}

/** Why a candidate was surfaced, as numbers: retrieval signals, not evidence of impact. */
export interface RetrievalSignals {
  fusedRank: number;
  rrfScore: number;
  /** Rank in the lexical and structural ranking, or null if absent from it. */
  deterministicRank: number | null;
  /** Rank in the semantic ranking, or null if absent from it. */
  semanticRank: number | null;
  deterministicCategory: string | null;
}

/** One evidence item in words, with the id that identifies it in this report. */
export interface EvidenceLine {
  id: string;
  type: Evidence['type'];
  text: string;
}

/** The M8 assessment of a candidate, present only when the production validator accepted the whole analysis. */
export interface CandidateAssessmentView {
  classification: ImpactClassification;
  /** What the classification does and does not mean. */
  meaning: string;
  findings: readonly Finding[];
}

export interface InvestigationCandidate {
  rank: number;
  artifactId: number;
  versionId: number;
  path: string;
  kind: string;
  signals: RetrievalSignals;
  /** The candidate's evidence exactly as `constructEvidence` built it, ids included. */
  evidence: readonly Evidence[];
  /** The same evidence in words, one line per item, in the same order. */
  summary: readonly EvidenceLine[];
  /** What this candidate's evidence cannot show. */
  limitations: readonly string[];
  /** Questions a reviewer has to answer that the evidence leaves open. */
  openQuestions: readonly string[];
  assessment: CandidateAssessmentView | null;
}

export interface ChangedFile {
  path: string;
  /** How the path changed between the base and head commits (for example "modified", "renamed to x"); null when the change was not given as a commit range. */
  change: string | null;
  /** False when the snapshot has no file at this path (a new file, a rename, or one the file policy excluded). */
  inSnapshot: boolean;
  artifactId: number | null;
  versionId: number | null;
  /** The file-policy exclusion recorded for this path, if any. */
  excludedBecause: string | null;
  /** The changed file's own position in the fused ranking, if it was ranked. */
  fusedRank: number | null;
}

export type ReasoningStatus =
  /** No reasoning provider was supplied. */
  | { status: 'not_requested' }
  /** The validator accepted the model's answer for every candidate. */
  | { status: 'accepted'; modelId: string; instructionsVersion: string }
  /** The model answered, but an answer failed validation; no assessment is shown. */
  | { status: 'rejected'; modelId: string; instructionsVersion: string; error: string }
  /** The request could not be completed (provider error, timeout, input too large); no assessment is shown. */
  | { status: 'failed'; modelId: string; instructionsVersion: string; error: string };

export interface InvestigationReport {
  snapshot: { id: number; repositoryId: number; commitSha: string; treeSha: string; committedAt: string };
  change: { description: string; changedPaths: readonly string[]; symbols: readonly string[] };
  /** The base and head commits and their file changes, when the change was given as a commit range; the snapshot is the base. */
  commitRange: CommitRange | null;
  changedFiles: readonly ChangedFile[];
  retrieval: {
    rrfK: number;
    embeddingModelId: string;
    /** Candidates in the fused ranking, the changed files included. */
    rankedCandidates: number;
    deterministicCandidates: number;
    semanticCandidates: number;
    evidenceLimit: number;
    /** Ranked candidates that are not changed files and are not described because of the limit. */
    notDescribed: number;
  };
  reasoning: ReasoningStatus;
  candidates: readonly InvestigationCandidate[];
  /** What the whole report cannot show. */
  limitations: readonly string[];
}

const SIGNALS_ARE_NOT_PROOF =
  'Ranks, scores, similarity, matched terms and imports explain why a file was surfaced. None of them shows that the change affects it.';

/**
 * Investigates `change` in a ready snapshot and returns a report. Requires the lexical, structural
 * and semantic indexes of the snapshot (for the embedder's model) and fails with the existing typed
 * errors when one is missing; evidence that cannot be verified against the snapshot fails the
 * investigation (InconsistentCandidateError) instead of being reported. A reasoning failure does not
 * fail the investigation: the report records it and shows no assessment.
 */
export async function investigateChange(
  db: Database,
  snapshotId: number,
  embedder: EmbeddingProvider,
  change: HybridQuery,
  options: InvestigationOptions = {},
): Promise<InvestigationReport> {
  if (typeof change.description !== 'string' || change.description.trim() === '') throw new RangeError('The change description must be a non-empty string');
  const snapshot = requireReadySnapshot(db, snapshotId);
  const range = options.commitRange ?? null;
  if (range) {
    if (snapshot.commitSha !== range.base) throw new RangeError(`Snapshot ${snapshot.id} is of commit ${snapshot.commitSha}, not of the base commit ${range.base}`);
    const derived = changedPathsOf(range);
    if (derived.length !== change.changedPaths.length || derived.some((path, i) => path !== change.changedPaths[i])) {
      throw new RangeError('The changed paths must be exactly the paths derived from the commit range');
    }
  }
  const run = await searchHybridDetailed(db, snapshot.id, embedder, change);
  const limit = options.limit ?? DEFAULT_EVIDENCE_LIMIT;
  const bundle = constructEvidence(db, snapshot.id, embedder, run, { limit });

  const reasoning = options.reasoning ? await runReasoning(db, snapshot.id, options.reasoning, change.description, bundle) : { status: { status: 'not_requested' } as ReasoningStatus, assessments: null };
  const fusedByVersion = new Map(run.fused.map((f) => [f.versionId, f]));
  const assessmentByVersion = new Map((reasoning.assessments ?? []).map((a) => [a.versionId, a]));

  const candidates = bundle.candidates.map((candidate): InvestigationCandidate => {
    const fused = fusedByVersion.get(candidate.versionId)!;
    const assessment = assessmentByVersion.get(candidate.versionId);
    return {
      rank: candidate.rank,
      artifactId: candidate.artifactId,
      versionId: candidate.versionId,
      path: candidate.path,
      kind: candidate.kind,
      signals: signalsOf(fused),
      evidence: candidate.evidence,
      summary: candidate.evidence.map(describeEvidence),
      limitations: candidateLimitations(candidate.evidence, fused),
      openQuestions: openQuestions(candidate.evidence),
      assessment: assessment ? { classification: assessment.classification, meaning: MEANING[assessment.classification], findings: assessment.findings } : null,
    };
  });

  const changedPaths = new Set(run.query.changedPaths);
  const excluded = new Map(listExcludedEntries(db, snapshot.id).map((e) => [e.path, e.reason]));
  const changedFiles = bundle.changed.map((facts): ChangedFile => ({
    path: facts.path,
    change: range ? describeChangeOf(range, facts.path) : null,
    inSnapshot: facts.versionId !== null,
    artifactId: facts.artifactId,
    versionId: facts.versionId,
    excludedBecause: excluded.get(facts.path) ?? null,
    fusedRank: run.fused.find((f) => f.path === facts.path)?.rank ?? null,
  }));
  const eligible = run.fused.filter((f) => !changedPaths.has(f.path)).length;

  const limitations = [SIGNALS_ARE_NOT_PROOF, 'Changed files are listed separately and never appear as candidates.'];
  if (range) {
    limitations.push(
      `The change is the difference between commits ${range.base} (base) and ${range.head} (head). Candidates come from the base snapshot, the state before the change; files the change adds exist only in the head.`,
    );
  }
  for (const file of changedFiles) {
    if (!file.inSnapshot) {
      const why = file.excludedBecause
        ? `excluded by the file policy: ${file.excludedBecause}`
        : file.change === 'added'
          ? 'added by the change, so it does not exist before it'
          : file.change?.startsWith('renamed from')
            ? `the new name of a file ${file.change}, so it does not exist before the change`
            : file.change
              ? file.change
              : 'a new or renamed file, or a path that does not exist';
      limitations.push(`The changed path ${file.path} is not in snapshot ${snapshot.id} (${why}), so no import relationship to it can be found.`);
    }
  }
  if (eligible > candidates.length) limitations.push(`${eligible - candidates.length} further ranked files are not described (limit ${limit}).`);
  if (candidates.length === 0) limitations.push('No file other than the changed files was retrieved.');
  limitations.push(reasoningLimitation(reasoning.status));

  return {
    snapshot: { id: snapshot.id, repositoryId: snapshot.repositoryId, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, committedAt: snapshot.committedAt },
    change: { description: change.description, changedPaths: [...change.changedPaths], symbols: [...(change.symbols ?? [])] },
    commitRange: range,
    changedFiles,
    retrieval: {
      rrfK: run.rrfK,
      embeddingModelId: run.modelId,
      rankedCandidates: run.fused.length,
      deterministicCandidates: run.deterministic.length,
      semanticCandidates: run.semantic.length,
      evidenceLimit: limit,
      notDescribed: Math.max(0, eligible - candidates.length),
    },
    reasoning: reasoning.status,
    candidates,
    limitations,
  };
}

async function runReasoning(
  db: Database,
  snapshotId: number,
  provider: ReasoningProvider,
  description: string,
  bundle: EvidenceBundle,
): Promise<{ status: ReasoningStatus; assessments: readonly CandidateAssessment[] | null }> {
  const base = { modelId: provider.modelId, instructionsVersion: IMPACT_REASONING_INSTRUCTIONS_VERSION };
  try {
    const report = await assessImpact(db, snapshotId, provider, { description, bundle });
    return { status: { status: 'accepted', ...base }, assessments: report.assessments };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const status = error instanceof InvalidReasoningOutputError ? 'rejected' : 'failed';
    return { status: { status, ...base, error: message }, assessments: null };
  }
}

function reasoningLimitation(status: ReasoningStatus): string {
  switch (status.status) {
    case 'not_requested':
      return 'No impact assessment was requested: candidates are described by their evidence only.';
    case 'accepted':
      return 'Impact assessments are a model\'s reading of the evidence. The validator checked their structure and citations and rejected a set of explicit mismatches; it did not check that the statements are true.';
    case 'rejected':
      return 'The impact assessment was rejected by the validator, so no classification is shown; the evidence below is unaffected.';
    case 'failed':
      return 'The impact assessment could not be completed, so no classification is shown; the evidence below is unaffected.';
  }
}

const MEANING: Record<ImpactClassification, string> = {
  likely_affected: 'The model judged that the cited evidence supports a specific relationship to the changed behavior. Validated for citations, not for truth.',
  potentially_affected: 'The model judged a relationship plausible but not established by the evidence.',
  insufficient_evidence: 'The model did not find the evidence sufficient to decide either way. This is not a finding that the file is unaffected.',
  no_impact_indicated: 'The model judged that the evidence shows the change does not affect the file.',
};

function signalsOf(fused: FusedCandidate): RetrievalSignals {
  return {
    fusedRank: fused.rank,
    rrfScore: fused.rrfScore,
    deterministicRank: fused.deterministicRank,
    semanticRank: fused.semanticRank,
    deterministicCategory: fused.deterministicCategory,
  };
}

/** One evidence item in words. It states what the item records and nothing more. */
export function describeEvidence(evidence: Evidence): EvidenceLine {
  const line = (text: string): EvidenceLine => ({ id: evidence.id, type: evidence.type, text });
  switch (evidence.type) {
    case 'structural': {
      const relation =
        evidence.signal === 'test-to-source'
          ? `is a test that imports the changed file ${evidence.changedPath}`
          : evidence.signal === 'incoming-import'
            ? `imports the changed file ${evidence.changedPath}`
            : `is imported by the changed file ${evidence.changedPath}`;
      const where =
        evidence.declarations === null
          ? 'the import declaration could not be located'
          : evidence.declarations.map((d) => `${evidence.source.path}:${d.startLine}${d.endLine !== d.startLine ? `-${d.endLine}` : ''} (${JSON.stringify(d.specifier)})`).join(', ');
      return line(`File-level import: this file ${relation}; ${where}.`);
    }
    case 'lexical':
      return line(
        `Matched ${evidence.matchedTerms.length} distinct query term${evidence.matchedTerms.length === 1 ? '' : 's'}: ${evidence.matchedTerms.join(', ')} (${evidence.contentMatchCount} found in the content, ${evidence.pathMatchCount} in the path; a term can be in both).`,
      );
    case 'semantic':
      return line(
        `Similarity ${evidence.similarityScore.toFixed(3)} between the change and chunk ${evidence.bestChunkIndex + 1} of ${evidence.chunkCount}${evidence.chunk === null ? ' (excerpt unavailable)' : evidence.chunk.truncated ? ` (excerpt of ${evidence.chunk.text.length} of ${evidence.chunk.totalChars} characters)` : ''}.`,
      );
    case 'fusion':
      return line(
        `Fused rank ${evidence.fusedRank} (RRF score ${evidence.rrfScore.toFixed(4)}, K = ${evidence.k}; lexical/structural rank ${evidence.deterministic?.rank ?? 'none'}, semantic rank ${evidence.semantic?.rank ?? 'none'}).`,
      );
  }
}

function candidateLimitations(evidence: readonly Evidence[], fused: FusedCandidate): string[] {
  const out: string[] = [];
  const structural = evidence.filter((e) => e.type === 'structural');
  if (structural.length === 0) {
    out.push('No import relationship with a changed file: surfaced by matched terms and similarity only.');
  } else {
    if (structural.every((e) => e.candidateIs === 'target')) {
      out.push('Only the changed file imports this file: it is a dependency of the changed code, not a dependent of it.');
    }
    if (structural.some((e) => e.declarations === null)) out.push('An import declaration could not be located in the source.');
    out.push('An import is a file-level relationship: it does not show which symbols are used or whether the changed behavior is reached.');
  }
  for (const e of evidence) {
    if (e.type === 'lexical' && e.contentMatchCount === 0) out.push('The matched terms occur only in the path, not in the content.');
    if (e.type === 'semantic' && e.chunk === null) out.push('The best-matching excerpt could not be reconstructed.');
    if (e.type === 'semantic' && e.chunk?.truncated) out.push('The best-matching excerpt in the evidence is truncated, so it may not include the part of the chunk that matched.');
  }
  if (fused.deterministicRank === null) out.push('Not found by the lexical and structural ranking; surfaced by similarity alone.');
  if (fused.semanticRank === null) out.push('Not found by the semantic ranking.');
  return out;
}

function openQuestions(evidence: readonly Evidence[]): string[] {
  const structural = evidence.filter((e) => e.type === 'structural');
  if (structural.some((e) => e.candidateIs === 'source')) {
    return ['Does this file use the behavior the change modifies, or only other parts of the changed file?'];
  }
  if (structural.length > 0) {
    return ['Does the change alter how the changed file calls this file, in a way this file must accommodate?'];
  }
  return ['Is there a runtime, contract or documentation relationship to the change beyond shared vocabulary?'];
}
