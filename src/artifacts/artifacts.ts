import type { Database } from '../db/database.js';
import { requireReadySnapshot } from '../snapshots/snapshots.js';

export type ArtifactKind = 'code' | 'document' | 'config';

/** Normalized text identified by the SHA-256 of its UTF-8 bytes. */
export interface Content {
  sha256: string;
  text: string;
  byteLength: number;
}

/** An artifact as it exists in one snapshot, joined with its logical identity. */
export interface SnapshotArtifact {
  artifactId: number;
  versionId: number;
  path: string;
  kind: ArtifactKind;
  contentSha256: string;
  gitBlobSha: string;
}

interface SnapshotArtifactRow {
  artifact_id: number;
  version_id: number;
  path: string;
  kind: ArtifactKind;
  content_sha256: string;
  git_blob_sha: string;
}

/** Stores content once per hash. Content is immutable, so an existing row is left untouched. */
export function storeContent(db: Database, content: Content): void {
  db.prepare('INSERT INTO content (sha256, text, byte_length) VALUES (?, ?, ?) ON CONFLICT (sha256) DO NOTHING').run(
    content.sha256,
    content.text,
    content.byteLength,
  );
}

export function readContent(db: Database, sha256: string): string | undefined {
  const row = db.prepare('SELECT text FROM content WHERE sha256 = ?').get(sha256) as { text: string } | undefined;
  return row?.text;
}

/** Returns the id of the artifact at `path` in the repository, creating it on first sight. */
export function ensureArtifact(db: Database, repositoryId: number, path: string, kind: ArtifactKind): number {
  db.prepare('INSERT INTO artifact (repository_id, path, kind) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(
    repositoryId,
    path,
    kind,
  );
  const row = db.prepare('SELECT id FROM artifact WHERE repository_id = ? AND path = ?').get(repositoryId, path) as {
    id: number;
  };
  return row.id;
}

export function insertArtifactVersion(
  db: Database,
  version: { repositoryId: number; artifactId: number; snapshotId: number; contentSha256: string; gitBlobSha: string },
): void {
  db.prepare(
    `INSERT INTO artifact_version (repository_id, artifact_id, snapshot_id, content_sha256, git_blob_sha)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(version.repositoryId, version.artifactId, version.snapshotId, version.contentSha256, version.gitBlobSha);
}

/** Every artifact version captured by the snapshot, ordered by path. */
export function listSnapshotArtifacts(db: Database, snapshotId: number): SnapshotArtifact[] {
  const rows = db
    .prepare(
      `SELECT a.id AS artifact_id, v.id AS version_id, a.path, a.kind, v.content_sha256, v.git_blob_sha
       FROM artifact_version v JOIN artifact a ON a.id = v.artifact_id
       WHERE v.snapshot_id = ?
       ORDER BY a.path`,
    )
    .all(snapshotId) as unknown as SnapshotArtifactRow[];
  return rows.map(toSnapshotArtifact);
}

/**
 * Finds the artifact at `gitRepositoryPath` as it exists in one ready snapshot. Returns undefined
 * when the snapshot does not contain that path; it never consults any other snapshot or HEAD.
 * Throws NotFoundError for an unknown snapshot and SnapshotNotReadyError for a failed one.
 */
export function findArtifactAtSnapshot(
  db: Database,
  snapshotId: number,
  gitRepositoryPath: string,
): SnapshotArtifact | undefined {
  const snapshot = requireReadySnapshot(db, snapshotId);
  const row = db
    .prepare(
      `SELECT a.id AS artifact_id, v.id AS version_id, a.path, a.kind, v.content_sha256, v.git_blob_sha
       FROM artifact a JOIN artifact_version v ON v.artifact_id = a.id AND v.snapshot_id = ?
       WHERE a.repository_id = ? AND a.path = ?`,
    )
    .get(snapshot.id, snapshot.repositoryId, gitRepositoryPath) as SnapshotArtifactRow | undefined;
  return row && toSnapshotArtifact(row);
}

function toSnapshotArtifact(row: SnapshotArtifactRow): SnapshotArtifact {
  return {
    artifactId: row.artifact_id,
    versionId: row.version_id,
    path: row.path,
    kind: row.kind,
    contentSha256: row.content_sha256,
    gitBlobSha: row.git_blob_sha,
  };
}
