import { posix } from 'node:path';
import { isSnapshotStructurallyIndexed, StructuralIndexNotBuiltError } from '../analysis/structural-index.js';
import type { Database } from '../db/database.js';
import type { EmbeddingProvider } from '../semantic/provider.js';
import { isSnapshotSemanticallyIndexed, SemanticIndexNotBuiltError } from '../semantic/semantic-index.js';
import { searchSemantic } from '../semantic/semantic-search.js';
import { requireReadySnapshot } from '../snapshots/snapshots.js';
import { retrieveCandidates } from './deterministic-retrieval.js';
import { isSnapshotLexicallyIndexed, LexicalIndexNotBuiltError } from './lexical-index.js';
import { fuseRrf, type FusedCandidate } from './rrf.js';

export interface HybridQuery {
  /** The change description. */
  description: string;
  /** Git paths of the files the change modifies. */
  changedPaths: readonly string[];
  /** Explicit identifiers (function or constant names) for the lexical side. */
  symbols?: readonly string[];
}

/**
 * Hybrid candidates for a change in one ready snapshot, best first: the deterministic candidates
 * (lexical and structural signals) and the semantic candidates, fused with Reciprocal Rank Fusion
 * (K = 60). Both rankings are used whole and unfiltered, so the changed files themselves are
 * ordinary candidates; a caller that does not want them removes them from the result.
 *
 * The query is mapped to the two pipelines as the research did: the lexical text is the description
 * followed by the base names of the changed files, with the symbols as explicit identifiers; the
 * semantic query is the description and the changed paths.
 *
 * Requires the lexical index, the structural index and the semantic index for the provider's model,
 * and fails with the corresponding error, before any provider call, if one is missing. Throws
 * NotFoundError for an unknown snapshot, SnapshotNotReadyError for a failed one,
 * LexicalIndexNotBuiltError, StructuralIndexNotBuiltError, SemanticIndexNotBuiltError, or
 * SemanticIndexIncompatibleError.
 */
export async function searchHybrid(
  db: Database,
  snapshotId: number,
  provider: EmbeddingProvider,
  query: HybridQuery,
): Promise<FusedCandidate[]> {
  const snapshot = requireReadySnapshot(db, snapshotId);
  if (!isSnapshotLexicallyIndexed(db, snapshot.id)) throw new LexicalIndexNotBuiltError(snapshot.id);
  if (!isSnapshotStructurallyIndexed(db, snapshot.id)) throw new StructuralIndexNotBuiltError(snapshot.id);
  if (!isSnapshotSemanticallyIndexed(db, snapshot.id, provider)) {
    throw new SemanticIndexNotBuiltError(snapshot.id, provider.modelId);
  }

  const deterministic = retrieveCandidates(db, snapshot.id, {
    text: [query.description, ...query.changedPaths.map((path) => posix.basename(path))].join(' '),
    ...(query.symbols ? { symbols: query.symbols } : {}),
    changedPaths: query.changedPaths,
  });
  const semantic = await searchSemantic(db, snapshot.id, provider, {
    description: query.description,
    changedPaths: query.changedPaths,
  });

  return fuseRrf(deterministic, semantic);
}
