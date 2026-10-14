import { diffCommits, isAncestor, parseCommitSha, readCommit, verifyGitRepository, type FileChange } from '../git/git.js';

// A change defined by two commits of one repository. The investigation runs against the base
// commit (the state before the change); the changed paths are derived from the diff of base and
// head. Nothing here reads the working tree, the index or any ref: both commits are named by full id.

/** The commits and file changes of a change, kept in the report as its provenance. */
export interface CommitRange {
  base: string;
  head: string;
  changes: readonly FileChange[];
}

/** The base must be a strict ancestor of the head. */
export class UnsupportedCommitRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCommitRangeError';
  }
}

/** No file differs between base and head. */
export class EmptyChangeSetError extends Error {
  constructor(base: string, head: string) {
    super(`No file differs between ${base} and ${head}: there is no change to investigate`);
    this.name = 'EmptyChangeSetError';
  }
}

/**
 * Validates the range and reads its file changes. Both ids must be full commit SHAs of commits in
 * the repository (InvalidCommitShaError, CommitNotFoundError), the base must differ from the head
 * and be its ancestor (UnsupportedCommitRangeError), and at least one file must differ
 * (EmptyChangeSetError). A merge commit as head is compared with the base as a whole tree, not per
 * parent.
 */
export async function resolveCommitRange(repoPath: string, baseSha: string, headSha: string): Promise<CommitRange> {
  await verifyGitRepository(repoPath);
  const base = parseCommitSha(baseSha);
  const head = parseCommitSha(headSha);
  await readCommit(repoPath, base);
  await readCommit(repoPath, head);
  if (base === head) throw new UnsupportedCommitRangeError(`The base and head commits are the same (${base})`);
  if (!(await isAncestor(repoPath, base, head))) {
    throw new UnsupportedCommitRangeError(`The base commit ${base} is not an ancestor of the head commit ${head}; only a base that the head descends from is supported`);
  }
  const changes = await diffCommits(repoPath, base, head);
  if (changes.length === 0) throw new EmptyChangeSetError(base, head);
  return { base, head, changes };
}

/**
 * The changed paths to investigate, in diff order: every changed path, and for a rename the old
 * path (which exists in the base snapshot) followed by the new one (which does not). Added files
 * and new names are kept, so the report can say they are missing from the base snapshot.
 */
export function changedPathsOf(range: CommitRange): string[] {
  const paths: string[] = [];
  for (const change of range.changes) {
    if (change.previousPath !== null) paths.push(change.previousPath);
    paths.push(change.path);
  }
  return [...new Set(paths)];
}

/** How a path changed between base and head, in words. Null when the range does not mention it. */
export function describeChangeOf(range: CommitRange, path: string): string | null {
  for (const change of range.changes) {
    if (change.status === 'renamed') {
      if (change.previousPath === path) return `renamed to ${change.path} (${change.similarity}% similar)`;
      if (change.path === path) return `renamed from ${change.previousPath} (${change.similarity}% similar)`;
    } else if (change.path === path) {
      return change.status === 'type_changed' ? 'type changed' : change.status;
    }
  }
  return null;
}
