import { locateImportDeclarations, parseDialectFor } from '../analysis/import-extraction.js';
import { resolveRelativeImport } from '../analysis/module-resolution.js';
import { findIncomingRelationships, findOutgoingRelationships, type RelationshipKind } from '../analysis/relationships.js';
import { isSnapshotStructurallyIndexed, StructuralIndexNotBuiltError } from '../analysis/structural-index.js';
import {
  findArtifactAtSnapshot,
  listSnapshotArtifacts,
  readContent,
  type ArtifactKind,
  type SnapshotArtifact,
} from '../artifacts/artifacts.js';
import type { Database } from '../db/database.js';
import { chunkArtifact, embeddingInputHash, sourceTextOfInput } from '../semantic/chunking.js';
import type { EmbeddingProvider } from '../semantic/provider.js';
import { isSnapshotSemanticallyIndexed, SemanticIndexNotBuiltError } from '../semantic/semantic-index.js';
import type { SemanticCandidate } from '../semantic/semantic-search.js';
import { requireReadySnapshot } from '../snapshots/snapshots.js';
import type { DeterministicCandidate, StructuralSignal } from './deterministic-retrieval.js';
import type { StructuralSignalKind } from './deterministic-ranking.js';
import type { HybridSearchResult } from './hybrid-search.js';
import { isSnapshotLexicallyIndexed, LexicalIndexNotBuiltError } from './lexical-index.js';
import type { LexicalCategory } from './lexical-ranking.js';
import { InconsistentCandidateError, type FusedCandidate } from './rrf.js';

// Request-scoped evidence for hybrid candidates: the facts that explain why each candidate was
// retrieved, taken from the retrieval run that produced the ranking and checked against the
// snapshot. It never says a candidate is impacted: a ranking, a score or an import is a reason to
// look at a file, not proof that the change affects it. Nothing here is stored.

export const DEFAULT_EVIDENCE_LIMIT = 20;
const MAX_IMPORT_EXCERPT_CHARS = 500;
const MAX_CHUNK_EXCERPT_CHARS = 1000;
const SCORE_TOLERANCE = 1e-12;

/** Source text shown for a fact, cut to a bound when it is longer; `truncated` says so. */
export interface SourceExcerpt {
  text: string;
  truncated: boolean;
  /** Length of the complete source text, in characters. */
  totalChars: number;
}

/** An artifact version of the snapshot. */
export interface EvidenceArtifact {
  artifactId: number;
  versionId: number;
  path: string;
}

/** An import declaration found in the importing file's content. Lines are 1-based and inclusive and refer to the normalized content. */
export interface ImportDeclarationSource {
  specifier: string;
  startLine: number;
  endLine: number;
  excerpt: SourceExcerpt;
}

/**
 * A verified file-level relationship between the candidate and a changed file: `source` imports
 * `target`. The index records imports between files, not which symbols are used.
 */
export interface StructuralEvidence {
  type: 'structural';
  id: string;
  snapshotId: number;
  /** How the candidate relates to the changed file. */
  signal: StructuralSignalKind;
  /** The relationship row that was verified in the snapshot: `test-to-source` for a test, `imports` otherwise. */
  relationship: RelationshipKind;
  source: EvidenceArtifact;
  target: EvidenceArtifact;
  candidateIs: 'source' | 'target';
  changedPath: string;
  /**
   * The matching import declarations in the source file, or null when they could not be located
   * (the file does not parse or no declaration resolves to the target).
   */
  declarations: readonly ImportDeclarationSource[] | null;
}

/** The distinct query terms the lexical index found, as `searchLexical` reports them. */
export interface LexicalEvidence {
  type: 'lexical';
  id: string;
  matchedTerms: readonly string[];
  lexicalCategory: LexicalCategory;
  /** Number of distinct query terms found in the content (not occurrences). */
  contentMatchCount: number;
  /** Number of distinct query terms found in the path (not occurrences). */
  pathMatchCount: number;
}

export interface SemanticEvidence {
  type: 'semantic';
  id: string;
  modelId: string;
  /** Cosine similarity between the query and the best chunk: a retrieval signal. */
  similarityScore: number;
  bestChunkIndex: number;
  chunkCount: number;
  /** SHA-256 of the exact text that was embedded for the best chunk. */
  embeddingInputHash: string;
  /** The best chunk's source text without the embedding framing, or null when it cannot be reconstructed. */
  chunk: SourceExcerpt | null;
}

export interface FusionContribution {
  rank: number;
  contribution: number;
}

export interface FusionEvidence {
  type: 'fusion';
  id: string;
  fusedRank: number;
  rrfScore: number;
  k: number;
  deterministic: FusionContribution | null;
  semantic: FusionContribution | null;
}

export type Evidence = StructuralEvidence | LexicalEvidence | SemanticEvidence | FusionEvidence;

export interface EvidenceCandidate {
  /** The candidate's rank in the fused ranking, unchanged. */
  rank: number;
  artifactId: number;
  versionId: number;
  path: string;
  kind: ArtifactKind;
  /** Structural, lexical, semantic, then fusion; the same kind ordered by its stable fields. */
  evidence: readonly Evidence[];
}

/** A changed path and, when the snapshot contains it, its artifact version. */
export interface ChangedPathFacts {
  path: string;
  artifactId: number | null;
  versionId: number | null;
}

export interface EvidenceBundle {
  snapshotId: number;
  modelId: string;
  rrfK: number;
  limit: number;
  changed: readonly ChangedPathFacts[];
  candidates: readonly EvidenceCandidate[];
}

export interface EvidenceOptions {
  /** How many candidates to describe, after removing the changed files. Defaults to 20. */
  limit?: number;
}

const SIGNAL_ORDER: readonly StructuralSignalKind[] = ['test-to-source', 'incoming-import', 'outgoing-import'];

/**
 * Evidence for the best candidates of one hybrid run, in fused-rank order. The candidates whose
 * paths equal a changed path are left out before the limit is applied, and the rest keep their
 * fused ranks. Uses only the run's own rankings and the snapshot: it neither searches nor embeds.
 *
 * Throws NotFoundError, SnapshotNotReadyError, LexicalIndexNotBuiltError,
 * StructuralIndexNotBuiltError or SemanticIndexNotBuiltError for a snapshot that is unknown, not
 * ready or not fully indexed for the provider's model, RangeError for an invalid limit, and
 * InconsistentCandidateError when the run does not belong to the snapshot or a candidate or fact
 * cannot be verified against it. Nothing is dropped or invented.
 */
export function constructEvidence(
  db: Database,
  snapshotId: number,
  provider: EmbeddingProvider,
  result: HybridSearchResult,
  options: EvidenceOptions = {},
): EvidenceBundle {
  const limit = options.limit ?? DEFAULT_EVIDENCE_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw new RangeError(`Evidence limit must be a positive integer, received ${limit}`);

  const snapshot = requireReadySnapshot(db, snapshotId);
  if (!isSnapshotLexicallyIndexed(db, snapshot.id)) throw new LexicalIndexNotBuiltError(snapshot.id);
  if (!isSnapshotStructurallyIndexed(db, snapshot.id)) throw new StructuralIndexNotBuiltError(snapshot.id);
  if (!isSnapshotSemanticallyIndexed(db, snapshot.id, provider)) throw new SemanticIndexNotBuiltError(snapshot.id, provider.modelId);
  if (result.snapshotId !== snapshot.id) {
    throw new InconsistentCandidateError(`The hybrid result is for snapshot ${result.snapshotId}, not snapshot ${snapshot.id}`);
  }
  if (result.modelId !== provider.modelId) {
    throw new InconsistentCandidateError(`The hybrid result used ${result.modelId}, not ${provider.modelId}`);
  }

  const context = new SnapshotFacts(db, snapshot.id);
  const changedPaths = [...new Set(result.query.changedPaths)];
  const changed = changedPaths.map((path) => context.changedFacts(path));
  const changedSet = new Set(changedPaths);

  const deterministic = indexByVersion(result.deterministic, 'deterministic');
  const semantic = indexByVersion(result.semantic, 'semantic');

  const selected = result.fused.filter((candidate) => !changedSet.has(candidate.path)).slice(0, limit);
  const candidates = selected.map((fused) => {
    context.verifyCandidate(fused);
    const det = deterministic.get(fused.versionId);
    const sem = semantic.get(fused.versionId);
    verifyAgainstRankings(fused, det, sem);

    const evidence: Evidence[] = [
      ...structuralEvidence(context, fused, det),
      ...(det && det.lexicalCategory !== null ? [lexicalEvidence(fused, det, det.lexicalCategory)] : []),
      ...(sem ? [semanticEvidence(context, provider, fused, sem)] : []),
      fusionEvidence(fused, result.rrfK),
    ];
    return {
      rank: fused.rank,
      artifactId: fused.artifactId,
      versionId: fused.versionId,
      path: fused.path,
      kind: fused.kind,
      evidence,
    };
  });

  return deepFreeze({ snapshotId: snapshot.id, modelId: result.modelId, rrfK: result.rrfK, limit, changed, candidates });
}

/** What the snapshot says about versions, changed files, relationships and content, read once each. */
class SnapshotFacts {
  readonly snapshotId: number;
  readonly paths: ReadonlySet<string>;
  private readonly db: Database;
  private readonly artifacts: Map<string, SnapshotArtifact>;
  private readonly relationships = new Map<string, ReturnType<typeof findIncomingRelationships>>();

  constructor(db: Database, snapshotId: number) {
    this.db = db;
    this.snapshotId = snapshotId;
    this.artifacts = new Map(listSnapshotArtifacts(db, snapshotId).map((artifact) => [artifact.path, artifact]));
    this.paths = new Set(this.artifacts.keys());
  }

  changedFacts(path: string): ChangedPathFacts {
    const artifact = findArtifactAtSnapshot(this.db, this.snapshotId, path);
    return { path, artifactId: artifact?.artifactId ?? null, versionId: artifact?.versionId ?? null };
  }

  /** The candidate must be exactly this version of this artifact, path and kind in the snapshot. */
  verifyCandidate(fused: FusedCandidate): void {
    const stored = this.artifacts.get(fused.path);
    if (!stored || stored.versionId !== fused.versionId || stored.artifactId !== fused.artifactId || stored.kind !== fused.kind) {
      throw new InconsistentCandidateError(
        `Candidate ${JSON.stringify(fused.path)} (artifact ${fused.artifactId}, version ${fused.versionId}) is not that version of that artifact in snapshot ${this.snapshotId}`,
      );
    }
  }

  contentOf(path: string): { text: string; sha256: string } | undefined {
    const artifact = this.artifacts.get(path);
    const text = artifact ? readContent(this.db, artifact.contentSha256) : undefined;
    return artifact && text !== undefined ? { text, sha256: artifact.contentSha256 } : undefined;
  }

  /** Relationships touching a changed artifact, in the direction a signal is about. */
  relationshipsOf(direction: 'incoming' | 'outgoing', artifactId: number) {
    const key = `${direction}:${artifactId}`;
    let found = this.relationships.get(key);
    if (!found) {
      found = (direction === 'incoming' ? findIncomingRelationships : findOutgoingRelationships)(this.db, this.snapshotId, [artifactId]);
      this.relationships.set(key, found);
    }
    return found;
  }

  chunkRows(modelId: string, artifactId: number): { chunk_index: number; input_hash: string }[] {
    return this.db
      .prepare(
        `SELECT chunk_index, input_hash FROM semantic_chunk
         WHERE model_id = ? AND snapshot_id = ? AND artifact_id = ? ORDER BY chunk_index`,
      )
      .all(modelId, this.snapshotId, artifactId) as unknown as { chunk_index: number; input_hash: string }[];
  }
}

function indexByVersion<T extends { versionId: number }>(list: readonly T[], name: string): Map<number, T> {
  const byVersion = new Map<number, T>();
  for (const candidate of list) {
    if (byVersion.has(candidate.versionId)) {
      throw new InconsistentCandidateError(`The ${name} ranking lists version ${candidate.versionId} more than once`);
    }
    byVersion.set(candidate.versionId, candidate);
  }
  return byVersion;
}

/** The fused candidate must report exactly what the two rankings of this run say about it. */
function verifyAgainstRankings(
  fused: FusedCandidate,
  det: DeterministicCandidate | undefined,
  sem: SemanticCandidate | undefined,
): void {
  const describe = `Candidate ${JSON.stringify(fused.path)}`;
  if ((fused.deterministicRank === null) !== (det === undefined) || (det && (det.rank !== fused.deterministicRank || det.category !== fused.deterministicCategory))) {
    throw new InconsistentCandidateError(`${describe} disagrees with the deterministic ranking of the run`);
  }
  if ((fused.semanticRank === null) !== (sem === undefined) || (sem && sem.rank !== fused.semanticRank)) {
    throw new InconsistentCandidateError(`${describe} disagrees with the semantic ranking of the run`);
  }
  for (const source of [det, sem]) {
    if (source && (source.artifactId !== fused.artifactId || source.path !== fused.path || source.kind !== fused.kind)) {
      throw new InconsistentCandidateError(`${describe} has a different identity in the rankings of the run`);
    }
  }
}

function structuralEvidence(context: SnapshotFacts, fused: FusedCandidate, det: DeterministicCandidate | undefined): StructuralEvidence[] {
  if (!det) return [];
  const signals = [...det.structuralSignals].sort(
    (a, b) => SIGNAL_ORDER.indexOf(a.kind) - SIGNAL_ORDER.indexOf(b.kind) || (a.changedPath < b.changedPath ? -1 : a.changedPath > b.changedPath ? 1 : 0),
  );
  const byId = new Map<string, StructuralEvidence>();
  for (const signal of signals) {
    const evidence = oneStructuralEvidence(context, fused, signal);
    byId.set(evidence.id, evidence); // an identical signal listed twice is one fact
  }
  return [...byId.values()];
}

function oneStructuralEvidence(context: SnapshotFacts, fused: FusedCandidate, signal: StructuralSignal): StructuralEvidence {
  const changed = context.changedFacts(signal.changedPath);
  if (changed.artifactId === null || changed.versionId === null) {
    throw new InconsistentCandidateError(
      `Candidate ${JSON.stringify(fused.path)} has a ${signal.kind} signal for ${JSON.stringify(signal.changedPath)}, which is not in snapshot ${context.snapshotId}`,
    );
  }
  const candidate: EvidenceArtifact = { artifactId: fused.artifactId, versionId: fused.versionId, path: fused.path };
  const changedArtifact: EvidenceArtifact = { artifactId: changed.artifactId, versionId: changed.versionId, path: changed.path };
  const candidateIsSource = signal.kind !== 'outgoing-import';
  const [source, target] = candidateIsSource ? [candidate, changedArtifact] : [changedArtifact, candidate];
  const relationship: RelationshipKind = signal.kind === 'test-to-source' ? 'test-to-source' : 'imports';

  const verified = context
    .relationshipsOf(candidateIsSource ? 'incoming' : 'outgoing', changed.artifactId)
    .some(
      (row) =>
        row.kind === relationship &&
        row.source.artifactId === source.artifactId &&
        row.source.versionId === source.versionId &&
        row.target.artifactId === target.artifactId &&
        row.target.versionId === target.versionId,
    );
  if (!verified) {
    throw new InconsistentCandidateError(
      `No ${relationship} relationship from ${JSON.stringify(source.path)} to ${JSON.stringify(target.path)} exists in snapshot ${context.snapshotId}`,
    );
  }

  return {
    type: 'structural',
    id: `structural:${signal.kind}:${source.versionId}>${target.versionId}`,
    snapshotId: context.snapshotId,
    signal: signal.kind,
    relationship,
    source,
    target,
    candidateIs: candidateIsSource ? 'source' : 'target',
    changedPath: signal.changedPath,
    declarations: locateDeclarations(context, source.path, target.path),
  };
}

/** The import declarations in `sourcePath` that resolve to `targetPath`, or null if they cannot be found. */
function locateDeclarations(context: SnapshotFacts, sourcePath: string, targetPath: string): ImportDeclarationSource[] | null {
  const dialect = parseDialectFor(sourcePath);
  const content = context.contentOf(sourcePath);
  if (!dialect || !content) return null;
  const located = locateImportDeclarations(content.text, dialect);
  if (!located.ok) return null;

  const paths = context.paths;
  const matching = located.declarations.filter((declaration) => resolveRelativeImport(sourcePath, declaration.specifier, paths) === targetPath);
  if (matching.length === 0) return null;
  return matching.map((declaration) => ({
    specifier: declaration.specifier,
    startLine: declaration.startLine,
    endLine: declaration.endLine,
    excerpt: excerptOf(content.text.slice(declaration.start, declaration.end), MAX_IMPORT_EXCERPT_CHARS),
  }));
}

function lexicalEvidence(fused: FusedCandidate, det: DeterministicCandidate, lexicalCategory: LexicalCategory): LexicalEvidence {
  return {
    type: 'lexical',
    id: `lexical:${fused.versionId}`,
    matchedTerms: [...det.matchedTerms],
    lexicalCategory,
    contentMatchCount: det.contentMatchCount,
    pathMatchCount: det.pathMatchCount,
  };
}

function semanticEvidence(context: SnapshotFacts, provider: EmbeddingProvider, fused: FusedCandidate, sem: SemanticCandidate): SemanticEvidence {
  const chunks = context.chunkRows(provider.modelId, fused.artifactId);
  const best = chunks.find((chunk) => chunk.chunk_index === sem.bestChunkIndex);
  if (!best) {
    throw new InconsistentCandidateError(
      `Candidate ${JSON.stringify(fused.path)} has no chunk ${sem.bestChunkIndex} for ${provider.modelId} in snapshot ${context.snapshotId}`,
    );
  }
  const content = context.contentOf(fused.path);
  return {
    type: 'semantic',
    id: `semantic:${fused.versionId}:${provider.modelId}:${sem.bestChunkIndex}`,
    modelId: provider.modelId,
    similarityScore: sem.similarityScore,
    bestChunkIndex: sem.bestChunkIndex,
    chunkCount: chunks.length,
    embeddingInputHash: best.input_hash,
    chunk: content ? reconstructChunk(fused.path, content.text, provider.maxInputChars, sem.bestChunkIndex, best.input_hash) : null,
  };
}

/**
 * The source text of one stored chunk. The chunking is deterministic, so chunking the original
 * content again reproduces the embedded inputs; a chunk counts as reconstructed only if its input
 * hashes to the stored hash. An artifact that was chunked again at a smaller limit during indexing
 * is found by halving the limit as indexing did. Returns null when nothing matches.
 */
function reconstructChunk(path: string, text: string, maxInputChars: number, chunkIndex: number, inputHash: string): SourceExcerpt | null {
  for (let limit = maxInputChars; limit >= 100; limit = Math.floor(limit / 2)) {
    let inputs;
    try {
      inputs = chunkArtifact(path, text, limit);
    } catch {
      return null; // the limit left no room for content
    }
    const input = inputs.find((candidate) => candidate.chunkIndex === chunkIndex && embeddingInputHash(candidate.text) === inputHash);
    if (!input) continue;
    const source = sourceTextOfInput(path, input, true) ?? sourceTextOfInput(path, input, false);
    return source === undefined ? null : excerptOf(source, MAX_CHUNK_EXCERPT_CHARS);
  }
  return null;
}

function fusionEvidence(fused: FusedCandidate, k: number): FusionEvidence {
  const contribution = (rank: number | null): FusionContribution | null => (rank === null ? null : { rank, contribution: 1 / (k + rank) });
  const deterministic = contribution(fused.deterministicRank);
  const semantic = contribution(fused.semanticRank);
  const sum = (deterministic?.contribution ?? 0) + (semantic?.contribution ?? 0);
  if (!Number.isFinite(fused.rrfScore) || Math.abs(sum - fused.rrfScore) > SCORE_TOLERANCE) {
    throw new InconsistentCandidateError(
      `Candidate ${JSON.stringify(fused.path)} has RRF score ${fused.rrfScore}, but its ranks give ${sum} at K = ${k}`,
    );
  }
  return {
    type: 'fusion',
    id: `fusion:${fused.versionId}:k${k}`,
    fusedRank: fused.rank,
    rrfScore: fused.rrfScore,
    k,
    deterministic,
    semantic,
  };
}

/** The first `maxChars` characters of `text`, never ending inside a surrogate pair. */
function excerptOf(text: string, maxChars: number): SourceExcerpt {
  if (text.length <= maxChars) return { text, truncated: false, totalChars: text.length };
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true, totalChars: text.length };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
