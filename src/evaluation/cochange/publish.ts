import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeArtifacts, type PublishedArtifact } from './artifact-files.js';
import { assembleResultsHeld, type AssemblyDependencies, type AssemblyRefusal, type AssemblyRequest } from './assemble.js';
import { acquireWorkLock, LockLostError, releaseWorkLock, type LockAcquisition } from './lock.js';
import { canonicalPath, isWithin, REGISTERED } from './preflight.js';
import { renderReport, REPORT_FILE, RESULTS_FILE, validateResults, ResultsValidationError } from './report.js';

// Publication of the co-change results: assembles them under the work-directory lock (S5), validates
// them, and writes `results.json` (the canonical JSON, byte for byte, so its SHA-256 is the file's)
// and `report.md` (rendered from the results only) into an output directory.
//
// The whole of it is one critical section: the lock is taken once, here, and the assembly runs
// under that same lock (assembleResultsHeld), so nothing can append to a journal between reading
// it and writing the artifacts, and no lock is taken twice.
//
// Writing never overwrites. Each file is written to a temporary name in the output directory
// (created exclusively, fsynced), then given its final name with a hard link, which fails if the
// name exists; the temporary name is always removed. A file that already exists is accepted only
// if its bytes are identical (SHA-256 compared), otherwise nothing is written and the publication
// is refused. Both targets are examined before the first is written, and a rerun after a crash
// between the two writes finds the first identical and writes the second. A filesystem without
// hard links makes the write fail, and it is reported rather than worked around.

export type PublishRefusal =
  | AssemblyRefusal
  | 'output-directory-invalid'
  | 'results-invalid'
  | 'artifact-conflict'
  | 'lock-lost'
  | 'write-failed';

export interface PublishRequest extends AssemblyRequest {
  /** An existing directory (for example docs/evaluation/cochange); it is not created. */
  outputDirectory: string;
  /** The dataset clone the run used; it is never read here, only kept free of results. */
  repositoryPath: string;
}

export interface PublishDependencies extends AssemblyDependencies {
  /** Called with the final name after its temporary file is written and before it is linked; a throw simulates a crash. For tests. */
  beforeLink?: (name: string) => void;
}


export type PublishResult =
  | { status: 'published'; resultsSha256: string; outcome: string; resultsStatus: 'complete' | 'primary-incomplete'; artifacts: PublishedArtifact[] }
  | { status: 'locked'; lock: Exclude<LockAcquisition, { status: 'acquired' }> }
  | { status: 'refused'; reason: PublishRefusal; detail: string };

/** Assembles, validates and publishes the results of the evaluation in the work directory. */
export async function publishResults(request: PublishRequest, dependencies: PublishDependencies = {}): Promise<PublishResult> {
  const work = canonicalPath(request.workDirectory);
  if (!existsSync(work)) return { status: 'refused', reason: 'work-directory-missing', detail: `${work} does not exist` };
  const output = canonicalPath(request.outputDirectory);
  if (!existsSync(output) || !statSync(output).isDirectory()) return { status: 'refused', reason: 'output-directory-invalid', detail: 'The output directory does not exist or is not a directory' };
  if (isWithin(output, work) || isWithin(work, output)) return { status: 'refused', reason: 'output-directory-invalid', detail: 'The output directory and the work directory must not contain one another' };
  if (isWithin(output, canonicalPath(request.repositoryPath))) return { status: 'refused', reason: 'output-directory-invalid', detail: 'The output directory is inside the dataset repository' };

  const acquisition = acquireWorkLock(work, 'cochange results publication');
  if (acquisition.status !== 'acquired') return { status: 'locked', lock: acquisition };
  const lock = acquisition.lock;
  try {
    const registration = dependencies.registration ?? REGISTERED;
    const assembled = await assembleResultsHeld(lock, request, dependencies);
    if (assembled.status === 'refused') return assembled;
    try {
      validateResults(assembled, { manifestSha256: registration.manifestSha256, repository: { name: registration.repositoryName, head: registration.head } });
    } catch (error) {
      if (error instanceof ResultsValidationError) return { status: 'refused', reason: 'results-invalid', detail: error.message };
      throw error;
    }
    const files = [
      { name: RESULTS_FILE, bytes: Buffer.from(assembled.canonical, 'utf8') },
      { name: REPORT_FILE, bytes: Buffer.from(renderReport(assembled.results, assembled.sha256), 'utf8') },
    ];
    const written = writeArtifacts(output, files, lock, dependencies.beforeLink);
    if (written.status === 'refused') return written;
    return { status: 'published', resultsSha256: assembled.sha256, outcome: assembled.results.decision.outcome, resultsStatus: assembled.results.status, artifacts: written.artifacts };
  } finally {
    try {
      releaseWorkLock(lock);
    } catch (error) {
      if (!(error instanceof LockLostError)) throw error;
    }
  }
}

// Kept here for the callers and tests that import it from the publication module.
export { writeArtifacts, type PublishedArtifact };
