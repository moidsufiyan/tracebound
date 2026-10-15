import { existsSync, readFileSync } from 'node:fs';
import { canonicalBytes, canonicalJson, sha256Hex } from '../m9/canonical.js';
import { checkDatabase, fileIdentity, tableDigests, type TableDigest } from '../m9/freeze-database.js';
import { writeArtifacts, type PublishedArtifact } from './artifact-files.js';
import type { WorkLock } from './lock.js';

// The durable identity of the frozen preparation database: `frozen.identity.json` in the work
// directory, written by the preparation after it has created and verified `frozen.sqlite`, and
// read, never trusted, by every later phase.
//
// What it binds: the frozen database's bytes (SHA-256 and size) and structure (schema version,
// journal mode, integrity result, page counts, and a digest of every table); the complete preparation
// journal (SHA-256 of its bytes and the counts of its records); and the run's identity: protocol,
// manifest, repository and head, Tracebound commit, source cleanliness and build, Node version and
// embedding model id. It holds no absolute paths.
//
// Verification recomputes everything it can. The shallow form (used by the preflight) hashes the
// database file and the preparation journal and checks the bindings; the deep form (used by the
// evaluation before it opens the database) also reads the database's own structure and table
// digests. A recorded value is never accepted because it is recorded.
//
// Crash window: the preparation freezes the database first and publishes the identity second. A
// crash between the two leaves `frozen.sqlite` without an identity. That is refused, never repaired:
// nothing here reconstructs or adopts a frozen database from its name. The documented recovery is
// manual: inspect the refusal (it says whether the file's rows equal the working database's), remove
// `frozen.sqlite` by hand, and run the preparation again; with every base already recorded it
// verifies the working database, freezes a new copy and publishes the identity. The same holds for a
// leftover temporary file `.frozen.identity.json.<id>.tmp`: it is an unexpected entry that the
// preflight refuses until an operator removes it.

export const FREEZE_IDENTITY_FILE = 'frozen.identity.json';
export const FREEZE_IDENTITY_SCHEMA = 'tracebound.cochange.freeze-identity';
export const FREEZE_IDENTITY_VERSION = '1.0.0';

/** The run identity a freeze identity must be bound to; the same facts the journal headers carry. */
export interface FreezeBindings {
  protocolVersion: string;
  manifestSha256: string;
  repository: { name: string; head: string };
  tracebound: { commit: string; sourceClean: boolean; buildSha256: string };
  nodeVersion: string;
  embeddingModelId: string;
}

export interface FreezeIdentity extends FreezeBindings {
  schema: typeof FREEZE_IDENTITY_SCHEMA;
  schemaVersion: typeof FREEZE_IDENTITY_VERSION;
  preparation: { journalSha256: string; bases: number; succeeded: number; failed: number };
  database: {
    /** The file name inside the work directory. */
    file: string;
    sha256: string;
    bytes: number;
    userVersion: number;
    journalMode: string;
    integrityCheck: string;
    pageSize: number;
    pageCount: number;
    tables: TableDigest[];
  };
}

export type FreezeIdentityInput = Omit<FreezeIdentity, 'schema' | 'schemaVersion'>;

/** The run-identity part of an identity, to compare another identity or a verification against. */
export function bindingsOf(source: FreezeBindings): FreezeBindings {
  const { protocolVersion, manifestSha256, repository, tracebound, nodeVersion, embeddingModelId } = source;
  return { protocolVersion, manifestSha256, repository, tracebound, nodeVersion, embeddingModelId };
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NODE_VERSION = /^v\d+\.\d+\.\d+$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FILE_NAME = /^[A-Za-z0-9_.-]+$/;

/** Builds a freeze identity, refusing facts that cannot describe a verified frozen database. */
export function buildFreezeIdentity(input: FreezeIdentityInput): FreezeIdentity {
  const identity: FreezeIdentity = { schema: FREEZE_IDENTITY_SCHEMA, schemaVersion: FREEZE_IDENTITY_VERSION, ...input };
  const problem = validateIdentity(identity);
  if (problem !== null) throw new RangeError(`Not a freeze identity: ${problem}`);
  return identity;
}

/** The canonical bytes of the identity, as written to the file (no trailing newline). */
export function serializeFreezeIdentity(identity: FreezeIdentity): Buffer {
  return canonicalBytes(identity);
}

export type ParsedFreezeIdentity = { status: 'ok'; identity: FreezeIdentity } | { status: 'malformed'; detail: string };

/** Parses the bytes of an identity file: strict schema, and the exact canonical form. */
export function parseFreezeIdentity(bytes: Buffer): ParsedFreezeIdentity {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { status: 'malformed', detail: 'The freeze identity is not valid UTF-8' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: 'malformed', detail: 'The freeze identity is not JSON' };
  }
  let canonical: string;
  try {
    canonical = canonicalJson(value);
  } catch (error) {
    return { status: 'malformed', detail: error instanceof Error ? error.message : String(error) };
  }
  if (canonical !== text) return { status: 'malformed', detail: 'The freeze identity is not canonical JSON' };
  const problem = validateIdentity(value);
  return problem === null ? { status: 'ok', identity: value as FreezeIdentity } : { status: 'malformed', detail: problem };
}

function keysAre(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

const isSafeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Null when `value` is a well-formed freeze identity, otherwise what is wrong with it. */
function validateIdentity(value: unknown): string | null {
  if (!keysAre(value, ['schema', 'schemaVersion', 'protocolVersion', 'manifestSha256', 'repository', 'tracebound', 'nodeVersion', 'embeddingModelId', 'preparation', 'database'])) return 'unexpected or missing fields';
  if (value['schema'] !== FREEZE_IDENTITY_SCHEMA || value['schemaVersion'] !== FREEZE_IDENTITY_VERSION) return 'unsupported schema or version';
  if (typeof value['protocolVersion'] !== 'string' || value['protocolVersion'] === '') return 'protocolVersion';
  if (typeof value['manifestSha256'] !== 'string' || !SHA256.test(value['manifestSha256'])) return 'manifestSha256';
  const repository = value['repository'];
  if (!keysAre(repository, ['name', 'head']) || typeof repository['name'] !== 'string' || !REPOSITORY_NAME.test(repository['name']) || typeof repository['head'] !== 'string' || !COMMIT.test(repository['head'])) return 'repository';
  const tracebound = value['tracebound'];
  if (!keysAre(tracebound, ['commit', 'sourceClean', 'buildSha256']) || typeof tracebound['commit'] !== 'string' || !COMMIT.test(tracebound['commit']) || typeof tracebound['sourceClean'] !== 'boolean' || typeof tracebound['buildSha256'] !== 'string' || !SHA256.test(tracebound['buildSha256'])) return 'tracebound';
  if (typeof value['nodeVersion'] !== 'string' || !NODE_VERSION.test(value['nodeVersion'])) return 'nodeVersion';
  if (typeof value['embeddingModelId'] !== 'string' || value['embeddingModelId'] === '') return 'embeddingModelId';
  const preparation = value['preparation'];
  if (!keysAre(preparation, ['journalSha256', 'bases', 'succeeded', 'failed']) || typeof preparation['journalSha256'] !== 'string' || !SHA256.test(preparation['journalSha256'])) return 'preparation';
  if (!isSafeCount(preparation['bases']) || !isSafeCount(preparation['succeeded']) || !isSafeCount(preparation['failed']) || preparation['succeeded'] + preparation['failed'] !== preparation['bases'] || preparation['bases'] === 0) return 'preparation counts';
  const database = value['database'];
  if (!keysAre(database, ['file', 'sha256', 'bytes', 'userVersion', 'journalMode', 'integrityCheck', 'pageSize', 'pageCount', 'tables'])) return 'database fields';
  if (typeof database['file'] !== 'string' || !FILE_NAME.test(database['file'])) return 'database file name (a name, never a path)';
  if (typeof database['sha256'] !== 'string' || !SHA256.test(database['sha256'])) return 'database sha256';
  if (!isSafeCount(database['bytes']) || database['bytes'] === 0 || !isSafeCount(database['userVersion']) || !isSafeCount(database['pageSize']) || !isSafeCount(database['pageCount'])) return 'database sizes';
  if (database['journalMode'] !== 'delete') return 'database journal mode (a frozen database is in delete mode)';
  if (database['integrityCheck'] !== 'ok') return 'database integrity check';
  const tables = database['tables'];
  if (!Array.isArray(tables) || tables.length === 0) return 'database tables';
  for (const table of tables) {
    if (!keysAre(table, ['name', 'rows', 'sha256']) || typeof table['name'] !== 'string' || table['name'] === '' || !isSafeCount(table['rows']) || typeof table['sha256'] !== 'string' || !SHA256.test(table['sha256'])) return 'a table digest';
  }
  return null;
}

export type FreezeIdentityRefusal = 'malformed' | 'run-mismatch' | 'journal-mismatch' | 'database-missing' | 'database-mismatch' | 'database-inconsistent';

export type FreezeVerification =
  /** No identity file exists. */
  | { status: 'absent' }
  /** Every check passed; `deep` says whether the database's own structure and table digests were recomputed too. */
  | { status: 'verified'; identity: FreezeIdentity; deep: boolean }
  | { status: 'refused'; reason: FreezeIdentityRefusal; detail: string };

export interface FreezeFiles {
  /** The identity file, the frozen database and the complete preparation journal. */
  identity: string;
  database: string;
  preparationJournal: string;
}

/**
 * Recomputes what a freeze identity claims: its bindings against `bindings`, the preparation journal's
 * bytes, the database file's bytes and, when `deep`, the database's structure and table digests.
 * Reads only. A missing identity is `absent`; any disagreement is a `refused` with its reason.
 */
export async function verifyFreezeIdentity(files: FreezeFiles, bindings: FreezeBindings, options: { deep: boolean }): Promise<FreezeVerification> {
  if (!existsSync(files.identity)) return { status: 'absent' };
  const parsed = parseFreezeIdentity(readFileSync(files.identity));
  if (parsed.status === 'malformed') return { status: 'refused', reason: 'malformed', detail: parsed.detail };
  const { identity } = parsed;

  const mismatch = (Object.keys(bindings) as (keyof FreezeBindings)[]).find((key) => canonicalJson(identity[key]) !== canonicalJson(bindings[key]));
  if (mismatch !== undefined) return { status: 'refused', reason: 'run-mismatch', detail: `The freeze identity was made for another run: ${mismatch} differs` };

  if (!existsSync(files.preparationJournal)) return { status: 'refused', reason: 'journal-mismatch', detail: 'The preparation journal the identity names is missing' };
  if (sha256Hex(readFileSync(files.preparationJournal)) !== identity.preparation.journalSha256) {
    return { status: 'refused', reason: 'journal-mismatch', detail: 'The preparation journal is not the one the freeze identity was made from' };
  }

  if (!existsSync(files.database)) return { status: 'refused', reason: 'database-missing', detail: `${identity.database.file} does not exist` };
  const actual = await fileIdentity(files.database);
  if (actual.sha256 !== identity.database.sha256 || actual.bytes !== identity.database.bytes) {
    return { status: 'refused', reason: 'database-mismatch', detail: `${identity.database.file} is not the database the freeze identity describes (SHA-256 or size differs)` };
  }

  if (options.deep) {
    try {
      const check = checkDatabase(files.database);
      const same =
        check.userVersion === identity.database.userVersion &&
        check.journalMode === identity.database.journalMode &&
        check.integrityCheck === identity.database.integrityCheck &&
        check.foreignKeyViolations === 0 &&
        check.pageSize === identity.database.pageSize &&
        check.pageCount === identity.database.pageCount;
      if (!same) return { status: 'refused', reason: 'database-inconsistent', detail: `${identity.database.file} has other structure than the freeze identity records` };
      if (canonicalJson(tableDigests(files.database)) !== canonicalJson(identity.database.tables)) {
        return { status: 'refused', reason: 'database-inconsistent', detail: `${identity.database.file} holds other table contents than the freeze identity records` };
      }
    } catch (error) {
      return { status: 'refused', reason: 'database-inconsistent', detail: `${identity.database.file} cannot be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { status: 'verified', identity, deep: options.deep };
}

/** The identity's claim about the database hash, for building a journal header before verification; null if absent or malformed. */
export function claimedDatabaseSha256(identityFile: string): string | null {
  if (!existsSync(identityFile)) return null;
  const parsed = parseFreezeIdentity(readFileSync(identityFile));
  return parsed.status === 'ok' ? parsed.identity.database.sha256 : null;
}

/**
 * Publishes the identity into the work directory without replacing an existing one: temporary file,
 * fsync, hard link, read-back (artifact-files.ts). The lock is verified before and after.
 */
export function publishFreezeIdentity(
  directory: string,
  identity: FreezeIdentity,
  lock: WorkLock,
  beforeLink?: (name: string) => void,
): ReturnType<typeof writeArtifacts> {
  return writeArtifacts(directory, [{ name: FREEZE_IDENTITY_FILE, bytes: serializeFreezeIdentity(identity) }], lock, beforeLink);
}

export type { PublishedArtifact };
