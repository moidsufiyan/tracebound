import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findIncomingRelationships, findOutgoingRelationships } from '../../analysis/relationships.js';
import { findArtifactAtSnapshot, listSnapshotArtifacts } from '../../artifacts/artifacts.js';
import type { Database } from '../../db/database.js';
import { MIGRATIONS } from '../../db/migrations.js';
import { listExcludedEntries } from '../../ingestion/ingest-snapshot.js';
import { searchHybridDetailed } from '../../retrieval/hybrid-search.js';
import type { EmbeddingProvider } from '../../semantic/provider.js';
import { getSnapshot } from '../../snapshots/snapshots.js';
import { canonicalJson, sha256Hex } from '../m9/canonical.js';
import { checkDatabase, fileIdentity } from '../m9/freeze-database.js';
import { verifyFreezeIdentity } from './freeze-identity.js';
import {
  createJournal,
  inspectJournal,
  recoverJournal,
  type CochangeJournal,
  type EvaluationFailure,
  type EvaluationRecord,
  type ExpectedJournal,
  type PreparationRecord,
} from './journal.js';
import { acquireWorkLock, LockLostError, releaseWorkLock, verifyWorkLock, type LockAcquisition, type WorkLock } from './lock.js';
import { linkedTargets } from './metrics.js';
import {
  canonicalPath,
  headerFor,
  REGISTERED,
  runPreflight,
  validateManifest,
  WORK_FILES,
  type PreflightDependencies,
  type PreflightResult,
} from './preflight.js';
import { causedByProviderOutage, verifyRecordedSuccesses } from './prepare.js';
import { removeInputs, siblingRanking, siblingTestPool } from './rankings.js';
import type { CochangeManifest, SelectedCommit } from './selector.js';

// The evaluation phase of the co-change evaluation (protocol 1.0.0, sections 4 and 5, "Failed
// runs"): for every selected commit, in manifest order, the rankings of every registered method,
// recorded as one durable terminal journal record. It computes no metric, interval or outcome
// (that is the assembly step); it records what was retrieved, from which snapshot, with which
// query, and what failed.
//
// Order of a run, all under the work-directory lock (lock.ts): preflight (evaluation phase); the
// complete preparation journal and the frozen database, re-checked (integrity, schema, single
// file, and every recorded preparation success against its snapshot and indexes); recovery of a
// torn evaluation-journal tail, never anything else; then, per unrecorded commit:
// - ordinary hybrid: one `searchHybridDetailed` run with the commit subject and the input paths
//   (no symbols), giving the hybrid (`fused`), deterministic and semantic rankings of that one run;
// - the no-description arm: the same call with the description set to the empty string;
// - the sibling-test heuristic over the base snapshot's test paths;
// - inputs removed from every ranking (exact paths, order kept); the whole remaining ranking kept;
// - the structural links between inputs and test targets, and the targets absent from the snapshot.
// A commit whose base failed preparation gets those methods recorded as failed (stage
// 'preparation') without any call. Both retrieval calls are always attempted, so a recorded
// failure is always a real one.
//
// Failures: an error of a method is that method's recorded failure. An outage of the embedding
// provider (S3.1's typed signal) is recorded for the commit it hit, and then the run stops, leaving
// the later commits unrecorded for a later run. A damaged database, a lost lock or a record that
// does not match its inputs stops the run without a record (or refuses completion).

export interface EvaluationRequest {
  traceboundRoot: string;
  repositoryPath: string;
  workDirectory: string;
  manifestPath?: string;
  /** The registered embedding identity; the provider's modelId must equal it. */
  embeddingModelId: string;
  /**
   * Optional: the SHA-256 the caller expects the frozen database to have. The freeze identity the
   * preparation published is the source of that value; a value given here must equal the identity's and is
   * never preferred to it.
   */
  frozenDatabaseSha256?: string;
  provider: EmbeddingProvider;
}

export interface EvaluationDependencies extends PreflightDependencies {
  /** The production hybrid search; tests replace it to inject failures. */
  search?: typeof searchHybridDetailed;
  /** Called after a record is built and before it is appended; a throw simulates a crash. For tests. */
  beforeAppend?: (record: EvaluationRecord) => void;
}

/** Methods whose failure on any commit makes the primary analysis incomplete (protocol section 6, rule 1). */
export const PRIMARY_METHODS = ['hybrid', 'deterministic', 'semantic'] as const;

export type EvaluationRefusal =
  | 'work-directory-missing'
  | 'model-mismatch'
  | 'preflight'
  | 'preparation-journal-invalid'
  | 'frozen-database-invalid'
  | 'frozen-database-inconsistent'
  /** The freeze identity does not describe the frozen database as it is (structure or table contents). */
  | 'freeze-identity-invalid'
  | 'journal-unrecoverable';

export interface ExecutionSummary {
  commits: number;
  recordedThisRun: number;
  recoveredTornTail: boolean;
  /** Commits where hybrid, deterministic-only or semantic-only failed. */
  primaryFailedCommits: string[];
  /** Commits where the sibling heuristic failed (only possible without a base snapshot). */
  siblingFailedCommits: string[];
  /** Commits where the no-description arm failed; sensitivity only. */
  sensitivityFailedCommits: string[];
  frozenDatabaseSha256: string;
  /** SHA-256 of the evaluation journal's bytes when the run finished. */
  journalSha256: string;
}

export type EvaluationResult =
  /** Every commit has a record and every primary method and the sibling heuristic ran on every commit. */
  | ({ status: 'executed-complete' } & ExecutionSummary)
  /**
   * Every commit has a record, but a primary method or the sibling heuristic failed on at least one:
   * the primary outcome is Inconclusive (protocol section 6, rule 1); no primary estimate may be
   * computed from the commits that succeeded.
   */
  | ({ status: 'executed-primary-incomplete' } & ExecutionSummary)
  | { status: 'locked'; lock: Exclude<LockAcquisition, { status: 'acquired' }> }
  /** Nothing was evaluated or recorded by this call. */
  | { status: 'refused'; reason: EvaluationRefusal; detail: string; preflight?: PreflightResult }
  /** The run stopped before every commit had a record. */
  | { status: 'stopped'; reason: 'provider-unavailable' | 'database-invalid' | 'lock-lost'; detail: string; recordedThisRun: number }
  /** Every commit has a record, but the records do not match their recorded inputs, or the frozen database changed: not a result. */
  | { status: 'invalid'; detail: string; recordedThisRun: number };

class Refusal extends Error {
  readonly reason: EvaluationRefusal;
  readonly preflight: PreflightResult | undefined;
  constructor(reason: EvaluationRefusal, detail: string, preflight?: PreflightResult) {
    super(detail);
    this.reason = reason;
    this.preflight = preflight;
  }
}

class Stopped extends Error {
  readonly reason: 'provider-unavailable' | 'database-invalid' | 'lock-lost';
  constructor(reason: 'provider-unavailable' | 'database-invalid' | 'lock-lost', detail: string) {
    super(detail);
    this.reason = reason;
  }
}

class Invalid extends Error {}

/** Runs (or resumes) the evaluation phase. */
export async function runEvaluation(request: EvaluationRequest, dependencies: EvaluationDependencies = {}): Promise<EvaluationResult> {
  const work = canonicalPath(request.workDirectory);
  // Evaluation needs a prepared work directory; it never creates one.
  if (!existsSync(work)) return { status: 'refused', reason: 'work-directory-missing', detail: `${work} does not exist; run the preparation first` };
  const acquisition = acquireWorkLock(work, 'cochange evaluation');
  if (acquisition.status !== 'acquired') return { status: 'locked', lock: acquisition };
  const lock = acquisition.lock;
  let db: DatabaseSync | null = null;
  let recordedThisRun = 0;
  try {
    const state = await openEvaluation(request, dependencies, work, lock);
    db = state.db;
    const provider = new RecordingProvider(request.provider);
    const search = dependencies.search ?? searchHybridDetailed;
    for (let key = state.journal.next; key !== null; key = state.journal.next) {
      verifyLock(lock);
      const commit = state.commits.get(key)!;
      const { record, providerUnavailable } = await evaluateCommit(db, state.repositoryId, commit, state.preparation.get(commit.base)!, provider, search);
      dependencies.beforeAppend?.(record);
      verifyLock(lock);
      state.journal.append(record);
      recordedThisRun += 1;
      if (providerUnavailable) {
        throw new Stopped(
          'provider-unavailable',
          `The embedding provider became unavailable while evaluating ${key}; its failures are recorded, ${state.journal.remaining.length} commits are left unrecorded. Run again once the provider is back.`,
        );
      }
    }

    // Completion is declared only for records that match their inputs, from an unchanged frozen database.
    verifyRecords(state.journal, state.commits, state.preparation);
    db.close();
    db = null;
    const frozen = await fileIdentity(join(work, WORK_FILES.frozenDatabase));
    if (frozen.sha256 !== state.frozenDatabaseSha256) throw new Invalid(`${WORK_FILES.frozenDatabase} changed during the evaluation`);
    verifyLock(lock);
    return { ...summarize(state.journal, state.frozenDatabaseSha256, recordedThisRun, state.recovered, work) };
  } catch (error) {
    if (error instanceof Refusal) return { status: 'refused', reason: error.reason, detail: error.message, ...(error.preflight ? { preflight: error.preflight } : {}) };
    if (error instanceof Stopped) return { status: 'stopped', reason: error.reason, detail: error.message, recordedThisRun };
    if (error instanceof Invalid) return { status: 'invalid', detail: error.message, recordedThisRun };
    throw error;
  } finally {
    db?.close();
    try {
      releaseWorkLock(lock);
    } catch (error) {
      if (!(error instanceof LockLostError)) throw error;
    }
  }
}

interface OpenEvaluation {
  /** The frozen database's SHA-256 as the verified freeze identity records it. */
  frozenDatabaseSha256: string;
  journal: CochangeJournal;
  db: DatabaseSync;
  repositoryId: number;
  commits: Map<string, SelectedCommit>;
  preparation: Map<string, PreparationRecord>;
  recovered: boolean;
}

async function openEvaluation(request: EvaluationRequest, dependencies: EvaluationDependencies, work: string, lock: WorkLock): Promise<OpenEvaluation> {
  if (request.provider.modelId !== request.embeddingModelId) {
    throw new Refusal('model-mismatch', `The embedding provider is ${request.provider.modelId}, not the registered ${request.embeddingModelId}`);
  }
  const preflight = await runPreflight(
    {
      phase: 'evaluation',
      traceboundRoot: request.traceboundRoot,
      repositoryPath: request.repositoryPath,
      workDirectory: work,
      embeddingModelId: request.embeddingModelId,
      ...(request.frozenDatabaseSha256 === undefined ? {} : { frozenDatabaseSha256: request.frozenDatabaseSha256 }),
      ...(request.manifestPath === undefined ? {} : { manifestPath: request.manifestPath }),
    },
    dependencies,
  );
  if (preflight.status !== 'ready' && preflight.status !== 'interrupted') {
    throw new Refusal('preflight', `Preflight is ${preflight.status}: ${preflight.problems.map((p) => p.code).join(', ')}`, preflight);
  }
  if (preflight.header === null) throw new Refusal('preflight', 'Preflight gave no journal header');
  const manifest = readVerifiedManifest(request, dependencies, preflight.identity.manifestSha256);
  const commits = new Map(manifest.commits.map((commit) => [commit.sha, commit]));

  // The preparation journal must be complete and valid under the same identity.
  const preparationHeader = headerFor(preflight.identity, 'preparation');
  const preparationKeys = [...new Set(manifest.commits.map((c) => c.base))];
  const preparationInspection = inspectJournal(join(work, WORK_FILES.preparationJournal), { header: preparationHeader!, keys: preparationKeys });
  if (preparationInspection.status !== 'valid' || preparationInspection.journal.next !== null) {
    throw new Refusal('preparation-journal-invalid', `${WORK_FILES.preparationJournal} is not a complete, valid preparation journal for this run`);
  }
  const preparationJournal = preparationInspection.journal;
  const preparation = new Map(preparationJournal.records.map((r) => [(r as PreparationRecord).base, r as PreparationRecord]));

  // The frozen database: the bytes and structure the freeze identity records (preflight compared the file's
  // SHA-256 and the identity's bindings; this recomputes the database's own structure and every table's
  // digest), one self-contained file with the current schema and intact pages, opened read-only, holding
  // every prepared snapshot.
  const frozenPath = join(work, WORK_FILES.frozenDatabase);
  const frozenDatabaseSha256 = preflight.identity.frozenDatabaseSha256;
  if (frozenDatabaseSha256 === null) throw new Refusal('preflight', 'Preflight did not establish the frozen database identity', preflight);
  const identityCheck = await verifyFreezeIdentity(
    { identity: join(work, WORK_FILES.freezeIdentity), database: frozenPath, preparationJournal: join(work, WORK_FILES.preparationJournal) },
    {
      protocolVersion: preflight.identity.protocolVersion,
      manifestSha256: preflight.identity.manifestSha256,
      repository: preflight.identity.repository,
      tracebound: { commit: preflight.identity.tracebound.commit, sourceClean: preflight.identity.tracebound.sourceClean, buildSha256: preflight.identity.tracebound.buildSha256 },
      nodeVersion: preflight.identity.nodeVersion,
      embeddingModelId: request.embeddingModelId,
    },
    { deep: true },
  );
  if (identityCheck.status !== 'verified') {
    throw new Refusal('freeze-identity-invalid', identityCheck.status === 'refused' ? `${identityCheck.reason}: ${identityCheck.detail}` : `${WORK_FILES.freezeIdentity} is absent`);
  }
  let check: ReturnType<typeof checkDatabase>;
  try {
    check = checkDatabase(frozenPath);
  } catch (error) {
    throw new Refusal('frozen-database-invalid', `${WORK_FILES.frozenDatabase} cannot be checked: ${messageOf(error)}`);
  }
  if (check.integrityCheck !== 'ok' || check.foreignKeyViolations !== 0 || check.journalMode !== 'delete' || check.userVersion !== MIGRATIONS.length) {
    throw new Refusal('frozen-database-invalid', `${WORK_FILES.frozenDatabase} is not an intact frozen database of this schema: ${canonicalJson(check)}`);
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (existsSync(`${frozenPath}${suffix}`)) throw new Refusal('frozen-database-invalid', `${WORK_FILES.frozenDatabase} has a ${suffix} file next to it`);
  }

  verifyLock(lock);
  const db = new DatabaseSync(frozenPath, { readOnly: true });
  try {
    const repositories = db.prepare('SELECT id, name FROM repository').all() as { id: number; name: string }[];
    if (repositories.length !== 1 || repositories[0]!.name !== preflight.identity.repository.name) {
      throw new Refusal('frozen-database-inconsistent', `${WORK_FILES.frozenDatabase} does not hold exactly the registered repository`);
    }
    const repositoryId = repositories[0]!.id;
    try {
      verifyRecordedSuccesses(db as Database, repositoryId, preparationJournal, request.provider);
    } catch (error) {
      throw new Refusal('frozen-database-inconsistent', `${WORK_FILES.frozenDatabase} does not match the preparation journal: ${messageOf(error)}`);
    }

    const expected: ExpectedJournal = { header: preflight.header, keys: preflight.keys };
    const journalPath = join(work, WORK_FILES.evaluationJournal);
    verifyLock(lock);
    let journal: CochangeJournal;
    let recovered = false;
    if (!existsSync(journalPath)) {
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
    return { frozenDatabaseSha256, journal, db, repositoryId, commits, preparation, recovered };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** The manifest preflight checked, read again and required to be the same bytes. */
function readVerifiedManifest(request: EvaluationRequest, dependencies: EvaluationDependencies, sha256: string): CochangeManifest {
  const path = request.manifestPath ?? join(request.traceboundRoot, 'docs', 'evaluation', 'cochange', 'manifest.json');
  const bytes = readFileSync(path);
  if (sha256Hex(bytes) !== sha256) throw new Refusal('preflight', 'The manifest changed after preflight');
  return validateManifest(JSON.parse(bytes.toString('utf8')), dependencies.registration ?? REGISTERED);
}

// ---------------------------------------------------------------------------------------------
// One commit

interface QueryEmbedding {
  /** SHA-256 of the exact text sent to the provider. */
  textSha256: string;
  /** SHA-256 and little-endian Float32 bytes (base64) of the vector it returned. */
  vectorSha256: string;
  vector: string;
}

/** Passes calls through to the provider and keeps what each query was embedded as, for provenance. */
class RecordingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxInputChars: number;
  readonly #inner: EmbeddingProvider;
  calls: QueryEmbedding[] = [];

  constructor(inner: EmbeddingProvider) {
    this.#inner = inner;
    this.modelId = inner.modelId;
    this.dimensions = inner.dimensions;
    this.maxInputChars = inner.maxInputChars;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    const vectors = await this.#inner.embed(texts);
    vectors.forEach((vector, i) => {
      const bytes = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
      this.calls.push({ textSha256: sha256Hex(Buffer.from(texts[i]!, 'utf8')), vectorSha256: sha256Hex(bytes), vector: bytes.toString('base64') });
    });
    return vectors;
  }
}

type Rankings = Partial<Record<'hybridPaths' | 'deterministicPaths' | 'semanticPaths' | 'siblingPaths' | 'noDescriptionPaths', string[]>>;

async function evaluateCommit(
  db: DatabaseSync,
  repositoryId: number,
  commit: SelectedCommit,
  prepared: PreparationRecord,
  provider: RecordingProvider,
  search: typeof searchHybridDetailed,
): Promise<{ record: EvaluationRecord; providerUnavailable: boolean }> {
  const database = db as Database;
  const failures: EvaluationFailure[] = [];
  const rankings: Rankings = {};
  const queryEmbeddings: Record<string, QueryEmbedding[]> = {};
  const recordedSnapshot = (prepared.evidence as { snapshotId?: unknown }).snapshotId;
  const snapshotId = typeof recordedSnapshot === 'number' && getSnapshot(database, recordedSnapshot)?.status === 'ready' ? recordedSnapshot : null;
  const evidence: Record<string, unknown> = {
    base: commit.base,
    snapshotId,
    preparation: prepared.status === 'succeeded' ? { status: 'succeeded' } : { status: 'failed', stage: prepared.failures[0]!.stage },
    query: { description: commit.subject, inputPaths: [...commit.inputs] },
    targets: commit.targets.map(({ path, kind }) => ({ path, kind })),
  };

  if (snapshotId !== null) {
    const excluded = new Map(listExcludedEntries(database, snapshotId).map((e) => [e.path, e.reason]));
    evidence['missingTargets'] = commit.targets
      .filter((t) => findArtifactAtSnapshot(database, snapshotId, t.path) === undefined)
      .map((t) => ({ path: t.path, reason: excluded.get(t.path) ?? 'absent' }));
  }

  let providerUnavailable = false;
  let databaseSuspect = false;
  const fail = (methods: readonly EvaluationFailure['method'][], stage: EvaluationFailure['stage'], error: unknown) => {
    if (causedByProviderOutage(error)) providerUnavailable = true;
    else if (stage !== 'preparation') databaseSuspect = true;
    for (const method of methods) failures.push({ method, stage, errorName: error instanceof Error && error.name ? error.name : 'Error', message: messageOf(error) });
  };

  if (prepared.status === 'failed') {
    const failure = prepared.failures[0]!;
    const cause = Object.assign(new Error(`The base ${commit.base} failed preparation at ${failure.stage}: ${failure.errorName}: ${failure.message}`), { name: 'PreparationFailed' });
    fail([...PRIMARY_METHODS, 'no-description'], 'preparation', cause);
  } else {
    const query = (description: string) => ({ description, changedPaths: [...commit.inputs] });
    // Ordinary hybrid: the three primary rankings of one run.
    provider.calls = [];
    try {
      const run = await search(database, snapshotId!, provider, query(commit.subject));
      rankings.hybridPaths = pathsAfterRemoval(run.fused, commit.inputs);
      rankings.deterministicPaths = pathsAfterRemoval(run.deterministic, commit.inputs);
      rankings.semanticPaths = pathsAfterRemoval(run.semantic, commit.inputs);
      evidence['retrieval'] = { rrfK: run.rrfK, modelId: run.modelId };
    } catch (error) {
      fail(PRIMARY_METHODS, 'retrieval', error);
    }
    queryEmbeddings['ordinary'] = provider.calls;
    // The no-description arm: the same query with an empty description, always attempted.
    provider.calls = [];
    try {
      const run = await search(database, snapshotId!, provider, query(''));
      rankings.noDescriptionPaths = pathsAfterRemoval(run.fused, commit.inputs);
    } catch (error) {
      fail(['no-description'], 'retrieval', error);
    }
    queryEmbeddings['noDescription'] = provider.calls;
    provider.calls = [];
    evidence['queryEmbeddings'] = queryEmbeddings;
  }

  if (snapshotId !== null) {
    try {
      const pool = siblingTestPool(listSnapshotArtifacts(database, snapshotId));
      rankings.siblingPaths = pathsAfterRemoval(siblingRanking(commit.inputs, pool), commit.inputs);
    } catch (error) {
      fail(['sibling'], 'analysis', error);
    }
  } else {
    fail(['sibling'], 'preparation', Object.assign(new Error(`The base ${commit.base} has no ready snapshot`), { name: 'PreparationFailed' }));
  }

  if (prepared.status === 'succeeded') {
    // The structural-link stratum: relationships of the inputs, in either direction.
    const inputIds = commit.inputs.flatMap((path) => {
      const artifact = findArtifactAtSnapshot(database, snapshotId!, path);
      return artifact ? [artifact.artifactId] : [];
    });
    const relationships = [...findIncomingRelationships(database, snapshotId!, inputIds), ...findOutgoingRelationships(database, snapshotId!, inputIds)];
    const tests = commit.targets.filter((t) => t.kind === 'test').map((t) => t.path);
    evidence['linkedTargetPaths'] = [...linkedTargets(commit.inputs, tests, relationships)].sort();
  }
  evidence['rankings'] = rankings;
  if (providerUnavailable) evidence['providerUnavailable'] = true;

  if (databaseSuspect) checkIntegrity(db, commit.sha);
  failures.sort((a, b) => METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method));
  return {
    record: { kind: 'record', phase: 'evaluation', commit: commit.sha, status: failures.length === 0 ? 'succeeded' : 'failed', failures, evidence },
    providerUnavailable,
  };
}

const METHOD_ORDER: readonly EvaluationFailure['method'][] = ['hybrid', 'deterministic', 'semantic', 'sibling', 'no-description'];

/** The ranking's paths with the inputs removed (exact paths, order kept), the whole list. */
function pathsAfterRemoval(ranking: readonly { path: string }[], inputs: readonly string[]): string[] {
  return removeInputs(ranking, inputs).map((entry) => entry.path);
}

function checkIntegrity(db: DatabaseSync, commit: string): void {
  let integrity: string;
  try {
    integrity = (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((row) => row.integrity_check).join('; ');
  } catch (error) {
    throw new Stopped('database-invalid', `The frozen database cannot be checked after a failure on ${commit}: ${messageOf(error)}`);
  }
  if (integrity !== 'ok') throw new Stopped('database-invalid', `The frozen database failed its integrity check after a failure on ${commit}: ${integrity}`);
}

function verifyLock(lock: WorkLock): void {
  try {
    verifyWorkLock(lock);
  } catch (error) {
    if (error instanceof LockLostError) throw new Stopped('lock-lost', error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Completion

const RANKING_KEYS = {
  hybrid: 'hybridPaths',
  deterministic: 'deterministicPaths',
  semantic: 'semanticPaths',
  sibling: 'siblingPaths',
  'no-description': 'noDescriptionPaths',
} as const;

/**
 * Every record must be for its manifest commit and say so: base, snapshot, query, targets; each
 * method either failed (and has no ranking) or has a ranking without duplicates or inputs; a base
 * that failed preparation has its primary methods failed at that stage. Throws Invalid otherwise.
 */
export function verifyRecords(journal: CochangeJournal, commits: Map<string, SelectedCommit>, preparation: Map<string, PreparationRecord>): void {
  if (journal.next !== null || journal.records.length !== commits.size) throw new Invalid('Not every commit has a record');
  for (const raw of journal.records) {
    const record = raw as EvaluationRecord;
    const commit = commits.get(record.commit);
    const prepared = commit ? preparation.get(commit.base) : undefined;
    const problem = (detail: string) => new Invalid(`The record of ${record.commit} ${detail}`);
    if (!commit || !prepared) throw problem('has no manifest commit or preparation record');
    const e = record.evidence as Record<string, unknown>;
    if (e['base'] !== commit.base) throw problem('names another base');
    const preparedSnapshot = (prepared.evidence as { snapshotId?: unknown }).snapshotId ?? null;
    if (e['snapshotId'] !== null && e['snapshotId'] !== preparedSnapshot) throw problem('names another snapshot than preparation recorded');
    if (prepared.status === 'succeeded' && e['snapshotId'] !== preparedSnapshot) throw problem('lacks the prepared snapshot');
    if (canonicalJson(e['query']) !== canonicalJson({ description: commit.subject, inputPaths: commit.inputs })) throw problem('has another query than the manifest');
    if (canonicalJson(e['targets']) !== canonicalJson(commit.targets.map(({ path, kind }) => ({ path, kind })))) throw problem('has other targets than the manifest');
    const rankings = (e['rankings'] ?? {}) as Rankings;
    const failed = new Set(record.failures.map((f) => f.method));
    for (const [method, key] of Object.entries(RANKING_KEYS) as [EvaluationFailure['method'], keyof Rankings][]) {
      const ranking = rankings[key];
      if (failed.has(method) === (ranking !== undefined)) throw problem(`has ${failed.has(method) ? 'both a failure and a ranking' : 'neither a failure nor a ranking'} for ${method}`);
      if (ranking && (new Set(ranking).size !== ranking.length || ranking.some((path) => commit.inputs.includes(path)))) throw problem(`has an invalid ${method} ranking`);
    }
    if (prepared.status === 'failed' && !PRIMARY_METHODS.every((m) => record.failures.some((f) => f.method === m && f.stage === 'preparation'))) {
      throw problem('does not record the preparation failure of its base');
    }
  }
}

function summarize(journal: CochangeJournal, frozenDatabaseSha256: string, recordedThisRun: number, recovered: boolean, work: string): EvaluationResult {
  const records = journal.records as EvaluationRecord[];
  const failing = (methods: readonly string[]) => records.filter((r) => r.failures.some((f) => methods.includes(f.method))).map((r) => r.commit);
  const summary: ExecutionSummary = {
    commits: records.length,
    recordedThisRun,
    recoveredTornTail: recovered,
    primaryFailedCommits: failing(PRIMARY_METHODS),
    siblingFailedCommits: failing(['sibling']),
    sensitivityFailedCommits: failing(['no-description']),
    frozenDatabaseSha256,
    journalSha256: sha256Hex(readFileSync(join(work, WORK_FILES.evaluationJournal))),
  };
  const complete = summary.primaryFailedCommits.length === 0 && summary.siblingFailedCommits.length === 0;
  return complete ? { status: 'executed-complete', ...summary } : { status: 'executed-primary-incomplete', ...summary };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
