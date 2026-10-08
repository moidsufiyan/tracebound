import { findIncomingRelationships, findOutgoingRelationships, type RelationshipEnd } from '../analysis/relationships.js';
import { isSnapshotStructurallyIndexed, StructuralIndexNotBuiltError } from '../analysis/structural-index.js';
import { findArtifactAtSnapshot, type ArtifactKind } from '../artifacts/artifacts.js';
import type { Database } from '../db/database.js';
import { requireReadySnapshot } from '../snapshots/snapshots.js';
import {
  rankDeterministically,
  STRUCTURAL_SIGNAL_KINDS,
  type DeterministicCategory,
  type StructuralSignalKind,
} from './deterministic-ranking.js';
import { isSnapshotLexicallyIndexed, LexicalIndexNotBuiltError } from './lexical-index.js';
import type { LexicalCategory } from './lexical-ranking.js';
import { findLexicalMatches, type LexicalQuery } from './lexical-search.js';
import { queryTerms } from './tokenizer.js';

export interface DeterministicQuery extends LexicalQuery {
  /**
   * Git paths of the artifacts the change modifies; structural signals are relative to them. A path
   * the snapshot does not contain (a file the change adds) contributes nothing.
   */
  changedPaths?: readonly string[];
}

/** A structural relationship between a candidate and one changed artifact. */
export interface StructuralSignal {
  kind: StructuralSignalKind;
  changedPath: string;
}

/**
 * One artifact of the searched snapshot with the lexical and structural facts that make it a
 * candidate. `rank` is 1-based and directly usable as the rank in reciprocal rank fusion.
 */
export interface DeterministicCandidate {
  rank: number;
  artifactId: number;
  versionId: number;
  path: string;
  kind: ArtifactKind;
  category: DeterministicCategory;
  /** The category the lexical matches alone would give; null for a purely structural candidate. */
  lexicalCategory: LexicalCategory | null;
  contentMatchCount: number;
  pathMatchCount: number;
  matchedTerms: string[];
  /** Sorted by kind precedence, then changed path. */
  structuralSignals: StructuralSignal[];
  /** Number of changed artifacts the candidate is related to, by kind. */
  structuralCounts: Record<StructuralSignalKind, number>;
}

interface Accumulator {
  artifactId: number;
  versionId: number;
  path: string;
  kind: ArtifactKind;
  contentTerms: Set<string>;
  pathTerms: Set<string>;
  structuralKinds: Set<StructuralSignalKind>;
  signals: StructuralSignal[];
}

/**
 * Deterministic candidates for a change in one ready snapshot, best first: the union of the
 * lexical matches of the query text and the artifacts structurally related to the changed
 * artifacts. A purely structural candidate appears even with no lexical match, and a purely lexical
 * one remains eligible with no structural signal. Callers that do not want the changed artifacts
 * themselves among the candidates remove them.
 *
 * Both the lexical and the structural index of the snapshot must have been built. Throws
 * NotFoundError for an unknown snapshot, SnapshotNotReadyError for a failed one,
 * LexicalIndexNotBuiltError or StructuralIndexNotBuiltError for a missing index.
 */
export function retrieveCandidates(db: Database, snapshotId: number, query: DeterministicQuery): DeterministicCandidate[] {
  const snapshot = requireReadySnapshot(db, snapshotId);
  if (!isSnapshotLexicallyIndexed(db, snapshot.id)) throw new LexicalIndexNotBuiltError(snapshot.id);
  if (!isSnapshotStructurallyIndexed(db, snapshot.id)) throw new StructuralIndexNotBuiltError(snapshot.id);

  const candidates = new Map<number, Accumulator>();
  const candidateFor = (end: RelationshipEnd): Accumulator => {
    let candidate = candidates.get(end.artifactId);
    if (!candidate) {
      candidate = { ...end, contentTerms: new Set(), pathTerms: new Set(), structuralKinds: new Set(), signals: [] };
      candidates.set(end.artifactId, candidate);
    }
    return candidate;
  };

  for (const match of findLexicalMatches(db, snapshot.id, queryTerms(query))) {
    const candidate = candidateFor(match);
    for (const term of match.contentTerms) candidate.contentTerms.add(term);
    for (const term of match.pathTerms) candidate.pathTerms.add(term);
  }

  const changed = (query.changedPaths ?? []).flatMap((path) => {
    const found = findArtifactAtSnapshot(db, snapshot.id, path);
    return found ? [found] : [];
  });
  const changedIds = changed.map((artifact) => artifact.artifactId);
  const changedPathById = new Map(changed.map((artifact) => [artifact.artifactId, artifact.path]));
  const addSignal = (end: RelationshipEnd, kind: StructuralSignalKind, changedArtifactId: number) => {
    const candidate = candidateFor(end);
    candidate.structuralKinds.add(kind);
    candidate.signals.push({ kind, changedPath: changedPathById.get(changedArtifactId)! });
  };

  const incoming = findIncomingRelationships(db, snapshot.id, changedIds);
  const testedPairs = new Set(
    incoming.filter((r) => r.kind === 'test-to-source').map((r) => `${r.source.artifactId}>${r.target.artifactId}`),
  );
  for (const relationship of incoming) {
    const isTest = relationship.kind === 'test-to-source';
    // A test that imports a changed artifact is one test-to-source signal, not also an import one.
    if (!isTest && testedPairs.has(`${relationship.source.artifactId}>${relationship.target.artifactId}`)) continue;
    addSignal(relationship.source, isTest ? 'test-to-source' : 'incoming-import', relationship.target.artifactId);
  }
  for (const relationship of findOutgoingRelationships(db, snapshot.id, changedIds)) {
    if (relationship.kind === 'imports') addSignal(relationship.target, 'outgoing-import', relationship.source.artifactId);
  }

  return rankDeterministically([...candidates.values()]).map((ranked) => {
    const structuralSignals = [...ranked.signals].sort(
      (a, b) =>
        STRUCTURAL_SIGNAL_KINDS.indexOf(a.kind) - STRUCTURAL_SIGNAL_KINDS.indexOf(b.kind) ||
        (a.changedPath < b.changedPath ? -1 : a.changedPath > b.changedPath ? 1 : 0),
    );
    return {
      rank: ranked.rank,
      artifactId: ranked.artifactId,
      versionId: ranked.versionId,
      path: ranked.path,
      kind: ranked.kind,
      category: ranked.category,
      lexicalCategory: ranked.lexicalCategory,
      contentMatchCount: ranked.contentTerms.size,
      pathMatchCount: ranked.pathTerms.size,
      matchedTerms: ranked.matchedTerms,
      structuralSignals,
      structuralCounts: {
        'test-to-source': structuralSignals.filter((s) => s.kind === 'test-to-source').length,
        'incoming-import': structuralSignals.filter((s) => s.kind === 'incoming-import').length,
        'outgoing-import': structuralSignals.filter((s) => s.kind === 'outgoing-import').length,
      },
    };
  });
}
