import { inTransaction, type Database } from '../db/database.js';
import { requireReadySnapshot } from '../snapshots/snapshots.js';
import { tokenize } from './tokenizer.js';

export class LexicalIndexNotBuiltError extends Error {
  readonly snapshotId: number;

  constructor(snapshotId: number) {
    super(`Snapshot ${snapshotId} has not been lexically indexed; call indexSnapshotLexically first`);
    this.name = 'LexicalIndexNotBuiltError';
    this.snapshotId = snapshotId;
  }
}

export interface LexicalIndexingResult {
  /** Distinct contents of the snapshot tokenized by this call. */
  contentsIndexed: number;
  /** Artifacts of the snapshot whose paths were tokenized by this call. */
  artifactsIndexed: number;
}

/**
 * Builds the derived lexical index for everything a ready snapshot references. Idempotent: content
 * and artifacts that are already indexed are skipped, so this is also the backfill for snapshots
 * ingested before the index existed. The index is derived data and never affects a snapshot's
 * status; all rows are written in one transaction, so a failure leaves the index as it was.
 */
export function indexSnapshotLexically(db: Database, snapshotId: number): LexicalIndexingResult {
  const snapshot = requireReadySnapshot(db, snapshotId);

  return inTransaction(db, () => {
    const insertContentToken = db.prepare('INSERT INTO content_token (token, content_sha256) VALUES (?, ?)');
    const markContent = db.prepare('INSERT INTO lexical_indexed_content (content_sha256) VALUES (?)');
    const insertPathToken = db.prepare('INSERT INTO artifact_path_token (token, artifact_id) VALUES (?, ?)');

    const contents = db
      .prepare(
        `SELECT DISTINCT c.sha256, c.text
         FROM artifact_version v
         JOIN content c ON c.sha256 = v.content_sha256
         WHERE v.snapshot_id = ?
           AND NOT EXISTS (SELECT 1 FROM lexical_indexed_content i WHERE i.content_sha256 = c.sha256)
         ORDER BY c.sha256`,
      )
      .all(snapshot.id) as unknown as { sha256: string; text: string }[];
    for (const { sha256, text } of contents) {
      for (const token of tokenize(text)) insertContentToken.run(token, sha256);
      markContent.run(sha256);
    }

    const artifacts = db
      .prepare(
        `SELECT a.id, a.path
         FROM artifact_version v
         JOIN artifact a ON a.id = v.artifact_id
         WHERE v.snapshot_id = ?
           AND NOT EXISTS (SELECT 1 FROM artifact_path_token t WHERE t.artifact_id = a.id)
         ORDER BY a.id`,
      )
      .all(snapshot.id) as unknown as { id: number; path: string }[];
    for (const { id, path } of artifacts) {
      const tokens = tokenize(path);
      if (tokens.length === 0) throw new Error(`Artifact ${id} path "${path}" produced no tokens`);
      for (const token of tokens) insertPathToken.run(token, id);
    }

    return { contentsIndexed: contents.length, artifactsIndexed: artifacts.length };
  });
}

/** True when every content and every artifact path of the snapshot has been indexed. */
export function isSnapshotLexicallyIndexed(db: Database, snapshotId: number): boolean {
  const row = db
    .prepare(
      `SELECT EXISTS (
         SELECT 1 FROM artifact_version v
         WHERE v.snapshot_id = ?1
           AND (NOT EXISTS (SELECT 1 FROM lexical_indexed_content i WHERE i.content_sha256 = v.content_sha256)
             OR NOT EXISTS (SELECT 1 FROM artifact_path_token t WHERE t.artifact_id = v.artifact_id))
       ) AS missing`,
    )
    .get(snapshotId) as { missing: number };
  return row.missing === 0;
}
