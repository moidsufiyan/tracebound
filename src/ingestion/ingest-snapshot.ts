import { ensureArtifact, insertArtifactVersion, storeContent, type ArtifactKind } from '../artifacts/artifacts.js';
import { inTransaction, type Database } from '../db/database.js';
import { BlobReader, listTree, parseCommitSha, readCommit, type CommitInfo } from '../git/git.js';
import { getRepository, NotFoundError } from '../projects/projects.js';
import {
  deleteFailedSnapshot,
  findSnapshot,
  insertReadySnapshot,
  recordSnapshotFailure,
  type RepositorySnapshot,
} from '../snapshots/snapshots.js';
import { normalizeContent } from './content.js';
import { classifyTreeEntry, type ExclusionReason } from './file-policy.js';

export interface IngestionResult {
  snapshot: RepositorySnapshot;
  /** False when a ready snapshot for this commit already existed and was returned unchanged. */
  created: boolean;
}

export interface ExcludedEntry {
  path: string;
  reason: ExclusionReason;
}

interface CollectedFile {
  path: string;
  kind: ArtifactKind;
  contentSha256: string;
  gitBlobSha: string;
}

interface CollectedTree {
  files: CollectedFile[];
  exclusions: ExcludedEntry[];
}

/**
 * Captures `commitSha` of a registered repository as a ready RepositorySnapshot.
 *
 * Idempotent: a commit that is already ready is returned as-is. File contents are read
 * and stored first (content rows are immutable and content-addressed, so leftovers from
 * a failed run are harmless); the snapshot, its artifacts, versions and exclusions are
 * then written in one synchronous transaction. A failure after the commit is verified
 * leaves a 'failed' snapshot with no versions, which a later call replaces.
 */
export async function ingestSnapshot(db: Database, repositoryId: number, commitSha: string): Promise<IngestionResult> {
  const repository = getRepository(db, repositoryId);
  if (!repository) throw new NotFoundError('Repository', repositoryId);
  const sha = parseCommitSha(commitSha);

  const existing = findSnapshot(db, repository.id, sha);
  if (existing?.status === 'ready') return { snapshot: existing, created: false };

  const commit = await readCommit(repository.sourcePath, sha);
  try {
    const tree = await collectTree(db, repository.sourcePath, commit.sha);
    return persistSnapshot(db, repository.id, commit, tree);
  } catch (error) {
    recordSnapshotFailure(db, repository.id, commit, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function listExcludedEntries(db: Database, snapshotId: number): ExcludedEntry[] {
  return db
    .prepare('SELECT path, reason FROM excluded_entry WHERE snapshot_id = ? ORDER BY path')
    .all(snapshotId) as unknown as ExcludedEntry[];
}

async function collectTree(db: Database, repoPath: string, commitSha: string): Promise<CollectedTree> {
  // Plain code-unit ordering, not localeCompare: the order must not depend on the host locale.
  const entries = (await listTree(repoPath, commitSha)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files: CollectedFile[] = [];
  const exclusions: ExcludedEntry[] = [];

  const reader = new BlobReader(repoPath);
  try {
    for (const entry of entries) {
      const decision = classifyTreeEntry(entry);
      if (!decision.included) {
        exclusions.push({ path: entry.path, reason: decision.reason });
        continue;
      }
      const content = normalizeContent(await reader.read(entry.objectSha));
      if (!content.ok) {
        exclusions.push({ path: entry.path, reason: content.reason });
        continue;
      }
      storeContent(db, content);
      files.push({ path: entry.path, kind: decision.kind, contentSha256: content.sha256, gitBlobSha: entry.objectSha });
    }
  } finally {
    await reader.close();
  }
  return { files, exclusions };
}

function persistSnapshot(db: Database, repositoryId: number, commit: CommitInfo, tree: CollectedTree): IngestionResult {
  return inTransaction(db, () => {
    // Re-check inside the transaction: a concurrent ingestion of the same commit may have finished first.
    const existing = findSnapshot(db, repositoryId, commit.sha);
    if (existing?.status === 'ready') return { snapshot: existing, created: false };
    if (existing) deleteFailedSnapshot(db, existing.id);

    const snapshot = insertReadySnapshot(db, repositoryId, commit);
    for (const file of tree.files) {
      const artifactId = ensureArtifact(db, repositoryId, file.path, file.kind);
      insertArtifactVersion(db, {
        repositoryId,
        artifactId,
        snapshotId: snapshot.id,
        contentSha256: file.contentSha256,
        gitBlobSha: file.gitBlobSha,
      });
    }
    const insertExclusion = db.prepare('INSERT INTO excluded_entry (snapshot_id, path, reason) VALUES (?, ?, ?)');
    for (const exclusion of tree.exclusions) insertExclusion.run(snapshot.id, exclusion.path, exclusion.reason);

    return { snapshot, created: true };
  });
}
