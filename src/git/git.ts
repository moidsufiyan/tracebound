import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// Read-only access to a local Git object database. Every command addresses objects
// by id, so the working tree, index, HEAD and branches of the source repository are
// never read or modified.

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  // Never reach out to a promisor remote to fill in objects missing from a partial clone.
  GIT_NO_LAZY_FETCH: '1',
  GIT_OPTIONAL_LOCKS: '0',
};

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export class GitCommandError extends Error {
  readonly exitCode: number | null;

  constructor(args: readonly string[], exitCode: number | null, stderr: string) {
    super(`git ${args.join(' ')} failed (exit ${exitCode ?? 'unknown'}): ${stderr.trim()}`);
    this.name = 'GitCommandError';
    this.exitCode = exitCode;
  }
}

export class InvalidCommitShaError extends Error {
  constructor(value: string) {
    super(`"${value}" is not a full commit SHA; refs such as branch names or HEAD are not accepted`);
    this.name = 'InvalidCommitShaError';
  }
}

export class CommitNotFoundError extends Error {
  constructor(sha: string) {
    super(`Commit ${sha} does not exist in the repository or is not a commit object`);
    this.name = 'CommitNotFoundError';
  }
}

export class NotAGitRepositoryError extends Error {
  constructor(path: string) {
    super(`${path} is not a Git repository`);
    this.name = 'NotAGitRepositoryError';
  }
}

export interface CommitInfo {
  sha: string;
  treeSha: string;
  /** Committer timestamp, ISO 8601 in UTC. */
  committedAt: string;
}

export interface TreeEntry {
  /** Octal Git file mode, e.g. "100644", "100755", "120000" (symlink), "160000" (submodule). */
  mode: string;
  type: 'blob' | 'commit';
  objectSha: string;
  /** Blob size in bytes; null for submodule entries. */
  size: number | null;
  /** Repository-relative path with "/" separators, exactly as recorded in the tree. */
  path: string;
}

function runGit(repoPath: string, args: readonly string[]): Promise<Buffer> {
  const fullArgs = ['-C', repoPath, ...args];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      fullArgs,
      { encoding: 'buffer', env: GIT_ENV, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = typeof error.code === 'number' ? error.code : null;
          reject(new GitCommandError(fullArgs, exitCode, stderr.toString('utf8') || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/**
 * Validates a full, hexadecimal commit id and returns it in lowercase. Symbolic refs,
 * abbreviated ids and anything that could be parsed as a Git option are rejected, so a
 * snapshot can never silently resolve to whatever a branch or HEAD points at today.
 */
export function parseCommitSha(value: string): string {
  const sha = value.toLowerCase();
  if (!OBJECT_ID.test(sha)) throw new InvalidCommitShaError(value);
  return sha;
}

export async function verifyGitRepository(repoPath: string): Promise<void> {
  try {
    await runGit(repoPath, ['rev-parse', '--git-dir']);
  } catch (error) {
    if (error instanceof GitCommandError) throw new NotAGitRepositoryError(repoPath);
    throw error;
  }
}

/** Reads the commit object `sha`, failing unless `sha` itself is a commit (tags are not peeled). */
export async function readCommit(repoPath: string, sha: string): Promise<CommitInfo> {
  let resolved: string;
  try {
    resolved = (await runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])).toString('utf8').trim();
  } catch (error) {
    // --quiet --verify exits 1 for an unknown object; anything else is a real failure.
    if (error instanceof GitCommandError && error.exitCode === 1) throw new CommitNotFoundError(sha);
    throw error;
  }
  if (resolved !== sha) throw new CommitNotFoundError(sha);

  const body = (await runGit(repoPath, ['cat-file', 'commit', sha])).toString('utf8');
  return { sha, ...parseCommitHeaders(sha, body) };
}

function parseCommitHeaders(sha: string, body: string): Omit<CommitInfo, 'sha'> {
  const headerEnd = body.indexOf('\n\n');
  const headers = (headerEnd === -1 ? body : body.slice(0, headerEnd)).split('\n');
  const treeSha = headers.find((line) => line.startsWith('tree '))?.slice('tree '.length);
  const committer = headers.find((line) => line.startsWith('committer '));
  const seconds = committer?.match(/ (\d+) [+-]\d{4}$/)?.[1];
  if (!treeSha || !OBJECT_ID.test(treeSha) || !seconds) {
    throw new Error(`Commit ${sha} has malformed tree or committer headers`);
  }
  return { treeSha, committedAt: new Date(Number(seconds) * 1000).toISOString() };
}

/** Lists every non-tree entry reachable from the commit's root tree, recursively. */
export async function listTree(repoPath: string, commitSha: string): Promise<TreeEntry[]> {
  const output = await runGit(repoPath, ['ls-tree', '-r', '-l', '-z', '--full-tree', commitSha]);
  const entries: TreeEntry[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    const record = output.subarray(start, end === -1 ? output.length : end);
    entries.push(parseTreeRecord(commitSha, record));
    start = end === -1 ? output.length : end + 1;
  }
  return entries;
}

// Record format: "<mode> SP <type> SP <object> SP+ <size> TAB <path>", with -z leaving the path unquoted.
function parseTreeRecord(commitSha: string, record: Buffer): TreeEntry {
  const tab = record.indexOf(0x09);
  const [mode, type, objectSha, size] = tab === -1 ? [] : record.subarray(0, tab).toString('ascii').split(/ +/);
  if (!mode || !objectSha || !OBJECT_ID.test(objectSha) || (type !== 'blob' && type !== 'commit')) {
    throw new Error(`Unexpected ls-tree record in commit ${commitSha}: ${record.toString('utf8')}`);
  }
  let path: string;
  try {
    path = strictUtf8.decode(record.subarray(tab + 1));
  } catch {
    // Exclusion would need a lossy name that could collide; failing loudly is the honest option.
    throw new Error(`Commit ${commitSha} contains a path that is not valid UTF-8: ${record.subarray(tab + 1).toString('hex')}`);
  }
  if (type === 'commit') return { mode, type, objectSha, size: null, path };
  // ls-tree reports "BAD" instead of a size when the blob cannot be read from the object store.
  if (!size || !/^\d+$/.test(size)) throw new Error(`Blob ${objectSha} for ${path} is missing or unreadable`);
  return { mode, type, objectSha, size: Number(size), path };
}

/**
 * Streams blob contents through one long-lived `git cat-file --batch` process.
 * Reads must be awaited one at a time; call close() when finished.
 */
export class BlobReader {
  private readonly process: ChildProcessWithoutNullStreams;
  private buffered: Buffer = Buffer.alloc(0);
  private stderr = '';
  private failure: Error | undefined;
  private wake: (() => void) | undefined;

  constructor(repoPath: string) {
    this.process = spawn('git', ['-C', repoPath, 'cat-file', '--batch'], { env: GIT_ENV, windowsHide: true });
    this.process.stdout.on('data', (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      this.notify();
    });
    this.process.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
    this.process.stdin.on('error', (error) => this.fail(error));
    this.process.on('error', (error) => this.fail(error));
    this.process.on('close', (code) => {
      this.fail(new GitCommandError(['cat-file', '--batch'], code, this.stderr || 'process exited'));
    });
  }

  async read(objectSha: string): Promise<Buffer> {
    if (!OBJECT_ID.test(objectSha)) throw new Error(`Invalid object id: ${objectSha}`);
    this.process.stdin.write(`${objectSha}\n`);

    const header = (await this.take(await this.lineLength())).toString('utf8');
    await this.take(1);
    const [sha, type, size] = header.split(' ');
    if (sha !== objectSha || type !== 'blob' || !size || !/^\d+$/.test(size)) {
      throw new Error(`Cannot read blob ${objectSha}: git returned "${header}"`);
    }
    const content = await this.take(Number(size));
    await this.take(1); // trailing LF after the object content
    return content;
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.process.once('close', () => resolve()));
    this.process.stdin.end();
    await exited;
  }

  private async lineLength(): Promise<number> {
    for (;;) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline !== -1) return newline;
      await this.waitForData();
    }
  }

  private async take(length: number): Promise<Buffer> {
    while (this.buffered.length < length) await this.waitForData();
    const taken = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return taken;
  }

  private waitForData(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
