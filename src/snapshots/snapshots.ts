import type { Database } from '../db/database.js';
import type { CommitInfo } from '../git/git.js';
import { NotFoundError } from '../projects/projects.js';

export type SnapshotStatus = 'ready' | 'failed';

/** One exact repository state, identified by (repository, commit). */
export interface RepositorySnapshot {
  id: number;
  repositoryId: number;
  commitSha: string;
  treeSha: string;
  committedAt: string;
  status: SnapshotStatus;
  failureReason: string | null;
  recordedAt: string;
}

interface SnapshotRow {
  id: number;
  repository_id: number;
  commit_sha: string;
  tree_sha: string;
  committed_at: string;
  status: SnapshotStatus;
  failure_reason: string | null;
  recorded_at: string;
}

export class SnapshotNotReadyError extends Error {
  readonly snapshotId: number;
  readonly status: SnapshotStatus;

  constructor(snapshotId: number, status: SnapshotStatus) {
    super(`Snapshot ${snapshotId} is ${status}, not ready`);
    this.name = 'SnapshotNotReadyError';
    this.snapshotId = snapshotId;
    this.status = status;
  }
}

/** Returns the snapshot, throwing NotFoundError if it does not exist and SnapshotNotReadyError unless it is ready. */
export function requireReadySnapshot(db: Database, id: number): RepositorySnapshot {
  const snapshot = getSnapshot(db, id);
  if (!snapshot) throw new NotFoundError('Snapshot', id);
  if (snapshot.status !== 'ready') throw new SnapshotNotReadyError(id, snapshot.status);
  return snapshot;
}

export function findSnapshot(db: Database, repositoryId: number, commitSha: string): RepositorySnapshot | undefined {
  const row = db
    .prepare('SELECT * FROM repository_snapshot WHERE repository_id = ? AND commit_sha = ?')
    .get(repositoryId, commitSha) as SnapshotRow | undefined;
  return row && toSnapshot(row);
}

export function getSnapshot(db: Database, id: number): RepositorySnapshot | undefined {
  const row = db.prepare('SELECT * FROM repository_snapshot WHERE id = ?').get(id) as SnapshotRow | undefined;
  return row && toSnapshot(row);
}

/** Inserts a ready snapshot. Callers must write its artifact versions in the same transaction. */
export function insertReadySnapshot(db: Database, repositoryId: number, commit: CommitInfo): RepositorySnapshot {
  const row = db
    .prepare(
      `INSERT INTO repository_snapshot (repository_id, commit_sha, tree_sha, committed_at, status, recorded_at)
       VALUES (?, ?, ?, ?, 'ready', ?) RETURNING *`,
    )
    .get(repositoryId, commit.sha, commit.treeSha, commit.committedAt, new Date().toISOString()) as unknown as SnapshotRow;
  return toSnapshot(row);
}

/** Deletes a failed snapshot so the commit can be ingested again. Failed snapshots own no child rows. */
export function deleteFailedSnapshot(db: Database, id: number): void {
  const { changes } = db.prepare("DELETE FROM repository_snapshot WHERE id = ? AND status = 'failed'").run(id);
  if (changes !== 1) throw new Error(`Snapshot ${id} is not a failed snapshot`);
}

/** Records (or updates) a failed attempt. A ready snapshot for the same commit is never overwritten. */
export function recordSnapshotFailure(db: Database, repositoryId: number, commit: CommitInfo, reason: string): void {
  db.prepare(
    `INSERT INTO repository_snapshot (repository_id, commit_sha, tree_sha, committed_at, status, failure_reason, recorded_at)
     VALUES (?, ?, ?, ?, 'failed', ?, ?)
     ON CONFLICT (repository_id, commit_sha) DO UPDATE
       SET failure_reason = excluded.failure_reason, recorded_at = excluded.recorded_at
       WHERE status = 'failed'`,
  ).run(repositoryId, commit.sha, commit.treeSha, commit.committedAt, reason, new Date().toISOString());
}

function toSnapshot(row: SnapshotRow): RepositorySnapshot {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    commitSha: row.commit_sha,
    treeSha: row.tree_sha,
    committedAt: row.committed_at,
    status: row.status,
    failureReason: row.failure_reason,
    recordedAt: row.recorded_at,
  };
}
