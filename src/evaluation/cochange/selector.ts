import { posix } from 'node:path';
import { isTestPath } from '../../analysis/module-resolution.js';
import {
  CommitNotFoundError,
  diffCommits,
  isAncestor,
  isShallowRepository,
  listCommitHistory,
  listTree,
  parseCommitSha,
  readCommit,
  verifyGitRepository,
  type FileChange,
  type HistoryCommit,
} from '../../git/git.js';
import { classifyTreeEntry } from '../../ingestion/file-policy.js';
import { canonicalJson } from '../m9/canonical.js';

// The deterministic commit selector of the co-change evaluation (docs/evaluation/cochange/protocol.md,
// version 1.0.0). It reads Git history only: no snapshot, index, embedding, model or metric is
// involved. Given the same repository, pinned head and configuration it returns the same manifest,
// byte for byte, once serialized with `serializeManifest`.

export const PROTOCOL = { path: 'docs/evaluation/cochange/protocol.md', version: '1.0.0' } as const;

/** The nine design-case commits (docs/evaluation/cases, source_change.commit). Excluded, and their presence makes a repository dependent. */
export const DESIGN_CASE_COMMITS: readonly string[] = Object.freeze([
  'a0885a13d3d17eb6eeace9acb681b8b6c0e851a5',
  'b80220d9c21a2a47a6c32ae1ad81eff3ec49bc9f',
  'afb2068c1c53a530528ac5f237e245793dd03c07',
  'c3053ccf14f1c4c70a0c2888eed6121b9f6c8f95',
  'c91ec9b60df18c76a3feb47533ce097d02f7fe6c',
  'cfd8793c89cfb29c5e885b6ac768e41d22f8927f',
  'bb80f345c868e13a475f7f7a5ad3200dd593e604',
  '6d73a74f9757ed65d6103c0e8375097fa20873c4',
  '5e5b83d6ed963a2bc7d8384002e1c953648253b1',
]);

/** The fixed selection rules of protocol 1.0.0. They are recorded in every manifest. */
export const SELECTION_RULES = Object.freeze({
  maxChangeRecords: 10,
  targetSample: 50,
  minimumSample: 30,
  ordering: 'committer timestamp ascending, then full SHA ascending',
  spacing: 'all eligible commits when 30 to 50; otherwise positions floor(i * n / 50) for i = 0..49',
  renameDetection: 'git diff-tree -r -M (default 50% similarity); a rename is one change record',
  changeSide: 'modified, deleted and type-changed files by their base path; renames by their base-side (old) path; added files are never inputs or targets',
  changeOrder: 'change records sorted by head-side path, then base-side path, in code-unit order',
  independence: 'refused when any design-case commit is an ancestor of the pinned head (whatever the lower bound); design-case SHAs the repository does not contain are ignored; shallow clones are refused',
  usableInBase: 'exists in the base tree and is included by the ingestion file policy (classifyTreeEntry)',
  description: "the commit subject as git log %s gives it",
  classification: {
    test: "kind code and (path contains '.test.' or '.spec.' (isTestPath), or a directory segment is test, tests or __tests__)",
    doc: 'kind document (.md, .mdx, .txt), except release bookkeeping',
    ignoredDocuments: "base name starting with CHANGELOG, CHANGES or HISTORY (case-insensitive), or a path under .changeset/",
    source: 'kind code and not a test',
    ignored: 'every other file (configuration, ignored documents)',
  },
});

export type PathClass = 'source' | 'test' | 'doc' | 'ignored';

export interface ChangeRecord {
  status: FileChange['status'];
  path: string;
  previousPath: string | null;
  similarity: number | null;
  /** The path the commit is judged by in the base: the old path of a rename, null for an added file. */
  basePath: string | null;
  /** The class of `basePath` when it is usable in the base; null when it is absent or excluded by the file policy. */
  baseClass: PathClass | null;
}

export interface SelectedCommit {
  sha: string;
  base: string;
  subject: string;
  /** Position among the eligible commits in chronological order (0 = oldest). */
  eligibleIndex: number;
  changes: ChangeRecord[];
  /** Source paths usable in the base, sorted. */
  inputs: string[];
  /** Test and doc paths usable in the base, sorted by path. */
  targets: { path: string; kind: 'test' | 'doc'; status: FileChange['status'] }[];
}

export type RejectionReason = 'root' | 'merge' | 'design_case' | 'too_many_changes' | 'no_changes' | 'no_source_input' | 'no_target';

export interface CochangeManifest {
  schema: 'tracebound.cochange.manifest';
  schemaVersion: '1.0.0';
  protocol: typeof PROTOCOL;
  repository: { name: string; head: string; since: string | null };
  rules: typeof SELECTION_RULES;
  exclusions: { designCaseCommits: string[] };
  counts: { reachable: number; eligible: number; selected: number; rejected: Record<RejectionReason, number> };
  commits: SelectedCommit[];
}

export interface SelectionInput {
  /** Local path of the repository (read-only); never written to the manifest. */
  repoPath: string;
  /** Recorded identity of the repository, for example "owner/name". */
  repositoryName: string;
  /** Pinned full SHA of the newest commit considered. */
  head: string;
  /** Pinned full SHA of an ancestor of `head`; commits reachable from it are not considered. */
  since?: string;
  /** Commits excluded as design cases. Defaults to DESIGN_CASE_COMMITS; tests pass their own. */
  designCaseCommits?: readonly string[];
}

export type SelectionResult =
  | { status: 'selected'; manifest: CochangeManifest }
  /** Fewer than the minimum eligible commits: the evaluation must not run, and no rule is relaxed. */
  | { status: 'insufficient'; eligible: number; minimum: number; counts: CochangeManifest['counts'] }
  /** A design-case commit is an ancestor of the pinned head: the repository is not independent of the design cases. */
  | { status: 'not_independent'; designCaseCommitsReachable: string[]; counts: CochangeManifest['counts'] };

/** The repository is a shallow clone: its truncated history cannot show that no design-case commit is an ancestor of the head. */
export class ShallowRepositoryError extends Error {
  constructor(repositoryName: string) {
    super(`${repositoryName} is a shallow clone; the co-change selection needs the full history (fetch it with git fetch --unshallow)`);
    this.name = 'ShallowRepositoryError';
  }
}

const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__']);
const IGNORED_DOCUMENT = /^(?:changelog|changes|history)/i;

/** The class of a path that is usable in the base snapshot, from the file policy's kind. */
export function classifyPath(path: string, kind: 'code' | 'document' | 'config'): PathClass {
  if (kind === 'code') {
    const directories = path.split('/').slice(0, -1);
    return isTestPath(path) || directories.some((segment) => TEST_DIRECTORIES.has(segment)) ? 'test' : 'source';
  }
  if (kind === 'document') {
    return IGNORED_DOCUMENT.test(posix.basename(path)) || path.startsWith('.changeset/') ? 'ignored' : 'doc';
  }
  return 'ignored';
}

/** Positions taken from n eligible commits (protocol section 3). */
export function samplePositions(n: number, target = SELECTION_RULES.targetSample): number[] {
  if (n <= target) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: target }, (_, i) => Math.floor((i * n) / target));
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Selects the commits of protocol 1.0.0 from the history of `head` (bounded by `since`). Throws
 * InvalidCommitShaError for an id that is not a full SHA, CommitNotFoundError for one that is not a
 * commit, UnsupportedSelectionRangeError when `since` is not an ancestor of `head`, and
 * ShallowRepositoryError for a shallow clone. Independence is judged against the whole history of
 * `head`; `since` only bounds which commits are candidates.
 */
export async function selectCochangeCommits(input: SelectionInput): Promise<SelectionResult> {
  await verifyGitRepository(input.repoPath);
  const head = parseCommitSha(input.head);
  if (await isShallowRepository(input.repoPath)) throw new ShallowRepositoryError(input.repositoryName);
  const since = input.since === undefined ? null : parseCommitSha(input.since);
  await readCommit(input.repoPath, head);
  if (since !== null) {
    await readCommit(input.repoPath, since);
    if (since === head || !(await isAncestor(input.repoPath, since, head))) {
      throw new UnsupportedSelectionRangeError(`The lower bound ${since} must be a strict ancestor of the head ${head}`);
    }
  }
  const designCases = [...new Set((input.designCaseCommits ?? DESIGN_CASE_COMMITS).map((sha) => parseCommitSha(sha)))].sort(byPath);
  const designSet = new Set(designCases);

  const history = await listCommitHistory(input.repoPath, head, since ?? undefined);
  const rejected: Record<RejectionReason, number> = { root: 0, merge: 0, design_case: 0, too_many_changes: 0, no_changes: 0, no_source_input: 0, no_target: 0 };
  const eligible: Omit<SelectedCommit, 'eligibleIndex'>[] = [];
  const eligibleTimes = new Map<string, number>();

  for (const commit of history) {
    const outcome = await judge(input.repoPath, commit, designSet);
    if ('reason' in outcome) {
      rejected[outcome.reason] += 1;
      continue;
    }
    eligible.push(outcome.selected);
    eligibleTimes.set(commit.sha, commit.committedAtSeconds);
  }

  const reachableDesignCases = await designCaseAncestors(input.repoPath, head, designCases);
  eligible.sort((a, b) => eligibleTimes.get(a.sha)! - eligibleTimes.get(b.sha)! || byPath(a.sha, b.sha));
  const positions = samplePositions(eligible.length);
  const counts = { reachable: history.length, eligible: eligible.length, selected: eligible.length >= SELECTION_RULES.minimumSample ? positions.length : 0, rejected };

  if (reachableDesignCases.length > 0) return { status: 'not_independent', designCaseCommitsReachable: reachableDesignCases, counts };
  if (eligible.length < SELECTION_RULES.minimumSample) {
    return { status: 'insufficient', eligible: eligible.length, minimum: SELECTION_RULES.minimumSample, counts };
  }
  const commits = positions.map((position) => ({ ...eligible[position]!, eligibleIndex: position }));
  return {
    status: 'selected',
    manifest: {
      schema: 'tracebound.cochange.manifest',
      schemaVersion: '1.0.0',
      protocol: PROTOCOL,
      repository: { name: input.repositoryName, head, since },
      rules: SELECTION_RULES,
      exclusions: { designCaseCommits: designCases },
      counts,
      commits,
    },
  };
}

/**
 * The design-case commits that are ancestors of `head`, judged on the full history (not the bounded
 * range). A SHA the repository does not contain as a commit is not an ancestor and is skipped; any
 * other Git failure propagates rather than being read as independence.
 */
async function designCaseAncestors(repoPath: string, head: string, designCases: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const sha of designCases) {
    try {
      await readCommit(repoPath, sha);
    } catch (error) {
      if (error instanceof CommitNotFoundError) continue;
      throw error;
    }
    if (await isAncestor(repoPath, sha, head)) found.push(sha);
  }
  return found.sort(byPath);
}

/** The bounds of a selection are not usable. */
export class UnsupportedSelectionRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSelectionRangeError';
  }
}

async function judge(
  repoPath: string,
  commit: HistoryCommit,
  designCases: ReadonlySet<string>,
): Promise<{ reason: RejectionReason } | { selected: Omit<SelectedCommit, 'eligibleIndex'> }> {
  if (commit.parents.length === 0) return { reason: 'root' };
  if (commit.parents.length > 1) return { reason: 'merge' };
  if (designCases.has(commit.sha)) return { reason: 'design_case' };
  const base = commit.parents[0]!;
  const diff = await diffCommits(repoPath, base, commit.sha);
  if (diff.length === 0) return { reason: 'no_changes' };
  if (diff.length > SELECTION_RULES.maxChangeRecords) return { reason: 'too_many_changes' };

  const basePaths = diff.map((change) => (change.status === 'added' ? null : change.status === 'renamed' ? change.previousPath! : change.path));
  const wanted = [...new Set(basePaths.filter((p): p is string => p !== null))];
  const tree = new Map((await listTree(repoPath, base, wanted)).map((entry) => [entry.path, entry]));

  const unordered: ChangeRecord[] = diff.map((change, i) => {
    const basePath = basePaths[i]!;
    const entry = basePath === null ? undefined : tree.get(basePath);
    const decision = entry ? classifyTreeEntry(entry) : null;
    return {
      status: change.status,
      path: change.path,
      previousPath: change.previousPath,
      similarity: change.similarity,
      basePath,
      baseClass: decision && decision.included ? classifyPath(basePath!, decision.kind) : null,
    };
  });
  // Ordered here rather than relying on the order of git diff-tree's output.
  const changes = unordered.sort((a, b) => byPath(a.path, b.path) || byPath(a.previousPath ?? '', b.previousPath ?? ''));

  const inputs = [...new Set(changes.filter((c) => c.baseClass === 'source').map((c) => c.basePath!))].sort(byPath);
  const targetMap = new Map<string, SelectedCommit['targets'][number]>();
  for (const c of changes) {
    if (c.baseClass === 'test' || c.baseClass === 'doc') targetMap.set(c.basePath!, { path: c.basePath!, kind: c.baseClass, status: c.status });
  }
  const targets = [...targetMap.values()].sort((a, b) => byPath(a.path, b.path));
  if (inputs.some((path) => targetMap.has(path))) throw new Error(`Commit ${commit.sha}: a path is both an input and a target`);
  if (inputs.length === 0) return { reason: 'no_source_input' };
  if (targets.length === 0) return { reason: 'no_target' };
  return { selected: { sha: commit.sha, base, subject: commit.subject, changes, inputs, targets } };
}

/** The manifest as RFC 8785 canonical JSON: the same manifest always gives the same bytes. */
export function serializeManifest(manifest: CochangeManifest): string {
  return canonicalJson(manifest);
}
