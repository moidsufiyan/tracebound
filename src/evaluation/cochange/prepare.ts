import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { indexSnapshotStructurally, isSnapshotStructurallyIndexed } from '../../analysis/structural-index.js';
import { listSnapshotArtifacts } from '../../artifacts/artifacts.js';
import { openDatabase, type Database } from '../../db/database.js';
import { ingestSnapshot, listExcludedEntries } from '../../ingestion/ingest-snapshot.js';
import { createProject, registerRepository } from '../../projects/projects.js';
import { indexSnapshotLexically, isSnapshotLexicallyIndexed } from '../../retrieval/lexical-index.js';
import { EmbeddingProviderUnavailableError, type EmbeddingProvider } from '../../semantic/provider.js';
import { indexSnapshotSemantically, isSnapshotSemanticallyIndexed } from '../../semantic/semantic-index.js';
import { findSnapshot } from '../../snapshots/snapshots.js';
import { canonicalJson, sha256Hex } from '../m9/canonical.js';
import { checkDatabase, fileIdentity, freezeDatabase, tableDigests } from '../m9/freeze-database.js';
import {
  createJournal,
  inspectJournal,
  recoverJournal,
  type CochangeJournal,
  type ExpectedJournal,
  type PreparationFailure,
  type PreparationRecord,
} from './journal.js';
import { bindingsOf, buildFreezeIdentity, FREEZE_IDENTITY_FILE, publishFreezeIdentity, verifyFreezeIdentity, type FreezeIdentity } from './freeze-identity.js';
import { acquireWorkLock, LockLostError, releaseWorkLock, verifyWorkLock, type LockAcquisition, type WorkLock } from './lock.js';
import { canonicalPath, isWithin, runPreflight, WORK_FILES, type PreflightDependencies, type PreflightIdentity, type PreflightResult } from './preflight.js';

// The preparation phase of the co-change evaluation (protocol 1.0.0, section 4): one ingested and
// fully indexed base snapshot per distinct base commit, in manifest order, in a working database,
// then a frozen copy of that database for the evaluation phase.
//
// Order of a run, all under the work-directory lock (lock.ts), taken before anything else is read:
// preflight; recovery of a torn journal tail (journal.ts), never anything else; the embedding
// model check; opening and checking the working database against every recorded success; then,
// per unrecorded base: ingestion, lexical, structural and semantic indexing with the production
// functions, each verified with the production `is...Indexed` queries, and one durable terminal
// record. Then the working database is checked again and frozen with `freezeDatabase`.
//
// A recorded base, succeeded or failed, is never prepared again. A stage error is a recorded
// failure of that base when the database is still intact afterwards; otherwise the run stops
// without a record. Nothing recorded is ever rebuilt: a recorded success whose snapshot or index
// is missing stops the run.
//
// Freezing and its identity: once every base has a record, the working database is frozen with
// `freezeDatabase`, the copy is verified, and only then the freeze identity (freeze-identity.ts) is
// published next to it, binding the frozen file and the complete preparation journal to the run. A
// crash between the two leaves `frozen.sqlite` without `frozen.identity.json`; the next run refuses
// it (`frozen-database-without-identity`) and adopts nothing. Recovery is by hand: inspect the
// refusal (it says whether the frozen file's rows equal the working database's), remove
// `frozen.sqlite`, and run the preparation again.
//
// Embedding-provider outage (causedByProviderOutage): the base being indexed gets its failure
// recorded like any other, and then the run stops, leaving the later bases unrecorded for a later
// run and freezing nothing, so one outage does not become a failure of every remaining base.

export const PREPARATION_PROJECT = 'tracebound-cochange-evaluation';

/** The production pipeline, one function per recorded stage; tests replace stages to inject failures. */
export interface PreparationStages {
  ingest: typeof ingestSnapshot;
  indexLexically: typeof indexSnapshotLexically;
  indexStructurally: typeof indexSnapshotStructurally;
  indexSemantically: typeof indexSnapshotSemantically;
}

const PRODUCTION_STAGES: PreparationStages = {
  ingest: ingestSnapshot,
  indexLexically: indexSnapshotLexically,
  indexStructurally: indexSnapshotStructurally,
  indexSemantically: indexSnapshotSemantically,
};

export interface PreparationRequest {
  traceboundRoot: string;
  repositoryPath: string;
  workDirectory: string;
  manifestPath?: string;
  /** The embedding identity the run is registered with (`ollama:nomic-embed-text:v1.5@<digest>`). */
  embeddingModelId: string;
  /** The provider to embed with; its `modelId` must be exactly `embeddingModelId`. */
  provider: EmbeddingProvider;
}

export interface PreparationDependencies extends PreflightDependencies {
  stages?: Partial<PreparationStages>;
  /** Called after a record is built and before it is appended; a throw here simulates a crash. For tests. */
  beforeAppend?: (record: PreparationRecord) => void;
  /** Called after the database is frozen and before its identity is published; a throw simulates a crash. For tests. */
  beforeIdentity?: () => void;
  /** Called with the identity file's final name after its temporary file is written; a throw simulates a crash. For tests. */
  beforeIdentityLink?: (name: string) => void;
}

export interface FrozenDatabaseIdentity {
  /** File name in the work directory. */
  file: string;
  sha256: string;
  bytes: number;
  userVersion: number;
  journalMode: string;
  integrityCheck: string;
  tables: number;
  /** The freeze identity published next to it (freeze-identity.ts): its file name and SHA-256. */
  identityFile: string;
  identitySha256: string;
}

export type PreparationRefusal =
  | 'work-directory-unsafe'
  | 'preflight'
  | 'model-mismatch'
  | 'journal-unrecoverable'
  | 'database-missing'
  | 'database-invalid'
  | 'database-inconsistent'
  | 'repository-mismatch'
  | 'frozen-database-exists'
  | 'frozen-database-without-identity';

export type PreparationResult =
  | { status: 'prepared'; bases: number; succeeded: number; failed: number; recordedThisRun: number; recoveredTornTail: boolean; frozen: FrozenDatabaseIdentity }
  /** The lock is held by another invocation, or a lock file is malformed. Nothing was read or changed. */
  | { status: 'locked'; lock: Exclude<LockAcquisition, { status: 'acquired' }> }
  /** Preparation did not start (or did not continue): nothing was indexed or recorded by this call after the refusal. */
  | { status: 'refused'; reason: PreparationRefusal; detail: string; preflight?: PreflightResult; frozenInspection?: FrozenInspection }
  /**
   * The run stopped before every base had a record, and nothing was frozen. For 'provider-unavailable' the base
   * that met the outage has its failure recorded and the remaining bases are unrecorded, to be prepared by a later
   * run; for 'database-invalid' and 'lock-lost' no record was written for the base in progress.
   */
  | { status: 'stopped'; reason: StopReason; detail: string; recordedThisRun: number };

export type StopReason = 'database-invalid' | 'lock-lost' | 'provider-unavailable' | 'freeze-identity-not-published';

/** What an existing frozen database looks like; reported, never adopted or replaced. */
export interface FrozenInspection {
  sha256: string;
  bytes: number;
  integrityCheck: string | null;
  journalMode: string | null;
  sameRowsAsWorkingDatabase: boolean | null;
  error: string | null;
}

class Refusal extends Error {
  readonly reason: PreparationRefusal;
  readonly extra: { preflight?: PreflightResult; frozenInspection?: FrozenInspection };
  constructor(reason: PreparationRefusal, detail: string, extra: { preflight?: PreflightResult; frozenInspection?: FrozenInspection } = {}) {
    super(detail);
    this.reason = reason;
    this.extra = extra;
  }
}

class Stopped extends Error {
  readonly reason: StopReason;
  constructor(reason: StopReason, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

/** Prepares (or resumes preparing) the registered base snapshots and freezes the database. */
export async function runPreparation(request: PreparationRequest, dependencies: PreparationDependencies = {}): Promise<PreparationResult> {
  // The work directory is created before the lock can be taken, so its location is checked first.
  const work = canonicalPath(request.workDirectory);
  for (const other of [request.traceboundRoot, request.repositoryPath]) {
    if (isWithin(work, canonicalPath(other))) {
      return { status: 'refused', reason: 'work-directory-unsafe', detail: `The work directory ${work} is inside ${canonicalPath(other)}` };
    }
  }
  mkdirSync(work, { recursive: true });

  const acquisition = acquireWorkLock(work, 'cochange preparation');
  if (acquisition.status !== 'acquired') return { status: 'locked', lock: acquisition };
  const lock = acquisition.lock;
  let db: Database | null = null;
  let recordedThisRun = 0;
  try {
    const state = await openPreparation(request, dependencies, work, lock);
    db = state.db;
    const stages = { ...PRODUCTION_STAGES, ...dependencies.stages };
    for (let base = state.journal.next; base !== null; base = state.journal.next) {
      verifyLock(lock);
      const { record, providerUnavailable } = await prepareBase(db, state.repositoryId, base, request.provider, stages);
      dependencies.beforeAppend?.(record);
      verifyLock(lock);
      state.journal.append(record);
      recordedThisRun += 1;
      if (providerUnavailable) {
        // The outage is this base's recorded failure; the bases after it are not attempted now, so they are
        // not turned into failures by the same outage. They stay unrecorded and a later run prepares them.
        throw new Stopped(
          'provider-unavailable',
          `The embedding provider became unavailable while preparing ${base}; its failure is recorded, ${state.journal.remaining.length} bases are left unrecorded and nothing is frozen. Run again once the provider is back.`,
        );
      }
    }

    verifyRecordedSuccesses(db, state.repositoryId, state.journal, request.provider);
    checkIntegrity(db, 'before freezing');
    db.close();
    db = null;
    verifyLock(lock);
    const frozen = await freeze(work);
    verifyLock(lock);
    dependencies.beforeIdentity?.();
    const records = state.journal.records;
    const identity = buildFreezeIdentity({
      protocolVersion: state.identity.protocolVersion,
      manifestSha256: state.identity.manifestSha256,
      repository: state.identity.repository,
      tracebound: { commit: state.identity.tracebound.commit, sourceClean: state.identity.tracebound.sourceClean, buildSha256: state.identity.tracebound.buildSha256 },
      nodeVersion: state.identity.nodeVersion,
      embeddingModelId: request.embeddingModelId,
      preparation: {
        journalSha256: sha256Hex(readFileSync(join(work, WORK_FILES.preparationJournal))),
        bases: records.length,
        succeeded: records.filter((r) => r.status === 'succeeded').length,
        failed: records.filter((r) => r.status === 'failed').length,
      },
      database: frozen.facts,
    });
    const published = publishFreezeIdentity(work, identity, lock, dependencies.beforeIdentityLink);
    if (published.status === 'refused') {
      throw new Stopped(
        published.reason === 'lock-lost' ? 'lock-lost' : 'freeze-identity-not-published',
        `${WORK_FILES.frozenDatabase} was created but its identity was not published (${published.reason}); it is not trusted. Inspect it, remove it by hand and run the preparation again`,
      );
    }
    // The published file must verify against the files it describes before the preparation reports success.
    const verified = await verifyFreezeIdentity(
      { identity: join(work, FREEZE_IDENTITY_FILE), database: join(work, WORK_FILES.frozenDatabase), preparationJournal: join(work, WORK_FILES.preparationJournal) },
      bindingsOf(identity),
      { deep: false },
    );
    if (verified.status !== 'verified') throw new Stopped('freeze-identity-not-published', `The published freeze identity does not verify (${verified.status === 'refused' ? verified.reason : 'absent'}); it is not trusted`);
    verifyLock(lock);
    return {
      status: 'prepared',
      bases: records.length,
      succeeded: records.filter((r) => r.status === 'succeeded').length,
      failed: records.filter((r) => r.status === 'failed').length,
      recordedThisRun,
      recoveredTornTail: state.recovered,
      frozen: { ...frozen.identity, identityFile: FREEZE_IDENTITY_FILE, identitySha256: published.artifacts[0]!.sha256 },
    };
  } catch (error) {
    if (error instanceof Refusal) return { status: 'refused', reason: error.reason, detail: error.message, ...error.extra };
    if (error instanceof Stopped) return { status: 'stopped', reason: error.reason, detail: error.message, recordedThisRun };
    throw error;
  } finally {
    db?.close();
    try {
      releaseWorkLock(lock);
    } catch (error) {
      // A lock that is no longer ours is left alone; the run has already reported or will report it.
      if (!(error instanceof LockLostError)) throw error;
    }
  }
}

interface OpenPreparation {
  /** The identity preflight established for this run (and the journal header was made from). */
  identity: PreflightIdentity;
  journal: CochangeJournal;
  db: Database;
  repositoryId: number;
  recovered: boolean;
}

async function openPreparation(request: PreparationRequest, dependencies: PreparationDependencies, work: string, lock: WorkLock): Promise<OpenPreparation> {
  // The provider must be the registered model before any database is opened or created.
  if (request.provider.modelId !== request.embeddingModelId) {
    throw new Refusal('model-mismatch', `The embedding provider is ${request.provider.modelId}, not the registered ${request.embeddingModelId}`);
  }

  const preflight = await runPreflight(
    {
      phase: 'preparation',
      traceboundRoot: request.traceboundRoot,
      repositoryPath: request.repositoryPath,
      workDirectory: work,
      embeddingModelId: request.embeddingModelId,
      ...(request.manifestPath === undefined ? {} : { manifestPath: request.manifestPath }),
    },
    dependencies,
  );
  const frozenOnly = preflight.status === 'refused' && preflight.problems.length === 1 && preflight.problems[0]!.code === 'frozen-database-exists';
  if (frozenOnly && !existsSync(join(work, FREEZE_IDENTITY_FILE))) {
    // Frozen, but never published: a crash after freezing, or a file placed by someone else. Not adopted, not replaced.
    throw new Refusal(
      'frozen-database-without-identity',
      `${WORK_FILES.frozenDatabase} exists without ${FREEZE_IDENTITY_FILE}: it was not published by a finished preparation and is not trusted. Inspect it (the report says whether its rows equal the working database's), remove it by hand and run the preparation again`,
      { preflight, frozenInspection: await inspectFrozen(work) },
    );
  }
  if (frozenOnly) {
    // An earlier run may have stopped while freezing. Report what is there; never adopt or replace it.
    throw new Refusal('frozen-database-exists', `${WORK_FILES.frozenDatabase} already exists; it is reported, not reused or replaced`, {
      preflight,
      frozenInspection: await inspectFrozen(work),
    });
  }
  if (preflight.status !== 'ready' && preflight.status !== 'interrupted') {
    throw new Refusal('preflight', `Preflight is ${preflight.status}: ${preflight.problems.map((p) => p.code).join(', ')}`, { preflight });
  }
  if (preflight.header === null) throw new Refusal('preflight', 'Preflight gave no journal header');
  const expected: ExpectedJournal = { header: preflight.header, keys: preflight.keys };
  const journalPath = join(work, WORK_FILES.preparationJournal);
  const databasePath = join(work, WORK_FILES.workingDatabase);

  verifyLock(lock);
  let journal: CochangeJournal;
  let recovered = false;
  if (!existsSync(journalPath)) {
    if (existsSync(databasePath)) throw new Refusal('database-inconsistent', `${WORK_FILES.workingDatabase} exists without a journal`);
    journal = createJournal(journalPath, expected);
  } else {
    let inspection = inspectJournal(journalPath, expected);
    if (inspection.status === 'interrupted') {
      const recovery = recoverJournal(expected, inspection);
      if (recovery.status !== 'recovered') throw new Refusal('journal-unrecoverable', `${recovery.reason}: ${recovery.detail}`);
      recovered = true;
      inspection = inspectJournal(journalPath, expected);
    }
    if (inspection.status !== 'valid') {
      throw new Refusal('journal-unrecoverable', inspection.status === 'invalid' ? `${inspection.reason}: ${inspection.detail}` : 'The journal is still interrupted after recovery');
    }
    journal = inspection.journal;
  }

  const recordedSuccesses = journal.records.filter((r) => r.status === 'succeeded').length;
  if (journal.records.length > 0 && !existsSync(databasePath)) {
    throw new Refusal('database-missing', `${journal.records.length} bases are recorded but ${WORK_FILES.workingDatabase} is missing; it is never rebuilt`);
  }
  let db: Database;
  try {
    db = openDatabase(databasePath);
  } catch (error) {
    throw new Refusal('database-invalid', `${WORK_FILES.workingDatabase} cannot be opened: ${messageOf(error)}`);
  }
  try {
    // Every commit of the working database must reach disk before the journal says it happened.
    db.exec('PRAGMA synchronous = FULL');
    checkIntegrity(db, 'on opening');
    const repositoryId = await repositoryOf(db, request.repositoryPath, preflight.identity.repository.name, recordedSuccesses);
    checkSnapshotsBelongToJournal(db, repositoryId, journal);
    verifyRecordedSuccesses(db, repositoryId, journal, request.provider);
    return { identity: preflight.identity, journal, db, repositoryId, recovered };
  } catch (error) {
    db.close();
    if (error instanceof Stopped) throw new Refusal('database-invalid', error.message);
    throw error;
  }
}

/** The one registered repository of the working database, created on first use. */
async function repositoryOf(db: Database, repositoryPath: string, name: string, recordedSuccesses: number): Promise<number> {
  const rows = db.prepare('SELECT id, name, source_path FROM repository').all() as { id: number; name: string; source_path: string }[];
  if (rows.length === 0) {
    if (recordedSuccesses > 0) throw new Refusal('database-inconsistent', 'Recorded successes exist, but the working database has no repository');
    const project = createProject(db, PREPARATION_PROJECT);
    return (await registerRepository(db, { projectId: project.id, name, sourcePath: repositoryPath })).id;
  }
  if (rows.length > 1 || rows[0]!.name !== name) throw new Refusal('repository-mismatch', `The working database holds ${rows.map((r) => r.name).join(', ')}, not only ${name}`);
  if (rows[0]!.source_path !== resolve(repositoryPath)) {
    throw new Refusal('repository-mismatch', 'The working database reads a clone at another path; snapshots would come from a different clone');
  }
  return rows[0]!.id;
}

/** Snapshots may exist only for recorded bases and for the next base (an attempt cut short before its record). */
function checkSnapshotsBelongToJournal(db: Database, repositoryId: number, journal: CochangeJournal): void {
  const allowed = new Set([...journal.completed, ...(journal.next === null ? [] : [journal.next])]);
  const rows = db.prepare('SELECT repository_id, commit_sha FROM repository_snapshot').all() as { repository_id: number; commit_sha: string }[];
  const strays = rows.filter((row) => row.repository_id !== repositoryId || !allowed.has(row.commit_sha));
  if (strays.length > 0) throw new Refusal('database-inconsistent', `The working database has snapshots the journal does not account for: ${strays.map((r) => r.commit_sha).join(', ')}`);
}

/** Every recorded success must still be in the database exactly as recorded, with all three indexes. */
export function verifyRecordedSuccesses(db: Database, repositoryId: number, journal: CochangeJournal, provider: EmbeddingProvider): void {
  for (const record of journal.records) {
    if (record.phase !== 'preparation' || record.status !== 'succeeded') continue;
    const evidence = record.evidence as unknown as SuccessEvidence;
    const snapshot = findSnapshot(db, repositoryId, record.base);
    const problem =
      !snapshot || snapshot.status !== 'ready'
        ? 'its snapshot is missing or not ready'
        : snapshot.id !== evidence.snapshotId || snapshot.treeSha !== evidence.treeSha
          ? 'its snapshot differs from the recorded one'
          : listSnapshotArtifacts(db, snapshot.id).length !== evidence.artifactCount
            ? 'its artifact count differs from the recorded one'
            : canonicalJson(listExcludedEntries(db, snapshot.id).map(({ path, reason }) => ({ path, reason }))) !== canonicalJson(evidence.excludedEntries)
              ? 'its excluded entries differ from the recorded ones'
              : !isSnapshotLexicallyIndexed(db, snapshot.id)
                ? 'its lexical index is missing'
                : !isSnapshotStructurallyIndexed(db, snapshot.id)
                  ? 'its structural index is missing'
                  : !isSnapshotSemanticallyIndexed(db, snapshot.id, provider)
                    ? 'its semantic index is missing'
                    : null;
    if (problem !== null) throw new Refusal('database-inconsistent', `Recorded base ${record.base}: ${problem}; recorded work is never rebuilt`);
  }
}

interface SuccessEvidence {
  snapshotId: number;
  treeSha: string;
  artifactCount: number;
  excludedEntries: { path: string; reason: string }[];
  lexical: { contentsIndexed: number; artifactsIndexed: number };
  structural: { indexed: boolean; contentsParsed: number; contentsWithSyntaxErrors: number; relationships: number };
  semantic: { modelId: string; indexed: boolean; artifacts: number; chunks: number; embeddingsReused: number; embeddingsCreated: number };
}

class StageError extends Error {
  readonly stage: PreparationFailure['stage'];
  readonly failure: unknown;
  constructor(stage: PreparationFailure['stage'], failure: unknown) {
    super(messageOf(failure));
    this.stage = stage;
    this.failure = failure;
  }
}

/**
 * Runs the four stages for one base and returns its terminal record, and whether the failure (if any) was an
 * outage of the embedding provider during semantic indexing. Throws Stopped when the database is no longer intact.
 */
async function prepareBase(
  db: Database,
  repositoryId: number,
  base: string,
  provider: EmbeddingProvider,
  stages: PreparationStages,
): Promise<{ record: PreparationRecord; providerUnavailable: boolean }> {
  let snapshotId: number | null = null;
  const evidence: Record<string, unknown> = {};
  const stage = async <T>(name: PreparationFailure['stage'], work: () => T | Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw new StageError(name, error);
    }
  };
  try {
    const ingestion = await stage('ingestion', async () => {
      const { snapshot } = await stages.ingest(db, repositoryId, base);
      if (snapshot.commitSha !== base || snapshot.status !== 'ready') throw new Error(`Ingestion returned snapshot ${snapshot.id} of ${snapshot.commitSha}, not a ready snapshot of ${base}`);
      return {
        snapshotId: snapshot.id,
        treeSha: snapshot.treeSha,
        artifactCount: listSnapshotArtifacts(db, snapshot.id).length,
        // Kept so that targets the file policy excluded can be accounted for later.
        excludedEntries: listExcludedEntries(db, snapshot.id).map(({ path, reason }) => ({ path, reason })),
      };
    });
    snapshotId = ingestion.snapshotId;
    Object.assign(evidence, ingestion);
    evidence['lexical'] = await stage('lexical-index', () => {
      const result = stages.indexLexically(db, snapshotId!);
      if (!isSnapshotLexicallyIndexed(db, snapshotId!)) throw new Error('The lexical index is incomplete after indexing');
      return result;
    });
    evidence['structural'] = await stage('structural-index', () => {
      const result = stages.indexStructurally(db, snapshotId!);
      if (!isSnapshotStructurallyIndexed(db, snapshotId!)) throw new Error('The structural index is not marked complete after indexing');
      return result;
    });
    evidence['semantic'] = await stage('semantic-index', async () => {
      const result = await stages.indexSemantically(db, snapshotId!, provider);
      if (!isSnapshotSemanticallyIndexed(db, snapshotId!, provider)) throw new Error('The semantic index is not marked complete after indexing');
      return { modelId: provider.modelId, ...result };
    });
    return { record: { kind: 'record', phase: 'preparation', base, status: 'succeeded', failures: [], evidence }, providerUnavailable: false };
  } catch (error) {
    if (!(error instanceof StageError)) throw error;
    // A stage failure is recorded only while the database is intact; otherwise nothing is recorded.
    checkIntegrity(db, `after ${error.stage} failed for ${base} (${messageOf(error.failure)})`);
    const cause = error.failure;
    const failure: PreparationFailure = {
      stage: error.stage,
      errorName: cause instanceof Error && cause.name ? cause.name : 'Error',
      message: messageOf(cause),
    };
    const providerUnavailable = error.stage === 'semantic-index' && causedByProviderOutage(cause);
    return {
      record: { kind: 'record', phase: 'preparation', base, status: 'failed', failures: [failure], evidence: { snapshotId, ...evidence, ...(providerUnavailable ? { providerUnavailable: true } : {}) } },
      providerUnavailable,
    };
  }
}

/**
 * Whether an error is, or was caused by, EmbeddingProviderUnavailableError: the provider could not be reached or
 * answered 502, 503 or 504 (ollama-provider.ts). The semantic indexer wraps provider errors in a plain Error with
 * the provider's error as `cause`, so the cause chain is followed; messages are never matched.
 */
export function causedByProviderOutage(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 16; current = current.cause, depth += 1) {
    if (current instanceof EmbeddingProviderUnavailableError) return true;
  }
  return false;
}

/** Throws Stopped unless SQLite's integrity and foreign-key checks pass. */
function checkIntegrity(db: Database, when: string): void {
  let integrity: string;
  let foreignKeyViolations: number;
  try {
    integrity = (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((row) => row.integrity_check).join('; ');
    foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
  } catch (error) {
    throw new Stopped('database-invalid', `The working database cannot be checked ${when}: ${messageOf(error)}`);
  }
  if (integrity !== 'ok' || foreignKeyViolations > 0) {
    throw new Stopped('database-invalid', `The working database failed its integrity check ${when}: ${integrity}; ${foreignKeyViolations} foreign key violations`);
  }
}

function verifyLock(lock: WorkLock): void {
  try {
    verifyWorkLock(lock);
  } catch (error) {
    if (error instanceof LockLostError) throw new Stopped('lock-lost', error.message);
    throw error;
  }
}

/** Freezes the working database into a new frozen.sqlite (never overwriting one) and verifies the copy. */
async function freeze(work: string): Promise<{ identity: Omit<FrozenDatabaseIdentity, 'identityFile' | 'identitySha256'>; facts: FreezeIdentity['database'] }> {
  const source = join(work, WORK_FILES.workingDatabase);
  const destination = join(work, WORK_FILES.frozenDatabase);
  const result = await freezeDatabase(source, destination);
  const sourceTables = tableDigests(source);
  if (canonicalJson(sourceTables) !== canonicalJson(result.tables)) throw new Error('The frozen database does not hold the same rows as the working database');
  const identity = await fileIdentity(destination);
  if (identity.sha256 !== result.frozen.sha256) throw new Error('The frozen database changed after it was made');
  return {
    identity: {
      file: WORK_FILES.frozenDatabase,
      sha256: result.frozen.sha256,
      bytes: result.frozen.bytes,
      userVersion: result.frozen.userVersion,
      journalMode: result.frozen.journalMode,
      integrityCheck: result.frozen.integrityCheck,
      tables: result.tables.length,
    },
    facts: {
      file: WORK_FILES.frozenDatabase,
      sha256: result.frozen.sha256,
      bytes: result.frozen.bytes,
      userVersion: result.frozen.userVersion,
      journalMode: result.frozen.journalMode,
      integrityCheck: result.frozen.integrityCheck,
      pageSize: result.frozen.pageSize,
      pageCount: result.frozen.pageCount,
      tables: result.tables,
    },
  };
}

/** Describes an existing frozen database with read-only checks; nothing is changed or adopted. */
async function inspectFrozen(work: string): Promise<FrozenInspection> {
  const destination = join(work, WORK_FILES.frozenDatabase);
  const identity = await fileIdentity(destination);
  try {
    const check = checkDatabase(destination);
    const source = join(work, WORK_FILES.workingDatabase);
    const sameRows = existsSync(source) ? canonicalJson(tableDigests(source)) === canonicalJson(tableDigests(destination)) : null;
    return { ...identity, integrityCheck: check.integrityCheck, journalMode: check.journalMode, sameRowsAsWorkingDatabase: sameRows, error: null };
  } catch (error) {
    return { ...identity, integrityCheck: null, journalMode: null, sameRowsAsWorkingDatabase: null, error: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
