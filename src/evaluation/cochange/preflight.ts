import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  CommitNotFoundError,
  isAncestor,
  isShallowRepository,
  listCommitHistory,
  readCommit,
  verifyGitRepository,
  type FileChangeStatus,
} from '../../git/git.js';
import { assertPortablePath, canonicalJson, digestOf, sha256Hex } from '../m9/canonical.js';
import { fileIdentity } from '../m9/freeze-database.js';
import {
  inspectJournal,
  journalKeys,
  type ExpectedJournal,
  type JournalHeader,
  type JournalInspection,
  type JournalPhase,
} from './journal.js';
import { claimedDatabaseSha256, FREEZE_IDENTITY_FILE, verifyFreezeIdentity, type FreezeBindings } from './freeze-identity.js';
import { LOCK_FILE } from './lock.js';
import { DESIGN_CASE_COMMITS, PROTOCOL, SELECTION_RULES, samplePositions, type CochangeManifest } from './selector.js';

// Read-only preflight of the co-change evaluation (protocol 1.0.0). It verifies, and refuses
// otherwise, that:
// - the manifest is the frozen one (exact SHA-256), canonical, and internally consistent;
// - the repository clone is complete (not shallow, not partial) and holds every pinned commit with
//   the recorded parent and subject, reachable from the pinned head, and no design-case commit;
// - the Tracebound source and build configuration are committed and clean, and every `dist/**/*.js`
//   is byte-for-byte what the installed, lockfile-pinned compiler makes of that source;
// - the work directory is outside the Tracebound and dataset repositories (after resolving
//   symlinks), holds only known files, and its journals and databases fit the requested phase.
//
// It writes nothing in the repositories or the work directory, and never creates the work
// directory, a journal, a database or a result. The one write is the build check: the source is
// compiled into a temporary directory under the OS temp folder, removed afterwards. It does not
// contact Ollama: the embedding model id is checked as configuration only.
//
// Preflight is not a lock. Its answer can be out of date as soon as it returns; the preparation
// and evaluation entry points must take an exclusive lock on the work directory before inspecting
// a journal and hold it through their last append or recovery (see journal.ts).

export interface Registration {
  manifestSha256: string;
  repositoryName: string;
  head: string;
  since: string | null;
  embeddingModel: string;
}

/** The frozen dataset this protocol run is registered for (docs/evaluation/cochange/reproduce.md). */
export const REGISTERED: Readonly<Registration> = Object.freeze({
  manifestSha256: 'd179d992f28b201b558e9c5c97db3e9b0ac39f18544b2463d73f317b865eb361',
  repositoryName: 'sindresorhus/got',
  head: '05b4476913da39a47dd8e20d29e250f28b0a6dca',
  since: null,
  embeddingModel: 'nomic-embed-text:v1.5',
});

/** File names in the work directory. Anything else there is refused. */
export const WORK_FILES = Object.freeze({
  preparationJournal: 'preparation.jsonl',
  evaluationJournal: 'evaluation.jsonl',
  workingDatabase: 'preparation.sqlite',
  frozenDatabase: 'frozen.sqlite',
  /** The run lock (lock.ts); present while a phase runs, or left behind by one that died. */
  lock: LOCK_FILE,
  /** The durable identity of the frozen database, written by the preparation (freeze-identity.ts). */
  freezeIdentity: FREEZE_IDENTITY_FILE,
});
const ALLOWED_WORK_ENTRIES = new Set([
  WORK_FILES.preparationJournal,
  `${WORK_FILES.preparationJournal}.torn`,
  WORK_FILES.evaluationJournal,
  `${WORK_FILES.evaluationJournal}.torn`,
  WORK_FILES.workingDatabase,
  `${WORK_FILES.workingDatabase}-wal`,
  `${WORK_FILES.workingDatabase}-shm`,
  `${WORK_FILES.workingDatabase}-journal`,
  WORK_FILES.frozenDatabase,
  WORK_FILES.lock,
  WORK_FILES.freezeIdentity,
]);

/** Paths of the Tracebound checkout that make up the evaluation code and configuration; all must be committed and clean. */
export const EVALUATION_SOURCE_PATHS = Object.freeze([
  'src',
  'scripts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'docs/evaluation/cochange',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const MINIMUM_NODE_MAJOR = 24;

export interface PreflightConfig {
  phase: JournalPhase;
  /** The Tracebound checkout (its top-level directory). */
  traceboundRoot: string;
  /** Defaults to docs/evaluation/cochange/manifest.json under the root. */
  manifestPath?: string;
  /** The full clone of the dataset repository. */
  repositoryPath: string;
  /** Where journals and databases live; it need not exist yet and is never created here. */
  workDirectory: string;
  /**
   * The embedding provider's model id (for Ollama, `ollama:nomic-embed-text:v1.5@<digest>`), needed
   * to check existing journals. Checked as text only: preflight does not contact Ollama.
   */
  embeddingModelId?: string;
  /**
   * Evaluation phase, optional: the SHA-256 the caller expects the frozen database to have. The freeze
   * identity written by the preparation is the source of that value; if the caller supplies one it must
   * equal the identity's, and it is never preferred to it.
   */
  frozenDatabaseSha256?: string;
}

export interface PreflightDependencies {
  /** Compiles the checkout's source with its build configuration into `outDir`. */
  compile?: (traceboundRoot: string, outDir: string) => Promise<void>;
  registration?: Registration;
  nodeVersion?: string;
}

export type PreflightCode =
  // invalid: the inputs themselves are wrong
  | 'config-invalid'
  | 'manifest-unreadable'
  | 'manifest-hash-mismatch'
  | 'manifest-not-canonical'
  | 'manifest-invalid'
  | 'repository-invalid'
  | 'repository-shallow'
  | 'repository-partial'
  | 'commit-missing'
  | 'commit-inconsistent'
  | 'repository-not-independent'
  // refused: the environment is not safe to run in
  | 'node-unsupported'
  | 'source-not-a-checkout'
  | 'source-dirty'
  | 'compiler-unverifiable'
  | 'build-missing'
  | 'build-unverifiable'
  | 'build-stale'
  | 'work-directory-unsafe'
  | 'work-directory-unexpected-entry'
  | 'journal-identity-unverifiable'
  | 'journal-invalid'
  | 'database-without-journal'
  | 'frozen-database-exists'
  | 'frozen-database-missing'
  | 'frozen-database-mismatch'
  | 'freeze-identity-missing'
  | 'freeze-identity-malformed'
  | 'freeze-identity-mismatch'
  | 'freeze-identity-orphan'
  | 'evaluation-already-started'
  | 'preparation-incomplete';

export interface PreflightProblem {
  code: PreflightCode;
  detail: string;
}

/** Everything a journal header and the run's provenance need, as established by preflight. */
export interface PreflightIdentity {
  phase: JournalPhase;
  protocolVersion: string;
  manifestSha256: string;
  repository: { name: string; head: string };
  tracebound: { commit: string; sourceClean: true; buildSha256: string; typescriptVersion: string };
  nodeVersion: string;
  embedding: {
    model: string;
    /** As configured; null when not given. Never verified against Ollama here. */
    modelId: string | null;
    verifiedAgainstProvider: false;
  };
  /** Evaluation phase only: the frozen database's recorded SHA-256, matched against the file. */
  frozenDatabaseSha256: string | null;
}

export type JournalState =
  | { state: 'absent' }
  | { state: 'valid'; recorded: number; next: string | null; previousRecovery: boolean }
  | { state: 'interrupted'; recorded: number; next: string | null; tornBytes: number; headerTorn: boolean; artifact: 'not-needed' | 'absent' | 'identical' }
  | { state: 'invalid'; reason: string; detail: string }
  | { state: 'unverified' };

export interface WorkDirectoryState {
  /** Canonical (symlink-resolved) path; nothing is created there by preflight. */
  path: string;
  exists: boolean;
  preparationJournal: JournalState;
  evaluationJournal: JournalState;
  workingDatabase: 'absent' | 'present';
  frozenDatabase: { state: 'absent' } | { state: 'present'; sha256: string; bytes: number; matchesRecorded: boolean | null };
  /** The freeze identity: absent, verified against the files and the run identity (shallow), or refused. */
  freezeIdentity: 'absent' | 'verified' | 'refused';
}

export type PreflightResult =
  /** Safe to start or resume the phase (under the caller's lock). */
  | { status: 'ready'; identity: PreflightIdentity; identityDigest: string; header: JournalHeader | null; keys: string[]; work: WorkDirectoryState }
  /** Everything checks out, but a journal has a torn tail that must be recovered explicitly first. */
  | { status: 'interrupted'; identity: PreflightIdentity; identityDigest: string; header: JournalHeader; keys: string[]; work: WorkDirectoryState; journal: JournalPhase }
  /** The inputs are valid, but the source, build, environment or work directory forbid running. */
  | { status: 'refused'; problems: PreflightProblem[]; work: WorkDirectoryState | null }
  /** The configuration, manifest or repository is wrong; nothing else was checked. */
  | { status: 'invalid'; problems: PreflightProblem[] };

class Stop extends Error {
  readonly problem: PreflightProblem;
  constructor(problem: PreflightProblem) {
    super(problem.detail);
    this.problem = problem;
  }
}
const stop = (code: PreflightCode, detail: string): never => {
  throw new Stop({ code, detail });
};

/** Runs every preflight check. Read-only apart from the temporary build check described above. */
export async function runPreflight(config: PreflightConfig, dependencies: PreflightDependencies = {}): Promise<PreflightResult> {
  const registration = dependencies.registration ?? REGISTERED;
  let manifest: CochangeManifest;
  let manifestSha256: string;
  try {
    checkConfig(config, registration);
    ({ manifest, manifestSha256 } = readManifest(config, registration));
    await checkRepository(config.repositoryPath, manifest, registration);
  } catch (error) {
    if (error instanceof Stop) return { status: 'invalid', problems: [error.problem] };
    throw error;
  }

  const problems: PreflightProblem[] = [];
  const nodeVersion = dependencies.nodeVersion ?? process.version;
  const major = /^v(\d+)\.\d+\.\d+$/.exec(nodeVersion)?.[1];
  if (major === undefined || Number(major) < MINIMUM_NODE_MAJOR) problems.push({ code: 'node-unsupported', detail: `Node ${nodeVersion}; ${MINIMUM_NODE_MAJOR} or later is required` });

  const source = await checkSource(config.traceboundRoot, dependencies.compile ?? compileWithInstalledTypescript, problems);
  const identity: PreflightIdentity | null =
    source === null
      ? null
      : {
          phase: config.phase,
          protocolVersion: PROTOCOL.version,
          manifestSha256,
          repository: { name: registration.repositoryName, head: registration.head },
          tracebound: { commit: source.commit, sourceClean: true, buildSha256: source.buildSha256, typescriptVersion: source.typescriptVersion },
          nodeVersion,
          embedding: { model: registration.embeddingModel, modelId: config.embeddingModelId ?? null, verifiedAgainstProvider: false },
          // The identity file's claim, only to build the journal header; checkWorkDirectory verifies it.
          frozenDatabaseSha256: config.phase === 'evaluation' ? claimedDatabaseSha256(join(canonicalPath(config.workDirectory), WORK_FILES.freezeIdentity)) : null,
        };

  const work = await checkWorkDirectory(config, manifest, identity, problems);
  if (problems.length > 0 || identity === null) return { status: 'refused', problems, work };

  const header = headerFor(identity, config.phase);
  const keys = journalKeys(manifest, config.phase);
  const identityDigest = digestOf(identity);
  const current = config.phase === 'preparation' ? work!.preparationJournal : work!.evaluationJournal;
  if (current.state === 'interrupted') return { status: 'interrupted', identity, identityDigest, header: header!, keys, work: work!, journal: config.phase };
  return { status: 'ready', identity, identityDigest, header, keys, work: work! };
}

// ---------------------------------------------------------------------------------------------
// Configuration and manifest

function checkConfig(config: PreflightConfig, registration: Registration): void {
  if (config.phase !== 'preparation' && config.phase !== 'evaluation') stop('config-invalid', `Unknown phase ${JSON.stringify(config.phase)}`);
  for (const key of ['traceboundRoot', 'repositoryPath', 'workDirectory'] as const) {
    if (typeof config[key] !== 'string' || config[key].length === 0) stop('config-invalid', `${key} is required`);
  }
  if (config.embeddingModelId !== undefined) {
    const prefix = `ollama:${registration.embeddingModel}@`;
    if (!config.embeddingModelId.startsWith(prefix) || !/^[0-9a-f]+$/.test(config.embeddingModelId.slice(prefix.length))) {
      stop('config-invalid', `embeddingModelId must be ${prefix}<weights digest>, got ${JSON.stringify(config.embeddingModelId)}`);
    }
  }
  if (config.phase === 'evaluation') {
    if (config.frozenDatabaseSha256 !== undefined && !SHA256.test(config.frozenDatabaseSha256)) stop('config-invalid', 'frozenDatabaseSha256 is not a SHA-256');
  } else if (config.frozenDatabaseSha256 !== undefined) {
    stop('config-invalid', 'frozenDatabaseSha256 belongs to the evaluation phase');
  }
}

function readManifest(config: PreflightConfig, registration: Registration): { manifest: CochangeManifest; manifestSha256: string } {
  const path = config.manifestPath ?? join(config.traceboundRoot, 'docs', 'evaluation', 'cochange', 'manifest.json');
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return stop('manifest-unreadable', `${path}: ${messageOf(error)}`);
  }
  const manifestSha256 = sha256Hex(bytes);
  if (manifestSha256 !== registration.manifestSha256) {
    stop('manifest-hash-mismatch', `The manifest's SHA-256 is ${manifestSha256}, not the registered ${registration.manifestSha256}`);
  }
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
    if (canonicalJson(value) !== text) stop('manifest-not-canonical', 'The manifest is not RFC 8785 canonical JSON');
  } catch (error) {
    if (error instanceof Stop) throw error;
    stop('manifest-not-canonical', `The manifest is not valid UTF-8 JSON: ${messageOf(error)}`);
  }
  try {
    return { manifest: validateManifest(value, registration), manifestSha256 };
  } catch (error) {
    if (error instanceof Stop) throw error;
    return stop('manifest-invalid', messageOf(error));
  }
}

const STATUSES: readonly FileChangeStatus[] = ['added', 'modified', 'deleted', 'renamed', 'type_changed'];
const CLASSES = ['source', 'test', 'doc', 'ignored'] as const;
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function keysExactly(value: unknown, at: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${at} is not an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) throw new Error(`${at} has fields ${actual.join(', ')}, expected ${wanted.join(', ')}`);
  return value as Record<string, unknown>;
}

function portableOrNull(value: unknown, at: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${at} is not a path`);
  assertPortablePath(value);
  return value;
}

/** Checks every manifest invariant the selector guarantees, against the registration. */
export function validateManifest(value: unknown, registration: Registration): CochangeManifest {
  const m = keysExactly(value, 'manifest', ['schema', 'schemaVersion', 'protocol', 'repository', 'rules', 'exclusions', 'counts', 'commits']);
  if (m['schema'] !== 'tracebound.cochange.manifest' || m['schemaVersion'] !== '1.0.0') throw new Error('Unsupported manifest schema or schema version');
  if (canonicalJson(m['protocol']) !== canonicalJson(PROTOCOL)) throw new Error(`The manifest is for protocol ${canonicalJson(m['protocol'])}, not ${canonicalJson(PROTOCOL)}`);
  if (canonicalJson(m['rules']) !== canonicalJson(SELECTION_RULES)) throw new Error('The manifest rules differ from the registered selection rules');
  if (canonicalJson(m['exclusions']) !== canonicalJson({ designCaseCommits: [...DESIGN_CASE_COMMITS].sort(byPath) })) throw new Error('The manifest design-case exclusions differ');
  const repository = keysExactly(m['repository'], 'repository', ['name', 'head', 'since']);
  if (repository['name'] !== registration.repositoryName || repository['head'] !== registration.head || repository['since'] !== registration.since) {
    throw new Error(`The manifest is for ${canonicalJson(repository)}, not the registered repository`);
  }

  const counts = keysExactly(m['counts'], 'counts', ['reachable', 'eligible', 'selected', 'rejected']);
  const rejected = keysExactly(counts['rejected'], 'counts.rejected', ['root', 'merge', 'design_case', 'too_many_changes', 'no_changes', 'no_source_input', 'no_target']);
  const integers = [counts['reachable'], counts['eligible'], counts['selected'], ...Object.values(rejected)];
  if (!integers.every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) throw new Error('Counts must be non-negative integers');
  const eligible = counts['eligible'] as number;
  const rejectedTotal = Object.values(rejected).reduce<number>((sum, n) => sum + (n as number), 0);
  if (rejectedTotal + eligible !== counts['reachable']) throw new Error('Rejected plus eligible commits do not add up to the reachable commits');
  if (rejected['design_case'] !== 0) throw new Error('A design-case commit was in the considered history');
  if (eligible < SELECTION_RULES.minimumSample) throw new Error(`${eligible} eligible commits is below the minimum ${SELECTION_RULES.minimumSample}`);

  if (!Array.isArray(m['commits'])) throw new Error('commits is not an array');
  const commits = m['commits'] as unknown[];
  const positions = samplePositions(eligible);
  if (counts['selected'] !== commits.length || commits.length !== positions.length) throw new Error(`${commits.length} commits listed, ${counts['selected']} counted, ${positions.length} expected from ${eligible} eligible`);

  const shas = new Set<string>();
  commits.forEach((raw, i) => {
    const at = `commits[${i}]`;
    const c = keysExactly(raw, at, ['sha', 'base', 'subject', 'eligibleIndex', 'changes', 'inputs', 'targets']);
    if (typeof c['sha'] !== 'string' || !COMMIT_SHA.test(c['sha']) || typeof c['base'] !== 'string' || !COMMIT_SHA.test(c['base'])) throw new Error(`${at} has an invalid sha or base`);
    if (c['sha'] === c['base']) throw new Error(`${at} is its own base`);
    if (shas.has(c['sha'])) throw new Error(`${at} repeats ${c['sha']}`);
    if (DESIGN_CASE_COMMITS.includes(c['sha'])) throw new Error(`${at} is a design-case commit`);
    shas.add(c['sha']);
    if (typeof c['subject'] !== 'string') throw new Error(`${at}.subject is not a string`);
    if (c['eligibleIndex'] !== positions[i]) throw new Error(`${at}.eligibleIndex is ${String(c['eligibleIndex'])}, expected ${positions[i]}`);

    if (!Array.isArray(c['changes']) || c['changes'].length < 1 || c['changes'].length > SELECTION_RULES.maxChangeRecords) throw new Error(`${at} must have 1 to ${SELECTION_RULES.maxChangeRecords} changes`);
    const changes = (c['changes'] as unknown[]).map((rawChange, j) => {
      const where = `${at}.changes[${j}]`;
      const change = keysExactly(rawChange, where, ['status', 'path', 'previousPath', 'similarity', 'basePath', 'baseClass']);
      const status = change['status'] as FileChangeStatus;
      if (!STATUSES.includes(status)) throw new Error(`${where}.status is invalid`);
      const path = portableOrNull(change['path'], `${where}.path`);
      const previousPath = portableOrNull(change['previousPath'], `${where}.previousPath`);
      const basePath = portableOrNull(change['basePath'], `${where}.basePath`);
      if (path === null) throw new Error(`${where}.path is missing`);
      if ((status === 'renamed') !== (previousPath !== null)) throw new Error(`${where}: only a rename has a previous path`);
      const similarity = change['similarity'];
      if (status === 'renamed' ? !(Number.isInteger(similarity) && (similarity as number) >= 0 && (similarity as number) <= 100) : similarity !== null) {
        throw new Error(`${where}.similarity does not fit the status`);
      }
      const expectedBase = status === 'added' ? null : status === 'renamed' ? previousPath : path;
      if (basePath !== expectedBase) throw new Error(`${where}.basePath is not the base-side path`);
      const baseClass = change['baseClass'];
      if (baseClass !== null && !CLASSES.includes(baseClass as (typeof CLASSES)[number])) throw new Error(`${where}.baseClass is invalid`);
      if (basePath === null && baseClass !== null) throw new Error(`${where}: an added file has no base class`);
      return { status, path, previousPath: previousPath ?? '', basePath, baseClass: baseClass as (typeof CLASSES)[number] | null };
    });
    changes.forEach((change, j) => {
      const previous = changes[j - 1];
      if (previous && (byPath(previous.path, change.path) || byPath(previous.previousPath, change.previousPath)) > 0) throw new Error(`${at}.changes are not in path order`);
    });

    const expectedInputs = [...new Set(changes.filter((ch) => ch.baseClass === 'source').map((ch) => ch.basePath!))].sort(byPath);
    const targetMap = new Map<string, { path: string; kind: string; status: string }>();
    for (const ch of changes) if (ch.baseClass === 'test' || ch.baseClass === 'doc') targetMap.set(ch.basePath!, { path: ch.basePath!, kind: ch.baseClass, status: ch.status });
    const expectedTargets = [...targetMap.values()].sort((a, b) => byPath(a.path, b.path));
    if (canonicalJson(c['inputs']) !== canonicalJson(expectedInputs)) throw new Error(`${at}.inputs do not follow from its changes`);
    if (canonicalJson(c['targets']) !== canonicalJson(expectedTargets)) throw new Error(`${at}.targets do not follow from its changes`);
    if (expectedInputs.length === 0 || expectedTargets.length === 0) throw new Error(`${at} needs at least one input and one target`);
    if (expectedInputs.some((path) => targetMap.has(path))) throw new Error(`${at} has a path that is both input and target`);
  });
  return value as CochangeManifest;
}

// ---------------------------------------------------------------------------------------------
// Dataset repository

async function checkRepository(repoPath: string, manifest: CochangeManifest, registration: Registration): Promise<void> {
  try {
    await checkRepositoryContents(repoPath, manifest, registration);
  } catch (error) {
    // Any other Git failure (for example a missing object in the history) means the clone cannot be trusted.
    if (error instanceof Stop) throw error;
    stop('repository-invalid', messageOf(error));
  }
}

async function checkRepositoryContents(repoPath: string, manifest: CochangeManifest, registration: Registration): Promise<void> {
  await verifyGitRepository(repoPath);
  if (await isShallowRepository(repoPath)) stop('repository-shallow', `${repoPath} is a shallow clone; a full clone is required`);
  // A partial clone is marked by extensions.partialClone or, in current Git, remote.<name>.promisor.
  const partial = await git(repoPath, ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$']);
  if (partial.code !== 0 && partial.code !== 1) stop('repository-invalid', `git config failed: ${partial.stderr}`);
  const markers = partial.stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((line) => {
      const [key = '', value = ''] = line.split(/ (.*)/s);
      return key === 'extensions.partialclone' || ['true', 'yes', 'on', '1'].includes(value.trim().toLowerCase());
    });
  if (markers.length > 0) stop('repository-partial', `${repoPath} is a partial clone (${markers.join('; ')}); a full clone is required`);

  await requireCommit(repoPath, registration.head);
  // Every commit reachable from the pinned head, with its parents and subject: one `git log`.
  const history = new Map((await listCommitHistory(repoPath, registration.head)).map((commit) => [commit.sha, commit]));
  for (const commit of manifest.commits) {
    const found = history.get(commit.sha);
    if (!found) {
      await requireCommit(repoPath, commit.sha);
      stop('commit-inconsistent', `${commit.sha} is not reachable from the pinned head ${registration.head}`);
    }
    if (found!.parents.length !== 1 || found!.parents[0] !== commit.base) stop('commit-inconsistent', `${commit.sha} has parents ${found!.parents.join(', ') || 'none'}, not the recorded base ${commit.base}`);
    if (found!.subject !== commit.subject) stop('commit-inconsistent', `${commit.sha} has another subject than the manifest records`);
    // A parent of a reachable commit is itself listed (there is no lower bound), so this only fails on a damaged repository.
    if (!history.has(commit.base)) {
      await requireCommit(repoPath, commit.base);
      stop('commit-inconsistent', `The base ${commit.base} of ${commit.sha} is not reachable from the pinned head`);
    }
  }
  for (const designCase of DESIGN_CASE_COMMITS) {
    try {
      await readCommit(repoPath, designCase);
    } catch (error) {
      if (error instanceof CommitNotFoundError) continue;
      throw error;
    }
    if (await isAncestor(repoPath, designCase, registration.head)) stop('repository-not-independent', `Design-case commit ${designCase} is an ancestor of the pinned head`);
  }
}

async function requireCommit(repoPath: string, sha: string): Promise<void> {
  try {
    await readCommit(repoPath, sha);
  } catch (error) {
    if (error instanceof CommitNotFoundError) stop('commit-missing', `${repoPath} has no commit ${sha}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Tracebound source and build

interface SourceIdentity {
  commit: string;
  buildSha256: string;
  typescriptVersion: string;
}

/**
 * The checkout's commit, provided the evaluation source and configuration are committed and clean,
 * and the build identity. `buildSha256` is the SHA-256 of the canonical JSON
 * `{ compiler: { name: "typescript", version }, outputs: [{ path: "dist/<file>.js", sha256 }] }`
 * over every `.js` file under `dist/`, sorted by path; it is only issued when a fresh compile of
 * the clean source with the lockfile-pinned compiler gives the same set of `.js` files with the
 * same bytes. Source maps and declarations are not part of it (maps embed the output location).
 */
async function checkSource(
  root: string,
  compile: NonNullable<PreflightDependencies['compile']>,
  problems: PreflightProblem[],
  paths: readonly string[] = EVALUATION_SOURCE_PATHS,
): Promise<SourceIdentity | null> {
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !samePath(canonicalPath(top.stdout.toString('utf8').trim()), canonicalPath(root))) {
    problems.push({ code: 'source-not-a-checkout', detail: `${root} is not the top level of a Git checkout` });
    return null;
  }
  const head = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const commit = head.stdout.toString('utf8').trim();
  if (head.code !== 0 || !COMMIT_SHA.test(commit)) {
    problems.push({ code: 'source-not-a-checkout', detail: `${root} has no commit checked out` });
    return null;
  }
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', ...paths]);
  if (status.code !== 0) {
    problems.push({ code: 'source-not-a-checkout', detail: `git status failed: ${status.stderr}` });
    return null;
  }
  const dirty = status.stdout.toString('utf8').split('\0').filter((entry) => entry.length > 0);
  if (dirty.length > 0) {
    problems.push({ code: 'source-dirty', detail: `Uncommitted, untracked or ignored files in the evaluation source: ${dirty.slice(0, 10).join('; ')}${dirty.length > 10 ? ` (and ${dirty.length - 10} more)` : ''}` });
    return null;
  }

  const typescriptVersion = compilerVersion(root, problems);
  if (typescriptVersion === null) return null;
  const dist = join(root, 'dist');
  const built = existsSync(dist) ? javascriptFiles(dist) : new Map<string, Buffer>();
  if (built.size === 0) {
    problems.push({ code: 'build-missing', detail: `${dist} holds no JavaScript; run npm run build at commit ${commit}` });
    return null;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'tracebound-preflight-build-'));
  try {
    try {
      await compile(root, scratch);
    } catch (error) {
      problems.push({ code: 'build-unverifiable', detail: `The source did not compile: ${messageOf(error)}` });
      return null;
    }
    const fresh = javascriptFiles(scratch);
    const differing = [...new Set([...built.keys(), ...fresh.keys()])]
      .sort(byPath)
      .filter((path) => !built.get(path)?.equals(fresh.get(path) ?? Buffer.alloc(0)) || !fresh.has(path));
    if (differing.length > 0) {
      problems.push({ code: 'build-stale', detail: `dist/ is not the build of commit ${commit}: ${differing.slice(0, 10).map((p) => `dist/${p}`).join(', ')}${differing.length > 10 ? ` (and ${differing.length - 10} more)` : ''}; run npm run build` });
      return null;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const outputs = [...built.entries()].sort(([a], [b]) => byPath(a, b)).map(([path, bytes]) => ({ path: `dist/${path}`, sha256: sha256Hex(bytes) }));
  return { commit, typescriptVersion, buildSha256: digestOf({ compiler: { name: 'typescript', version: typescriptVersion }, outputs }) };
}

/**
 * The checkout's commit and build identity for the publication step, established as for preflight
 * except that docs/evaluation/cochange may differ from the commit: it is where the results are
 * written, and a publication interrupted after its first file is completed by running it again.
 */
export async function checkPublicationSource(
  traceboundRoot: string,
  dependencies: Pick<PreflightDependencies, 'compile'> = {},
): Promise<{ status: 'verified'; commit: string; buildSha256: string } | { status: 'refused'; problems: PreflightProblem[] }> {
  const problems: PreflightProblem[] = [];
  const paths = EVALUATION_SOURCE_PATHS.filter((path) => path !== 'docs/evaluation/cochange');
  const source = await checkSource(traceboundRoot, dependencies.compile ?? compileWithInstalledTypescript, problems, paths);
  return source === null ? { status: 'refused', problems } : { status: 'verified', commit: source.commit, buildSha256: source.buildSha256 };
}

/** The installed TypeScript version, which must be the one package-lock.json pins. */
function compilerVersion(root: string, problems: PreflightProblem[]): string | null {
  try {
    const installed = JSON.parse(readFileSync(join(root, 'node_modules', 'typescript', 'package.json'), 'utf8')) as { version?: unknown };
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { version?: unknown }> };
    const pinned = lock.packages?.['node_modules/typescript']?.version;
    if (typeof installed.version !== 'string' || typeof pinned !== 'string' || installed.version !== pinned) {
      problems.push({ code: 'compiler-unverifiable', detail: `Installed TypeScript ${String(installed.version)} is not the locked ${String(pinned)}; run npm ci` });
      return null;
    }
    return installed.version;
  } catch (error) {
    problems.push({ code: 'compiler-unverifiable', detail: `Cannot read the installed or locked TypeScript version: ${messageOf(error)}` });
    return null;
  }
}

/** Every `.js` file under `dir`, keyed by its POSIX path relative to `dir`. */
function javascriptFiles(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), path);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.set(path, readFileSync(join(current, entry.name)));
    }
  };
  walk(dir, '');
  return files;
}

/** The production compile: the checkout's own TypeScript with tsconfig.build.json, into `outDir`. */
function compileWithInstalledTypescript(root: string, outDir: string): Promise<void> {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  return new Promise((resolvePromise, reject) => {
    execFile(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json'), '--outDir', outDir], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stdout}${stderr}`.trim()));
      else resolvePromise();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Work directory

async function checkWorkDirectory(
  config: PreflightConfig,
  manifest: CochangeManifest,
  identity: PreflightIdentity | null,
  problems: PreflightProblem[],
): Promise<WorkDirectoryState | null> {
  const path = canonicalPath(config.workDirectory);
  for (const [label, other] of [
    ['the Tracebound checkout', config.traceboundRoot],
    ['the dataset repository', config.repositoryPath],
  ] as const) {
    if (isWithin(path, canonicalPath(other))) {
      problems.push({ code: 'work-directory-unsafe', detail: `The work directory ${path} is inside ${label}` });
      return null;
    }
  }

  const exists = existsSync(path);
  if (exists && !statSync(path).isDirectory()) {
    problems.push({ code: 'work-directory-unsafe', detail: `${path} is not a directory` });
    return null;
  }
  const entries = exists ? readdirSync(path).sort(byPath) : [];
  const unexpected = entries.filter((entry) => !ALLOWED_WORK_ENTRIES.has(entry));
  if (unexpected.length > 0) problems.push({ code: 'work-directory-unexpected-entry', detail: `Unexpected entries in ${path}: ${unexpected.join(', ')}` });
  const present = (name: string) => entries.includes(name);

  const journal = (phase: JournalPhase, name: string): JournalState => {
    if (!present(name) && !present(`${name}.torn`)) return { state: 'absent' };
    if (!present(name)) return { state: 'invalid', reason: 'orphan-torn-artifact', detail: `${name}.torn exists without ${name}` };
    const header = identity === null ? null : headerFor(identity, phase);
    if (header === null) return { state: 'unverified' };
    return summarize(inspectJournal(join(path, name), { header, keys: journalKeys(manifest, phase) }));
  };
  const preparationJournal = journal('preparation', WORK_FILES.preparationJournal);
  const evaluationJournal = config.phase === 'evaluation' ? journal('evaluation', WORK_FILES.evaluationJournal) : present(WORK_FILES.evaluationJournal) || present(`${WORK_FILES.evaluationJournal}.torn`) ? ({ state: 'unverified' } as const) : ({ state: 'absent' } as const);
  const workingDatabase = present(WORK_FILES.workingDatabase) ? 'present' : 'absent';
  let frozenDatabase: WorkDirectoryState['frozenDatabase'] = { state: 'absent' };
  if (present(WORK_FILES.frozenDatabase)) {
    const file = await fileIdentity(join(path, WORK_FILES.frozenDatabase));
    frozenDatabase = { state: 'present', ...file, matchesRecorded: identity?.frozenDatabaseSha256 == null ? null : file.sha256 === identity.frozenDatabaseSha256 };
  }
  let freezeIdentity: WorkDirectoryState['freezeIdentity'] = 'absent';

  const refuseJournal = (name: string, state: JournalState) => {
    if (state.state === 'invalid') problems.push({ code: 'journal-invalid', detail: `${name}: ${state.reason}: ${state.detail}` });
    if (state.state === 'unverified' && identity !== null) problems.push({ code: 'journal-identity-unverifiable', detail: `${name} exists, but its identity cannot be checked without the embedding model id` });
  };

  if (config.phase === 'preparation') {
    refuseJournal(WORK_FILES.preparationJournal, preparationJournal);
    if (frozenDatabase.state === 'present') problems.push({ code: 'frozen-database-exists', detail: `${WORK_FILES.frozenDatabase} exists; preparation never overwrites or reuses it` });
    if (present(WORK_FILES.freezeIdentity) && frozenDatabase.state === 'absent') {
      problems.push({ code: 'freeze-identity-orphan', detail: `${WORK_FILES.freezeIdentity} exists without ${WORK_FILES.frozenDatabase}; it is never reused or replaced` });
    }
    if (evaluationJournal.state !== 'absent') problems.push({ code: 'evaluation-already-started', detail: `${WORK_FILES.evaluationJournal} exists; preparation cannot run again in this work directory` });
    if (preparationJournal.state === 'absent' && workingDatabase === 'present') {
      problems.push({ code: 'database-without-journal', detail: `${WORK_FILES.workingDatabase} exists without ${WORK_FILES.preparationJournal}; its contents cannot be accounted for` });
    }
  } else {
    refuseJournal(WORK_FILES.preparationJournal, preparationJournal);
    refuseJournal(WORK_FILES.evaluationJournal, evaluationJournal);
    if (preparationJournal.state !== 'valid' || preparationJournal.next !== null) {
      if (preparationJournal.state !== 'invalid' && preparationJournal.state !== 'unverified') {
        problems.push({ code: 'preparation-incomplete', detail: `${WORK_FILES.preparationJournal} is ${preparationJournal.state === 'valid' ? 'not finished' : preparationJournal.state}; evaluation needs a complete preparation` });
      }
    }
    if (identity !== null) {
      freezeIdentity = await checkFreezeIdentity(path, identity, frozenDatabase, config.frozenDatabaseSha256, problems);
    }
  }

  return { path, exists, preparationJournal, evaluationJournal, workingDatabase, frozenDatabase, freezeIdentity };
}

/**
 * The evaluation phase's check of the frozen database: its freeze identity must exist, be bound to this
 * run and to the preparation journal's bytes, and describe the database file's bytes. The caller's own
 * expected hash, if any, must be the identity's. Shallow: the database's structure is read by the evaluation.
 */
async function checkFreezeIdentity(
  directory: string,
  identity: PreflightIdentity,
  frozenDatabase: WorkDirectoryState['frozenDatabase'],
  suppliedSha256: string | undefined,
  problems: PreflightProblem[],
): Promise<WorkDirectoryState['freezeIdentity']> {
  const identityPresent = existsSync(join(directory, WORK_FILES.freezeIdentity));
  if (!identityPresent) {
    if (frozenDatabase.state === 'absent') problems.push({ code: 'frozen-database-missing', detail: `${WORK_FILES.frozenDatabase} does not exist` });
    else {
      problems.push({
        code: 'freeze-identity-missing',
        detail: `${WORK_FILES.frozenDatabase} exists without ${WORK_FILES.freezeIdentity}: it was not published by a finished preparation and is not trusted. Inspect it, remove it by hand and run the preparation again`,
      });
    }
    return 'absent';
  }
  if (identity.embedding.modelId === null) {
    problems.push({ code: 'freeze-identity-mismatch', detail: `${WORK_FILES.freezeIdentity} cannot be checked without the embedding model id` });
    return 'refused';
  }
  const bindings: FreezeBindings = {
    protocolVersion: identity.protocolVersion,
    manifestSha256: identity.manifestSha256,
    repository: identity.repository,
    tracebound: { commit: identity.tracebound.commit, sourceClean: identity.tracebound.sourceClean, buildSha256: identity.tracebound.buildSha256 },
    nodeVersion: identity.nodeVersion,
    embeddingModelId: identity.embedding.modelId,
  };
  const verification = await verifyFreezeIdentity(
    { identity: join(directory, WORK_FILES.freezeIdentity), database: join(directory, WORK_FILES.frozenDatabase), preparationJournal: join(directory, WORK_FILES.preparationJournal) },
    bindings,
    { deep: false },
  );
  if (verification.status === 'refused') {
    const code: PreflightCode =
      verification.reason === 'malformed'
        ? 'freeze-identity-malformed'
        : verification.reason === 'database-missing'
          ? 'frozen-database-missing'
          : verification.reason === 'database-mismatch' || verification.reason === 'database-inconsistent'
            ? 'frozen-database-mismatch'
            : 'freeze-identity-mismatch';
    problems.push({ code, detail: verification.detail });
    return 'refused';
  }
  if (verification.status === 'absent') return 'absent';
  if (suppliedSha256 !== undefined && suppliedSha256 !== verification.identity.database.sha256) {
    problems.push({ code: 'frozen-database-mismatch', detail: 'The expected frozen database SHA-256 supplied by the caller is not the one recorded in the freeze identity' });
    return 'refused';
  }
  return 'verified';
}

function summarize(inspection: JournalInspection): JournalState {
  switch (inspection.status) {
    case 'valid':
      return { state: 'valid', recorded: inspection.journal.records.length, next: inspection.journal.next, previousRecovery: inspection.previousRecovery !== null };
    case 'interrupted':
      return { state: 'interrupted', recorded: inspection.records.length, next: inspection.next, tornBytes: inspection.torn.bytes, headerTorn: inspection.torn.headerTorn, artifact: inspection.artifact };
    case 'invalid':
      return { state: 'invalid', reason: inspection.reason, detail: inspection.detail };
  }
}

/** The journal header for `phase`, or null while the embedding model id is unknown. */
export function headerFor(identity: PreflightIdentity, phase: JournalPhase): JournalHeader | null {
  if (identity.embedding.modelId === null) return null;
  const common = {
    kind: 'header' as const,
    schema: 'tracebound.cochange.journal' as const,
    schemaVersion: '1.0.0' as const,
    protocolVersion: identity.protocolVersion,
    manifestSha256: identity.manifestSha256,
    repository: identity.repository,
    tracebound: { commit: identity.tracebound.commit, sourceClean: identity.tracebound.sourceClean, buildSha256: identity.tracebound.buildSha256 },
    nodeVersion: identity.nodeVersion,
    embeddingModelId: identity.embedding.modelId,
  };
  if (phase === 'preparation') return { ...common, phase };
  if (identity.frozenDatabaseSha256 === null) return null;
  return { ...common, phase, frozenDatabaseSha256: identity.frozenDatabaseSha256 };
}

// ---------------------------------------------------------------------------------------------
// Paths and Git

/**
 * The canonical form of `path`: absolute, with every existing component's symlinks and junctions
 * resolved (realpath of the deepest existing ancestor, then the remaining components unchanged).
 */
export function canonicalPath(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(existsSync(existing) ? realpathSync.native(existing) : existing, ...rest);
}

function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}

/** Whether `path` is `container` or inside it (both canonical). Case-insensitive where the platform's paths are. */
export function isWithin(path: string, container: string): boolean {
  const rel = relative(container, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function git(cwd: string, args: readonly string[]): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  return new Promise((resolvePromise) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'buffer', env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolvePromise({ code, stdout, stderr: stderr.toString('utf8') });
    });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
