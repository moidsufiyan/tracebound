export { openDatabase, type Database } from './db/database.js';
export {
  createProject,
  getProject,
  registerRepository,
  getRepository,
  NotFoundError,
  type Project,
  type Repository,
} from './projects/projects.js';
export {
  findSnapshot,
  getSnapshot,
  type RepositorySnapshot,
  type SnapshotStatus,
} from './snapshots/snapshots.js';
export { listSnapshotArtifacts, readContent, type ArtifactKind, type SnapshotArtifact } from './artifacts/artifacts.js';
export { ingestSnapshot, listExcludedEntries, type IngestionResult, type ExcludedEntry } from './ingestion/ingest-snapshot.js';
export { CommitNotFoundError, GitCommandError, InvalidCommitShaError, NotAGitRepositoryError } from './git/git.js';
