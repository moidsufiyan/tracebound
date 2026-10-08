import type { ArtifactKind } from '../artifacts/artifacts.js';
import type { Database } from '../db/database.js';
import { requireReadySnapshot } from '../snapshots/snapshots.js';
import { formatSemanticQuery } from './chunking.js';
import type { EmbeddingProvider } from './provider.js';
import { isSnapshotSemanticallyIndexed, SemanticIndexNotBuiltError } from './semantic-index.js';
import { cosineSimilarity, decodeVector, validateEmbeddings } from './vectors.js';

export interface SemanticQuery {
  /** The change description. */
  description: string;
  /** Git paths of the files the change modifies. */
  changedPaths: readonly string[];
}

/**
 * One artifact of the searched snapshot, scored by its best-matching chunk. `rank` is 1-based and
 * directly usable as the rank in reciprocal rank fusion.
 */
export interface SemanticCandidate {
  rank: number;
  artifactId: number;
  versionId: number;
  path: string;
  kind: ArtifactKind;
  /** Cosine similarity between the query and the artifact's best chunk, in [-1, 1]. */
  similarityScore: number;
  /** Index of that chunk within the artifact, for debugging a match. */
  bestChunkIndex: number;
}

interface ChunkRow {
  artifact_id: number;
  version_id: number;
  path: string;
  kind: ArtifactKind;
  chunk_index: number;
  dimensions: number;
  vector: Uint8Array;
}

/**
 * Semantic candidates for a change in one ready snapshot, best first, by exact cosine similarity of
 * the embedded query against every stored chunk of that snapshot made with the provider's model.
 * Chunks of the same artifact collapse to the best one. Every artifact of the snapshot is a
 * candidate; nothing outside it is, however its embedding is shared.
 *
 * Throws NotFoundError for an unknown snapshot, SnapshotNotReadyError for a failed one,
 * SemanticIndexNotBuiltError when the snapshot has not been indexed for the provider's model, and
 * SemanticIndexIncompatibleError when it was indexed with other dimensions or limits.
 */
export async function searchSemantic(
  db: Database,
  snapshotId: number,
  provider: EmbeddingProvider,
  query: SemanticQuery,
): Promise<SemanticCandidate[]> {
  const snapshot = requireReadySnapshot(db, snapshotId);
  if (!isSnapshotSemanticallyIndexed(db, snapshot.id, provider)) {
    throw new SemanticIndexNotBuiltError(snapshot.id, provider.modelId);
  }

  const [queryVector] = validateEmbeddings(
    await provider.embed([formatSemanticQuery(query.description, query.changedPaths)]),
    1,
    provider.dimensions,
  );

  const rows = db
    .prepare(
      `SELECT c.artifact_id, v.id AS version_id, a.path, a.kind, c.chunk_index, e.dimensions, e.vector
       FROM semantic_chunk c
       JOIN semantic_embedding e ON e.model_id = c.model_id AND e.input_hash = c.input_hash
       JOIN artifact_version v ON v.snapshot_id = c.snapshot_id AND v.artifact_id = c.artifact_id
       JOIN artifact a ON a.id = c.artifact_id
       WHERE c.model_id = ? AND c.snapshot_id = ?`,
    )
    .all(provider.modelId, snapshot.id) as unknown as ChunkRow[];

  const best = new Map<number, Omit<SemanticCandidate, 'rank'>>();
  for (const row of rows) {
    if (row.dimensions !== provider.dimensions) {
      throw new Error(`Stored embedding of ${row.path} has ${row.dimensions} dimensions, provider has ${provider.dimensions}`);
    }
    const similarityScore = cosineSimilarity(queryVector!, decodeVector(row.vector, row.dimensions));
    const current = best.get(row.artifact_id);
    // Equal scores keep the lower chunk index, so the choice does not depend on row order.
    if (
      !current ||
      similarityScore > current.similarityScore ||
      (similarityScore === current.similarityScore && row.chunk_index < current.bestChunkIndex)
    ) {
      best.set(row.artifact_id, {
        artifactId: row.artifact_id,
        versionId: row.version_id,
        path: row.path,
        kind: row.kind,
        similarityScore,
        bestChunkIndex: row.chunk_index,
      });
    }
  }

  return [...best.values()]
    .sort(
      (a, b) =>
        b.similarityScore - a.similarityScore ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        a.artifactId - b.artifactId,
    )
    .map((candidate, index) => ({ rank: index + 1, ...candidate }));
}
