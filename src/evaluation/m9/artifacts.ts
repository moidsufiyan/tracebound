import { posix } from 'node:path';
import { findArtifactAtSnapshot, readContent } from '../../artifacts/artifacts.js';
import type { Database } from '../../db/database.js';
import type { EvidenceBundle } from '../../retrieval/evidence.js';
import type { HybridSearchResult } from '../../retrieval/hybrid-search.js';
import { formatSemanticQuery } from '../../semantic/chunking.js';
import { requireReadySnapshot } from '../../snapshots/snapshots.js';
import {
  ANNOTATION_PHASE,
  ANNOTATION_SCHEMA_VERSION,
  ANNOTATOR_IDS,
  buildAnnotationTemplate,
  CLASSIFICATIONS,
  EVIDENCE_SUFFICIENCY,
} from './annotation.js';
import { assertPortablePath, normalizeTimestamp, sha256Hex } from './canonical.js';

// The M9 evaluation artifacts: plain JSON values built from one production retrieval run and the
// evidence constructed from it. Nothing here retrieves, embeds or reasons; it records and checks.
//
// Identity is database-scoped: artifact ids, version ids and the evidence ids that embed them are
// SQLite row ids of the frozen database the run used. They mean nothing in a differently populated
// database, so every artifact says which database it belongs to and the verifier reads that one.

export const IDENTITY_SCOPE = 'database-scoped';
export const SCHEMA_VERSION = '1.0.0';
export const SCHEMAS = {
  evidencePackage: 'tracebound.m9.evidence-package',
  productionRanking: 'tracebound.m9.production-ranking',
  candidateManifest: 'tracebound.m9.candidate-manifest',
  reviewPacket: 'tracebound.m9.review-packet',
  releaseManifest: 'tracebound.m9.release-manifest',
} as const;

export { CLASSIFICATIONS } from './annotation.js';
export type JsonObject = { [key: string]: unknown };

/** The change under evaluation, as the case file states it. */
export interface CaseSpec {
  caseId: string;
  repositoryName: string;
  description: string;
  /** In the case file's order, which is the order the query is built in. */
  changedPaths: string[];
  symbols: string[];
  /** The evaluation cutoff as a UTC instant. */
  evaluationCutoff: string;
}

interface ParsedCase {
  case_id: string;
  repository: { name: string };
  source_change: { description: string; evaluation_cutoff: string };
  changed_artifacts?: { path: string; symbols?: { name: string }[] }[];
}

/** The case's query inputs, taken exactly as the benchmark and the M6 verification took them. */
export function caseSpecFromParsed(parsed: unknown): CaseSpec {
  const file = parsed as ParsedCase;
  const artifacts = file.changed_artifacts ?? [];
  return {
    caseId: file.case_id,
    repositoryName: file.repository.name,
    description: file.source_change.description,
    changedPaths: artifacts.map((artifact) => assertPortablePath(artifact.path)),
    symbols: artifacts.flatMap((artifact) => (artifact.symbols ?? []).map((symbol) => symbol.name)),
    evaluationCutoff: normalizeTimestamp(file.source_change.evaluation_cutoff),
  };
}

export interface EmbeddingIdentity {
  modelId: string;
  /** The full SHA-256 digest of the model weights the server reported. */
  weightsDigest: string;
  dimensions: number;
  maxInputChars: number;
}

export interface EvidenceRunProvenance {
  runId: string;
  generatedAt: string;
  /** What this run is: always a new evidence-generation run, never a relabelled earlier one. */
  runKind: 'new-evidence-generation-run';
  traceboundCommit: string;
  /** True when the M1–M8 sources match the commit, so the run used the committed retrieval code. */
  retrievalSourcesMatchCommit: boolean;
  exporterVersion: string;
  database: { sha256: string; bytes: number; userVersion: number };
}

export interface RunContext {
  db: Database;
  spec: CaseSpec;
  snapshotId: number;
  run: HybridSearchResult;
  bundle: EvidenceBundle;
  embedding: EmbeddingIdentity;
  provenance: EvidenceRunProvenance;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function snapshotRecord(db: Database, snapshotId: number): JsonObject {
  const snapshot = requireReadySnapshot(db, snapshotId);
  return {
    id: snapshot.id,
    baseCommitSha: snapshot.commitSha,
    treeSha: snapshot.treeSha,
    committedAt: normalizeTimestamp(snapshot.committedAt),
    recordedAt: normalizeTimestamp(snapshot.recordedAt),
    status: snapshot.status,
  };
}

function queryRecord(spec: CaseSpec): JsonObject {
  return {
    description: spec.description,
    changedPaths: [...spec.changedPaths],
    symbols: [...spec.symbols],
    lexicalText: [spec.description, ...spec.changedPaths.map((path) => posix.basename(path))].join(' '),
    semanticText: formatSemanticQuery(spec.description, spec.changedPaths),
  };
}

/** One ranked candidate with its eligible rank (its position once the exact changed paths are removed). */
export interface RankingEntry {
  rank: number;
  eligibleRank: number | null;
  artifactId: number;
  versionId: number;
  path: string;
  kind: string;
  rrfScore: number;
  deterministicRank: number | null;
  semanticRank: number | null;
  deterministicCategory: string | null;
}

export function rankingEntries(run: HybridSearchResult): RankingEntry[] {
  const changed = new Set(run.query.changedPaths);
  let eligible = 0;
  return run.fused.map((candidate) => {
    const isChanged = changed.has(candidate.path);
    if (!isChanged) eligible += 1;
    return {
      rank: candidate.rank,
      eligibleRank: isChanged ? null : eligible,
      artifactId: candidate.artifactId,
      versionId: candidate.versionId,
      path: assertPortablePath(candidate.path),
      kind: candidate.kind,
      rrfScore: candidate.rrfScore,
      deterministicRank: candidate.deterministicRank,
      semanticRank: candidate.semanticRank,
      deterministicCategory: candidate.deterministicCategory,
    };
  });
}

/** The complete production M6 fused ranking of one run, with the changed-path exclusion made explicit. */
export function buildProductionRanking(context: RunContext): JsonObject {
  const { run, spec } = context;
  const entries = rankingEntries(run);
  return {
    schema: SCHEMAS.productionRanking,
    schemaVersion: SCHEMA_VERSION,
    identityScope: IDENTITY_SCOPE,
    caseId: spec.caseId,
    snapshot: snapshotRecord(context.db, context.snapshotId),
    source: 'production-m6-searchHybridDetailed',
    rrfK: run.rrfK,
    exclusionPolicy: 'candidates whose path equals a changed path exactly are marked ineligible; eligible ranks count the rest in fused order',
    changedPaths: [...spec.changedPaths],
    embedding: { ...context.embedding },
    provenance: { ...context.provenance },
    rankedCandidateCount: entries.length,
    deterministicCandidateCount: run.deterministic.length,
    semanticCandidateCount: run.semantic.length,
    ranking: entries.map((entry) => ({ ...entry })),
  };
}

/** The complete archival M7 evidence package of one run: the evidence exactly as `constructEvidence` returned it. */
export function buildEvidencePackage(context: RunContext): JsonObject {
  const { bundle, spec, db, snapshotId, run } = context;
  const candidates = bundle.candidates.map((candidate) => {
    const artifact = findArtifactAtSnapshot(db, snapshotId, candidate.path);
    if (!artifact || artifact.versionId !== candidate.versionId || artifact.artifactId !== candidate.artifactId) {
      throw new Error(`Candidate ${candidate.path} does not match the snapshot's artifact version`);
    }
    return {
      rank: candidate.rank,
      artifactId: candidate.artifactId,
      versionId: candidate.versionId,
      path: assertPortablePath(candidate.path),
      kind: candidate.kind,
      contentSha256: artifact.contentSha256,
      gitBlobSha: artifact.gitBlobSha,
      evidence: plain(candidate.evidence),
    };
  });
  return {
    schema: SCHEMAS.evidencePackage,
    schemaVersion: SCHEMA_VERSION,
    identityScope: IDENTITY_SCOPE,
    case: {
      id: spec.caseId,
      repository: spec.repositoryName,
      description: spec.description,
      changedPaths: [...spec.changedPaths],
      symbols: [...spec.symbols],
      evaluationCutoff: spec.evaluationCutoff,
    },
    snapshot: snapshotRecord(db, snapshotId),
    query: queryRecord(spec),
    retrieval: {
      source: 'production-m6-searchHybridDetailed',
      rrfK: run.rrfK,
      evidenceLimit: bundle.limit,
      rankedCandidateCount: run.fused.length,
      embedding: { ...context.embedding },
    },
    provenance: { ...context.provenance },
    changed: plain(bundle.changed),
    candidates,
  };
}

/** What the evaluation owner froze for one selected candidate. */
export interface FrozenCandidate {
  position: number;
  artifactId: number;
  versionId: number;
  path: string;
  kind: string;
  contentSha256: string;
  gitBlobSha: string;
  fusedRank: number;
  eligibleRank: number;
}

export interface FrozenCase {
  caseId: string;
  snapshotId: number;
  baseCommitSha: string;
  candidates: FrozenCandidate[];
}

export interface PacketContext {
  db: Database;
  evidencePackage: JsonObject;
  evidencePackageDigest: string;
  candidateManifestDigest: string;
  frozen: FrozenCase;
}

/**
 * The blinded packet a reviewer annotates: the change, the three frozen candidates with their
 * source text (checked against the recorded hash) and exactly the M7 evidence of those candidates,
 * and an empty annotation form. It carries no reasoning output, no label and no other candidate.
 */
export function buildReviewPacket(context: PacketContext): JsonObject {
  const pkg = context.evidencePackage as { case: JsonObject; snapshot: JsonObject; candidates: { path: string; evidence: unknown[] }[] };
  const { frozen } = context;
  const candidates = frozen.candidates.map((selected) => {
    const packaged = pkg.candidates.find((candidate) => candidate.path === selected.path);
    if (!packaged) throw new Error(`${selected.path} is not in the evidence package`);
    const text = readContent(context.db, selected.contentSha256);
    if (text === undefined) throw new Error(`No stored content for ${selected.path}`);
    const actual = sha256Hex(text);
    if (actual !== selected.contentSha256) throw new Error(`Content of ${selected.path} hashes to ${actual}, not ${selected.contentSha256}`);
    return {
      candidateKey: `${frozen.caseId}-C${selected.position}`,
      artifactId: selected.artifactId,
      versionId: selected.versionId,
      path: selected.path,
      kind: selected.kind,
      contentSha256: selected.contentSha256,
      gitBlobSha: selected.gitBlobSha,
      source: { text, normalizedUtf8Bytes: Buffer.byteLength(text, 'utf8') },
      evidence: plain(packaged.evidence),
    };
  });
  return {
    schema: SCHEMAS.reviewPacket,
    schemaVersion: SCHEMA_VERSION,
    identityScope: IDENTITY_SCOPE,
    derivedFrom: { evidencePackageDigest: context.evidencePackageDigest, candidateManifestDigest: context.candidateManifestDigest },
    case: {
      id: frozen.caseId,
      description: pkg.case.description,
      changedPaths: pkg.case.changedPaths,
      evaluationCutoff: pkg.case.evaluationCutoff,
    },
    baseCommitSha: frozen.baseCommitSha,
    instructions:
      'Judge each candidate from the change description, its source text and its own evidence below only. Cite evidence ids of that candidate in cited_evidence_ids. ' +
      'Retrieval rank, a similarity score and an import are reasons the candidate was retrieved, not proof of impact.',
    candidates,
    ...annotationSection(frozen),
  };
}

/**
 * The annotation contract and one blank record per frozen candidate (schema `1.1.0`), derived only
 * from the frozen identities, so the verifier can rebuild it and compare.
 */
export function annotationSection(frozen: FrozenCase): JsonObject {
  return {
    annotationContract: {
      schema_version: ANNOTATION_SCHEMA_VERSION,
      annotation_phase: ANNOTATION_PHASE,
      annotator_ids: [...ANNOTATOR_IDS],
      classifications: [...CLASSIFICATIONS],
      evidence_sufficiency_values: [...EVIDENCE_SUFFICIENCY],
      recordPerCandidate: 'Each annotator completes a separate copy of the template of every candidate, setting annotator_id and annotated_at.',
      blindingRule:
        'A true value in blinding_verification means the record is not an independent blinded judgment and is excluded; leave all three false only if no diff or hindsight material, no other annotator ' +
        'judgment and no model output was seen.',
    },
    reviewWorkflow: [
      'Two annotators (REV-01, REV-02) judge independently from their own copy of this packet.',
      "Neither sees the other annotator's record, any earlier annotation, or any M8 or other model output before their initial assessment is sealed.",
      'Only the evidence in this packet, the source text shown and the change description are used; diffs and anything after the evaluation cutoff are not.',
    ],
    annotationTemplates: frozen.candidates.map((candidate) =>
      plain(buildAnnotationTemplate({ caseId: frozen.caseId, path: candidate.path, artifactId: candidate.artifactId, versionId: candidate.versionId, contentSha256: candidate.contentSha256 })),
    ),
  };
}
