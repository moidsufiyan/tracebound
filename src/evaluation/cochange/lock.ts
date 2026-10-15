import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

// An exclusive lock on a co-change work directory, shared by every process that runs a phase.
//
// Mechanism: the lock is the file `<work directory>/run.lock`, created with O_CREAT | O_EXCL
// (`openSync(path, 'wx')`). Creating a file exclusively is atomic on local filesystems (NTFS,
// ext4, APFS and the like), so of several processes racing for the lock exactly one creates it.
// That guarantee does not hold on every network filesystem; the work directory must be local.
//
// The file names its owner: a random token, the process id, the host, the purpose and the time it
// was taken. A process only ever removes a lock whose token is its own, and checks that it still
// holds the lock before each consequential step.
//
// A lock is never removed or taken over automatically, however old or malformed: acquisition
// refuses and reports the owner (and, on the same host, whether that process still runs). Stale
// lock procedure for an operator: make sure the named process is not running (on any host that
// shares the directory), inspect the journals with the preflight, then delete `run.lock` by hand.
//
// The metadata is machine-local (process id, host name) and belongs only in the work directory,
// never in tracked results. This module imports only Node built-ins.

export const LOCK_FILE = 'run.lock';
const LOCK_SCHEMA = 'tracebound.cochange.lock';

export interface LockOwner {
  schema: typeof LOCK_SCHEMA;
  version: 1;
  token: string;
  purpose: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

export interface WorkLock {
  path: string;
  owner: LockOwner;
}

export type LockAcquisition =
  | { status: 'acquired'; lock: WorkLock }
  /** Another invocation holds the lock (or did, and left it behind). Nothing was changed. */
  | { status: 'held'; path: string; owner: LockOwner; ownerProcess: 'running' | 'not-running' | 'unknown' }
  /** A lock file exists but is not a lock this module wrote, or is partly written. Nothing was changed. */
  | { status: 'malformed'; path: string; detail: string };

/** The lock this invocation took is gone or now belongs to someone else. */
export class LockLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockLostError';
  }
}

/** Takes the lock of `directory`, which must exist, or reports who holds it. Never waits, retries or steals. */
export function acquireWorkLock(directory: string, purpose: string): LockAcquisition {
  const path = join(directory, LOCK_FILE);
  const owner: LockOwner = {
    schema: LOCK_SCHEMA,
    version: 1,
    token: randomUUID(),
    purpose,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
  };
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return describeExisting(path);
    throw error;
  }
  try {
    const bytes = Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8');
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, written);
    fsyncSync(fd);
  } catch (error) {
    // The file is ours (we created it); leave nothing half-written behind.
    closeSync(fd);
    unlinkSync(path);
    throw error;
  }
  closeSync(fd);
  return { status: 'acquired', lock: { path, owner } };
}

/** Throws LockLostError unless the lock file still holds exactly this invocation's owner record. */
export function verifyWorkLock(lock: WorkLock): void {
  let current: LockOwner | null;
  try {
    current = parseOwner(readFileSync(lock.path, 'utf8'));
  } catch (error) {
    throw new LockLostError(`${lock.path} cannot be read: ${(error as Error).message}`);
  }
  if (current === null || JSON.stringify(current) !== JSON.stringify(lock.owner)) {
    throw new LockLostError(`${lock.path} no longer belongs to this invocation`);
  }
}

/** Removes the lock after verifying it is still this invocation's; otherwise throws and removes nothing. */
export function releaseWorkLock(lock: WorkLock): void {
  verifyWorkLock(lock);
  unlinkSync(lock.path);
}

function describeExisting(path: string): LockAcquisition {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { status: 'malformed', path, detail: `The lock file cannot be read: ${(error as Error).message}` };
  }
  const owner = parseOwner(text);
  if (owner === null) return { status: 'malformed', path, detail: 'The lock file is not a complete lock record (it may be partly written or not ours)' };
  return { status: 'held', path, owner, ownerProcess: processState(owner) };
}

function parseOwner(text: string): LockOwner | null {
  if (!text.endsWith('\n')) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'hostname,pid,purpose,schema,startedAt,token,version') return null;
  if (v['schema'] !== LOCK_SCHEMA || v['version'] !== 1) return null;
  if (typeof v['token'] !== 'string' || typeof v['purpose'] !== 'string' || typeof v['hostname'] !== 'string' || typeof v['startedAt'] !== 'string') return null;
  if (!Number.isSafeInteger(v['pid'])) return null;
  return v as unknown as LockOwner;
}

/** Whether the owner process still runs, as far as this host can tell. For diagnosis only. */
function processState(owner: LockOwner): 'running' | 'not-running' | 'unknown' {
  if (owner.hostname !== hostname()) return 'unknown';
  try {
    process.kill(owner.pid, 0);
    return 'running';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'running' : 'not-running';
  }
}
