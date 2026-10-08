import { inTransaction, type Database } from '../db/database.js';
import { requireReadySnapshot } from '../snapshots/snapshots.js';
import { chunkArtifact, embeddingInputHash } from './chunking.js';
import { EmbeddingInputTooLongError, type EmbeddingProvider } from './provider.js';
import { encodeVector, validateEmbeddings } from './vectors.js';

const EMBEDDING_BATCH_SIZE = 16;
const LOOKUP_SLICE = 500;
// An artifact whose pieces are still rejected at this size cannot be embedded.
const MIN_CHUNK_LIMIT = 400;

export class SemanticIndexNotBuiltError extends Error {
  readonly snapshotId: number;
  readonly modelId: string;

  constructor(snapshotId: number, modelId: string) {
    super(`Snapshot ${snapshotId} has not been semantically indexed for ${modelId}; call indexSnapshotSemantically first`);
    this.name = 'SemanticIndexNotBuiltError';
    this.snapshotId = snapshotId;
    this.modelId = modelId;
  }
}

/** Stored data for this model id was built with different dimensions or limits than the provider has now. */
export class SemanticIndexIncompatibleError extends Error {
  constructor(snapshotId: number, modelId: string, detail: string) {
    super(`Semantic index of snapshot ${snapshotId} for ${modelId} is incompatible with the provider: ${detail}`);
    this.name = 'SemanticIndexIncompatibleError';
  }
}

export interface SemanticIndexingResult {
  /** False when the snapshot was already indexed for this model and nothing was done. */
  indexed: boolean;
  /** Artifacts of the snapshot. */
  artifacts: number;
  /** Chunks of those artifacts, each an embedding input. */
  chunks: number;
  /** Distinct embedding inputs already stored for this model, reused without calling the provider. */
  embeddingsReused: number;
  /** Distinct embedding inputs stored by this call. */
  embeddingsCreated: number;
}

interface PlannedChunk {
  chunkIndex: number;
  text: string;
  hash: string;
}

interface PlannedArtifact {
  artifactId: number;
  path: string;
  text: string;
  /** The character limit its chunks were made for; lowered if the provider rejects a piece. */
  limit: number;
  chunks: PlannedChunk[];
}

interface Marker {
  dimensions: number;
  max_input_chars: number;
}

const NOTHING_DONE: SemanticIndexingResult = { indexed: false, artifacts: 0, chunks: 0, embeddingsReused: 0, embeddingsCreated: 0 };

/**
 * Embeds every artifact of a ready snapshot with `provider` and records which chunks make up the
 * snapshot, so it can be searched. Embeddings already stored for the same model and input text are
 * reused, so only missing ones reach the provider.
 *
 * The provider is never called inside a transaction: embeddings are stored batch by batch
 * (immutable, so leftovers from a failed run are harmless and are reused by the retry), and the
 * snapshot's chunks and its indexed marker are written in one final transaction. A failure at any
 * point leaves the snapshot not indexed.
 *
 * An input the provider rejects as longer than the model's context (a few characters per token on
 * dense text such as encoded keys) is never truncated: its artifact is chunked again at half the
 * limit, repeatedly, until every piece is accepted or the pieces would be too small to be useful.
 *
 * Idempotent per (snapshot, model). Never affects the snapshot's status.
 */
export async function indexSnapshotSemantically(
  db: Database,
  snapshotId: number,
  provider: EmbeddingProvider,
): Promise<SemanticIndexingResult> {
  const snapshot = requireReadySnapshot(db, snapshotId);

  const existing = readMarker(db, provider.modelId, snapshot.id);
  if (existing) {
    assertCompatible(existing, provider, snapshot.id);
    return NOTHING_DONE;
  }

  const artifacts = planArtifacts(db, snapshot.id, provider.maxInputChars);
  const initiallyKnown = knownEmbeddingHashes(db, provider, uniqueInputs(artifacts).map(([hash]) => hash), snapshot.id);
  const stored = new Set(initiallyKnown);
  let created = 0;

  for (;;) {
    const missing = uniqueInputs(artifacts).filter(([hash]) => !stored.has(hash));
    if (missing.length === 0) break;
    const { createdNow, rejected } = await embedMissing(db, provider, missing, stored, artifacts);
    created += createdNow;
    if (rejected.size > 0) shrinkRejectedArtifacts(artifacts, rejected);
  }

  return inTransaction(db, () => {
    // A concurrent call may have finished first.
    if (readMarker(db, provider.modelId, snapshot.id)) return NOTHING_DONE;

    const insertChunk = db.prepare(
      `INSERT INTO semantic_chunk (model_id, snapshot_id, artifact_id, chunk_index, input_hash) VALUES (?, ?, ?, ?, ?)`,
    );
    let chunkCount = 0;
    for (const artifact of artifacts) {
      for (const chunk of artifact.chunks) {
        insertChunk.run(provider.modelId, snapshot.id, artifact.artifactId, chunk.chunkIndex, chunk.hash);
        chunkCount += 1;
      }
    }
    db.prepare(
      `INSERT INTO semantic_indexed_snapshot (model_id, snapshot_id, dimensions, max_input_chars) VALUES (?, ?, ?, ?)`,
    ).run(provider.modelId, snapshot.id, provider.dimensions, provider.maxInputChars);

    return {
      indexed: true,
      artifacts: artifacts.length,
      chunks: chunkCount,
      embeddingsReused: uniqueInputs(artifacts).filter(([hash]) => initiallyKnown.has(hash)).length,
      embeddingsCreated: created,
    };
  });
}

/**
 * Whether the snapshot has been indexed for this provider's model. Throws
 * SemanticIndexIncompatibleError when it was indexed under the same id with other dimensions or
 * limits, which a model id that includes the weights' digest should make impossible.
 */
export function isSnapshotSemanticallyIndexed(db: Database, snapshotId: number, provider: EmbeddingProvider): boolean {
  const marker = readMarker(db, provider.modelId, snapshotId);
  if (!marker) return false;
  assertCompatible(marker, provider, snapshotId);
  return true;
}

function readMarker(db: Database, modelId: string, snapshotId: number): Marker | undefined {
  return db
    .prepare('SELECT dimensions, max_input_chars FROM semantic_indexed_snapshot WHERE model_id = ? AND snapshot_id = ?')
    .get(modelId, snapshotId) as Marker | undefined;
}

function assertCompatible(marker: Marker, provider: EmbeddingProvider, snapshotId: number): void {
  if (marker.dimensions !== provider.dimensions) {
    throw new SemanticIndexIncompatibleError(
      snapshotId,
      provider.modelId,
      `stored ${marker.dimensions} dimensions, provider has ${provider.dimensions}`,
    );
  }
  if (marker.max_input_chars !== provider.maxInputChars) {
    throw new SemanticIndexIncompatibleError(
      snapshotId,
      provider.modelId,
      `chunked for ${marker.max_input_chars} characters, provider accepts ${provider.maxInputChars}`,
    );
  }
}

function planArtifacts(db: Database, snapshotId: number, maxInputChars: number): PlannedArtifact[] {
  const versions = db
    .prepare(
      `SELECT v.artifact_id, a.path, c.text
       FROM artifact_version v
       JOIN artifact a ON a.id = v.artifact_id
       JOIN content c ON c.sha256 = v.content_sha256
       WHERE v.snapshot_id = ?
       ORDER BY a.path`,
    )
    .all(snapshotId) as unknown as { artifact_id: number; path: string; text: string }[];

  return versions.map((version) => {
    const artifact: PlannedArtifact = {
      artifactId: version.artifact_id,
      path: version.path,
      text: version.text,
      limit: maxInputChars,
      chunks: [],
    };
    artifact.chunks = planChunks(artifact);
    return artifact;
  });
}

function planChunks(artifact: PlannedArtifact): PlannedChunk[] {
  return chunkArtifact(artifact.path, artifact.text, artifact.limit).map((input) => ({
    chunkIndex: input.chunkIndex,
    text: input.text,
    hash: embeddingInputHash(input.text),
  }));
}

/** Each distinct embedding input of the plan with its text, in plan order. */
function uniqueInputs(artifacts: readonly PlannedArtifact[]): [string, string][] {
  const inputs = new Map<string, string>();
  for (const artifact of artifacts) for (const chunk of artifact.chunks) inputs.set(chunk.hash, chunk.text);
  return [...inputs];
}

function knownEmbeddingHashes(db: Database, provider: EmbeddingProvider, hashes: string[], snapshotId: number): Set<string> {
  const known = new Set<string>();
  for (let start = 0; start < hashes.length; start += LOOKUP_SLICE) {
    const slice = hashes.slice(start, start + LOOKUP_SLICE);
    const rows = db
      .prepare(
        `SELECT input_hash, dimensions FROM semantic_embedding
         WHERE model_id = ? AND input_hash IN (${slice.map(() => '?').join(', ')})`,
      )
      .all(provider.modelId, ...slice) as unknown as { input_hash: string; dimensions: number }[];
    for (const row of rows) {
      if (row.dimensions !== provider.dimensions) {
        throw new SemanticIndexIncompatibleError(
          snapshotId,
          provider.modelId,
          `a stored embedding has ${row.dimensions} dimensions, provider has ${provider.dimensions}`,
        );
      }
      known.add(row.input_hash);
    }
  }
  return known;
}

/**
 * Embeds and stores `missing` in batches. A batch the provider rejects for length is retried one
 * input at a time; the inputs still rejected are returned so their artifacts can be chunked smaller.
 * Any other failure ends the indexing.
 */
async function embedMissing(
  db: Database,
  provider: EmbeddingProvider,
  missing: readonly (readonly [string, string])[],
  stored: Set<string>,
  artifacts: readonly PlannedArtifact[],
): Promise<{ createdNow: number; rejected: Set<string> }> {
  const rejected = new Set<string>();
  let createdNow = 0;

  const embedAndStore = async (items: readonly (readonly [string, string])[]) => {
    let vectors: Float32Array[];
    try {
      vectors = validateEmbeddings(await provider.embed(items.map(([, text]) => text)), items.length, provider.dimensions);
    } catch (error) {
      if (error instanceof EmbeddingInputTooLongError) throw error;
      throw new Error(`Embedding failed for a batch of ${items.length} inputs (${describePaths(items, artifacts)})`, { cause: error });
    }
    inTransaction(db, () => {
      const insert = db.prepare(
        `INSERT INTO semantic_embedding (model_id, input_hash, dimensions, vector) VALUES (?, ?, ?, ?)
         ON CONFLICT (model_id, input_hash) DO NOTHING`,
      );
      items.forEach(([hash], index) => {
        insert.run(provider.modelId, hash, provider.dimensions, encodeVector(vectors[index]!));
      });
    });
    for (const [hash] of items) stored.add(hash);
    createdNow += items.length;
  };

  for (let start = 0; start < missing.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = missing.slice(start, start + EMBEDDING_BATCH_SIZE);
    try {
      await embedAndStore(batch);
    } catch (error) {
      if (!(error instanceof EmbeddingInputTooLongError)) throw error;
      for (const item of batch) {
        try {
          await embedAndStore([item]);
        } catch (single) {
          if (!(single instanceof EmbeddingInputTooLongError)) throw single;
          rejected.add(item[0]);
        }
      }
    }
  }
  return { createdNow, rejected };
}

function describePaths(items: readonly (readonly [string, string])[], artifacts: readonly PlannedArtifact[]): string {
  const hashes = new Set(items.map(([hash]) => hash));
  const paths = artifacts.filter((a) => a.chunks.some((chunk) => hashes.has(chunk.hash))).map((a) => a.path);
  return `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', ...' : ''}`;
}

/** Chunks again, at half the limit, every artifact that has a piece the provider rejected. */
function shrinkRejectedArtifacts(artifacts: readonly PlannedArtifact[], rejected: ReadonlySet<string>): void {
  for (const artifact of artifacts) {
    if (!artifact.chunks.some((chunk) => rejected.has(chunk.hash))) continue;
    artifact.limit = Math.floor(artifact.limit / 2);
    if (artifact.limit < MIN_CHUNK_LIMIT) {
      throw new EmbeddingInputTooLongError(`${artifact.path} is still rejected as too long when split into pieces of ${artifact.limit * 2} characters`);
    }
    artifact.chunks = planChunks(artifact);
  }
}
