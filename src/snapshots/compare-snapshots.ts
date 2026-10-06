import type { ArtifactKind } from '../artifacts/artifacts.js';
import type { Database } from '../db/database.js';
import { requireReadySnapshot } from './snapshots.js';

export class SnapshotRepositoryMismatchError extends Error {
  constructor(baseSnapshotId: number, targetSnapshotId: number) {
    super(`Snapshots ${baseSnapshotId} and ${targetSnapshotId} belong to different repositories`);
    this.name = 'SnapshotRepositoryMismatchError';
  }
}

/** One side of a comparison: an ArtifactVersion in one of the two snapshots. */
export interface ComparedVersion {
  versionId: number;
  contentSha256: string;
  gitBlobSha: string;
}

interface ChangeIdentity {
  artifactId: number;
  path: string;
  kind: ArtifactKind;
}

export type ArtifactChange = ChangeIdentity &
  (
    | { change: 'added'; base: null; target: ComparedVersion }
    | { change: 'deleted'; base: ComparedVersion; target: null }
    | { change: 'modified' | 'unchanged'; base: ComparedVersion; target: ComparedVersion }
  );

interface ChangeRow {
  artifact_id: number;
  path: string;
  kind: ArtifactKind;
  base_version_id: number | null;
  base_content_sha256: string | null;
  base_git_blob_sha: string | null;
  target_version_id: number | null;
  target_content_sha256: string | null;
  target_git_blob_sha: string | null;
}

/**
 * Compares two ready snapshots of the same repository, one result per artifact present in either.
 * Artifacts are matched by identity (repository, Git path), so a rename is a delete plus an add.
 * `modified` is decided by the normalized content SHA-256, not by the Git blob id. Results are
 * ordered by Git path: byte order of the UTF-8 path, which is SQLite's default text collation.
 */
export function compareSnapshots(db: Database, baseSnapshotId: number, targetSnapshotId: number): ArtifactChange[] {
  const base = requireReadySnapshot(db, baseSnapshotId);
  const target = requireReadySnapshot(db, targetSnapshotId);
  if (base.repositoryId !== target.repositoryId) {
    throw new SnapshotRepositoryMismatchError(base.id, target.id);
  }

  const rows = db
    .prepare(
      `SELECT a.id AS artifact_id, a.path, a.kind,
              bv.id AS base_version_id, bv.content_sha256 AS base_content_sha256, bv.git_blob_sha AS base_git_blob_sha,
              tv.id AS target_version_id, tv.content_sha256 AS target_content_sha256, tv.git_blob_sha AS target_git_blob_sha
       FROM artifact a
       LEFT JOIN artifact_version bv ON bv.artifact_id = a.id AND bv.snapshot_id = ?
       LEFT JOIN artifact_version tv ON tv.artifact_id = a.id AND tv.snapshot_id = ?
       WHERE a.repository_id = ? AND (bv.id IS NOT NULL OR tv.id IS NOT NULL)
       ORDER BY a.path`,
    )
    .all(base.id, target.id, base.repositoryId) as unknown as ChangeRow[];
  return rows.map(toChange);
}

function toChange(row: ChangeRow): ArtifactChange {
  const identity = { artifactId: row.artifact_id, path: row.path, kind: row.kind };
  const base = toVersion(row.base_version_id, row.base_content_sha256, row.base_git_blob_sha);
  const target = toVersion(row.target_version_id, row.target_content_sha256, row.target_git_blob_sha);

  if (base && target) {
    return { ...identity, change: base.contentSha256 === target.contentSha256 ? 'unchanged' : 'modified', base, target };
  }
  if (target) return { ...identity, change: 'added', base: null, target };
  if (base) return { ...identity, change: 'deleted', base, target: null };
  throw new Error(`Artifact ${row.artifact_id} has no version in either snapshot`);
}

function toVersion(versionId: number | null, contentSha256: string | null, gitBlobSha: string | null): ComparedVersion | null {
  if (versionId === null || contentSha256 === null || gitBlobSha === null) return null;
  return { versionId, contentSha256, gitBlobSha };
}
