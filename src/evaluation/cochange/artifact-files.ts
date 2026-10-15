import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../m9/canonical.js';
import { LockLostError, verifyWorkLock, type WorkLock } from './lock.js';

// Writing files without ever replacing an existing one, under a held work-directory lock. Shared by the
// publication of the results (publish.ts) and the publication of the freeze identity (prepare.ts); it is
// a separate module because publish.ts depends on the evaluation and preparation phases.

export interface PublishedArtifact {
  name: string;
  sha256: string;
  bytes: number;
  /** 'written' by this call, or 'unchanged': it already existed with identical bytes. */
  action: 'written' | 'unchanged';
}

/**
 * Writes `files` into `directory` without ever replacing an existing file (see the module comment).
 * The lock is verified before any file is touched and after each one.
 */
export function writeArtifacts(
  directory: string,
  files: readonly { name: string; bytes: Buffer }[],
  lock: WorkLock,
  beforeLink?: (name: string) => void,
): { status: 'written'; artifacts: PublishedArtifact[] } | { status: 'refused'; reason: 'artifact-conflict' | 'lock-lost' | 'write-failed'; detail: string } {
  const lost = (error: unknown) => (error instanceof LockLostError ? ({ status: 'refused', reason: 'lock-lost', detail: error.message } as const) : null);
  try {
    verifyWorkLock(lock);
  } catch (error) {
    const refusal = lost(error);
    if (refusal) return refusal;
    throw error;
  }

  // Examine everything first: a conflicting artifact stops the publication before anything is written.
  const existing = new Map<string, boolean>();
  for (const file of files) {
    const path = join(directory, file.name);
    if (!existsSync(path)) {
      existing.set(file.name, false);
      continue;
    }
    if (!statSync(path).isFile() || sha256Hex(readFileSync(path)) !== sha256Hex(file.bytes)) {
      return { status: 'refused', reason: 'artifact-conflict', detail: `${file.name} already exists with different content; it is never overwritten` };
    }
    existing.set(file.name, true);
  }

  const artifacts: PublishedArtifact[] = [];
  for (const file of files) {
    const base = { name: file.name, sha256: sha256Hex(file.bytes), bytes: file.bytes.length };
    if (existing.get(file.name)) {
      artifacts.push({ ...base, action: 'unchanged' });
      continue;
    }
    const temporary = join(directory, `.${file.name}.${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx');
      try {
        let written = 0;
        while (written < file.bytes.length) written += writeSync(fd, file.bytes, written, file.bytes.length - written, written);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      beforeLink?.(file.name);
      try {
        verifyWorkLock(lock);
      } catch (error) {
        const refusal = lost(error);
        if (refusal) return refusal;
        throw error;
      }
      try {
        linkSync(temporary, join(directory, file.name));
      } catch (error) {
        // Someone else created the name since it was examined: accept identical bytes, never replace.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          if (sha256Hex(readFileSync(join(directory, file.name))) === base.sha256) {
            artifacts.push({ ...base, action: 'unchanged' });
            continue;
          }
          return { status: 'refused', reason: 'artifact-conflict', detail: `${file.name} appeared with different content while it was being written` };
        }
        return { status: 'refused', reason: 'write-failed', detail: `${file.name} could not be created: ${(error as NodeJS.ErrnoException).code ?? 'error'}` };
      }
      artifacts.push({ ...base, action: 'written' });
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary file may never have been created.
      }
    }
  }

  for (const artifact of artifacts) {
    const bytes = readFileSync(join(directory, artifact.name));
    if (sha256Hex(bytes) !== artifact.sha256) return { status: 'refused', reason: 'write-failed', detail: `${artifact.name} does not hold the bytes that were written` };
  }
  try {
    verifyWorkLock(lock);
  } catch (error) {
    const refusal = lost(error);
    if (refusal) return refusal;
    throw error;
  }
  return { status: 'written', artifacts };
}
