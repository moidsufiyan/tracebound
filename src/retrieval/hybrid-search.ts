import { posix } from 'node:path';
import { isSnapshotStructurallyIndexed, StructuralIndexNotBuiltError } from '../analysis/structural-index.js';
import type { Database } from '../db/database.js';
import type { EmbeddingProvider } from '../semantic/provider.js';
import { isSnapshotSemanticallyIndexed, SemanticIndexNotBuiltError } from '../semantic/semantic-index.js';
import { searchSemantic, type SemanticCandidate } from '../semantic/semantic-search.js';
import { requireReadySnapshot } from '../snapshots/snapshots.js';
import { retrieveCandidates, type DeterministicCandidate } from './deterministic-retrieval.js';
import { isSnapshotLexicallyIndexed, LexicalIndexNotBuiltError } from './lexical-index.js';
import { DEFAULT_RRF_K, fuseRrf, type FusedCandidate } from './rrf.js';

export interface HybridQuery {
  /** The change description. */
  description: string;
  /** Git paths of the files the change modifies. */
  changedPaths: readonly string[];
  /** Explicit identifiers (function or constant names) for the lexical side. */
  symbols?: readonly string[];
}

/** One hybrid run with the inputs that produced its ranking, so nothing needs to be retrieved again. */
export interface HybridSearchResult {
  snapshotId: number;
  /** The query as supplied. */
  query: HybridQuery;
  /** The RRF constant the fusion used. */
  rrfK: number;
  /** The embedding model whose index the semantic ranking came from. */
  modelId: string;
  /** The complete deterministic ranking. */
  deterministic: DeterministicCandidate[];
  /** The complete semantic ranking. */
  semantic: SemanticCandidate[];
  /** The fused ranking: the same candidates `searchHybrid` returns. */
  fused: FusedCandidate[];
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
  return (await searchHybridDetailed(db, snapshotId, provider, query)).fused;
}

/**
 * The same search as `searchHybrid`, returning the deterministic and semantic rankings and the
 * fusion settings along with the fused ranking. Evidence is built from this result, which is why
 * it never has to repeat the retrieval or the query embedding.
 */
export async function searchHybridDetailed(
  db: Database,
  snapshotId: number,
  provider: EmbeddingProvider,
  query: HybridQuery,
): Promise<HybridSearchResult> {
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

  const rrfK = DEFAULT_RRF_K;
  return {
    snapshotId: snapshot.id,
    query,
    rrfK,
    modelId: provider.modelId,
    deterministic,
    semantic,
    fused: fuseRrf(deterministic, semantic, { k: rrfK }),
  };
}
