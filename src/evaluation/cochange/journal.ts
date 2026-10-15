import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';
import { assertPortablePath, canonicalJson, sha256Hex } from '../m9/canonical.js';
import { PROTOCOL, type CochangeManifest } from './selector.js';

// The append-only journals of the co-change evaluation: one for preparing the base snapshots, one
// for evaluating the selected commits. Each is a header line followed by one terminal record per
// base or commit, in manifest order, every line canonical JSON ending in "\n" and fsynced before
// the append returns.
//
// A recorded success or failure is final: it is never retried, replaced or reinterpreted, and a
// resumed run continues at the first manifest item without a record. The only damage repaired is a
// torn last line (a crash while appending), and only by the explicit `recoverJournal`: its bytes
// are kept in `<journal>.torn`, never parsed, and the journal is cut back to its last complete
// line. `inspectJournal` never changes a file. Anything else wrong makes the journal invalid.
//
// Single writer: a journal must have one writer at a time, and this module cannot enforce that
// across processes (Node has no portable file lock). The entry point that runs a phase must hold
// an exclusive lock on the work directory from inspection to its last append; see CochangeJournal.
//
// Paths in evidence follow one convention so they can be checked: a key named `path` or ending in
// `Path` holds a portable repository path, and a key named `paths` or ending in `Paths` holds an
// array of them. Error messages are kept verbatim and are not checked.

export const JOURNAL_SCHEMA = 'tracebound.cochange.journal';
export const JOURNAL_SCHEMA_VERSION = '1.0.0';
export const JOURNAL_PHASES = ['preparation', 'evaluation'] as const;
export type JournalPhase = (typeof JOURNAL_PHASES)[number];

export const PREPARATION_STAGES = ['ingestion', 'lexical-index', 'structural-index', 'semantic-index'] as const;
export const EVALUATION_METHODS = ['hybrid', 'deterministic', 'semantic', 'sibling', 'no-description'] as const;
export const EVALUATION_STAGES = ['preparation', 'retrieval', 'analysis'] as const;

type JsonObject = { [key: string]: unknown };

interface HeaderCommon {
  kind: 'header';
  schema: typeof JOURNAL_SCHEMA;
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  protocolVersion: string;
  manifestSha256: string;
  repository: { name: string; head: string };
  tracebound: {
    commit: string;
    /** The source tree matched `commit` (no uncommitted changes under src/). */
    sourceClean: boolean;
    /** SHA-256 identifying the build that ran. */
    buildSha256: string;
  };
  nodeVersion: string;
  embeddingModelId: string;
}

export interface PreparationHeader extends HeaderCommon {
  phase: 'preparation';
}

export interface EvaluationHeader extends HeaderCommon {
  phase: 'evaluation';
  /** SHA-256 of the frozen database the evaluation reads. */
  frozenDatabaseSha256: string;
}

export type JournalHeader = PreparationHeader | EvaluationHeader;

export interface PreparationFailure {
  stage: (typeof PREPARATION_STAGES)[number];
  errorName: string;
  message: string;
}

export interface EvaluationFailure {
  method: (typeof EVALUATION_METHODS)[number];
  stage: (typeof EVALUATION_STAGES)[number];
  errorName: string;
  message: string;
}

/** The terminal result of preparing one base snapshot. `failed` has exactly one failure: preparation stops at it. */
export interface PreparationRecord {
  kind: 'record';
  phase: 'preparation';
  base: string;
  status: 'succeeded' | 'failed';
  failures: PreparationFailure[];
  evidence: JsonObject;
}

/** The terminal result of evaluating one selected commit. `failed` lists every method that failed. */
export interface EvaluationRecord {
  kind: 'record';
  phase: 'evaluation';
  commit: string;
  status: 'succeeded' | 'failed';
  failures: EvaluationFailure[];
  evidence: JsonObject;
}

export type JournalRecord = PreparationRecord | EvaluationRecord;

/** What a journal must be: its exact header and its keys (base or commit SHAs) in manifest order. */
export interface ExpectedJournal {
  header: JournalHeader;
  keys: readonly string[];
}

export class JournalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalValidationError';
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NODE_VERSION = /^v\d+\.\d+\.\d+$/;

/** The keys of a journal in manifest order: each base once (first occurrence) or each selected commit. */
export function journalKeys(manifest: Pick<CochangeManifest, 'commits'>, phase: JournalPhase): string[] {
  const keys = manifest.commits.map((commit) => (phase === 'preparation' ? commit.base : commit.sha));
  return [...new Set(keys)];
}

/** The key a record is filed under. */
export function recordKey(record: JournalRecord): string {
  return record.phase === 'preparation' ? record.base : record.commit;
}

// ---------------------------------------------------------------------------------------------
// Validation (pure)

function fail(at: string, message: string): never {
  throw new JournalValidationError(`${at}: ${message}`);
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function object(value: unknown, at: string, keys: readonly string[]): JsonObject {
  if (!isPlainObject(value)) fail(at, 'is not an object');
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.includes(key));
  if (unknown.length > 0) fail(at, `has unsupported field(s) ${unknown.join(', ')}`);
  const missing = keys.filter((key) => !actual.includes(key));
  if (missing.length > 0) fail(at, `is missing field(s) ${missing.join(', ')}`);
  return value as JsonObject;
}

function exact<T extends string>(value: unknown, at: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(at, `must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
  return value as T;
}

function matching(value: unknown, at: string, pattern: RegExp, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(at, `must be ${what}, got ${JSON.stringify(value)}`);
  return value;
}

function text(value: unknown, at: string, nonEmpty: boolean): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) fail(at, nonEmpty ? 'must be a non-empty string' : 'must be a string');
  return value;
}

/** Checks a header and returns it typed. Throws JournalValidationError. */
export function validateHeader(value: unknown): JournalHeader {
  const phase = exact((value as JsonObject | null)?.['phase'], 'header.phase', JOURNAL_PHASES);
  const common = ['kind', 'schema', 'schemaVersion', 'phase', 'protocolVersion', 'manifestSha256', 'repository', 'tracebound', 'nodeVersion', 'embeddingModelId'];
  const header = object(value, 'header', phase === 'evaluation' ? [...common, 'frozenDatabaseSha256'] : common);
  exact(header['kind'], 'header.kind', ['header']);
  exact(header['schema'], 'header.schema', [JOURNAL_SCHEMA]);
  exact(header['schemaVersion'], 'header.schemaVersion', [JOURNAL_SCHEMA_VERSION]);
  exact(header['protocolVersion'], 'header.protocolVersion', [PROTOCOL.version]);
  matching(header['manifestSha256'], 'header.manifestSha256', SHA256, 'a lowercase SHA-256');
  const repository = object(header['repository'], 'header.repository', ['name', 'head']);
  matching(repository['name'], 'header.repository.name', REPOSITORY_NAME, 'owner/name');
  matching(repository['head'], 'header.repository.head', COMMIT_SHA, 'a full lowercase commit SHA');
  const tracebound = object(header['tracebound'], 'header.tracebound', ['commit', 'sourceClean', 'buildSha256']);
  matching(tracebound['commit'], 'header.tracebound.commit', COMMIT_SHA, 'a full lowercase commit SHA');
  if (typeof tracebound['sourceClean'] !== 'boolean') fail('header.tracebound.sourceClean', 'must be a boolean');
  matching(tracebound['buildSha256'], 'header.tracebound.buildSha256', SHA256, 'a lowercase SHA-256');
  matching(header['nodeVersion'], 'header.nodeVersion', NODE_VERSION, 'a Node version such as v24.20.0');
  text(header['embeddingModelId'], 'header.embeddingModelId', true);
  if (phase === 'evaluation') matching(header['frozenDatabaseSha256'], 'header.frozenDatabaseSha256', SHA256, 'a lowercase SHA-256');
  return header as unknown as JournalHeader;
}

/** Checks a record of `phase` and returns it typed. Throws JournalValidationError. */
export function validateRecord(value: unknown, phase: JournalPhase): JournalRecord {
  const keyField = phase === 'preparation' ? 'base' : 'commit';
  const record = object(value, 'record', ['kind', 'phase', keyField, 'status', 'failures', 'evidence']);
  exact(record['kind'], 'record.kind', ['record']);
  exact(record['phase'], 'record.phase', [phase]);
  matching(record[keyField], `record.${keyField}`, COMMIT_SHA, 'a full lowercase commit SHA');
  const status = exact(record['status'], 'record.status', ['succeeded', 'failed']);
  if (!Array.isArray(record['failures'])) fail('record.failures', 'must be an array');
  const failures = record['failures'] as unknown[];
  failures.forEach((failure, i) => validateFailure(failure, phase, `record.failures[${i}]`));
  if (status === 'succeeded' && failures.length > 0) fail('record', 'a succeeded record has failures');
  if (status === 'failed' && failures.length === 0) fail('record', 'a failed record has no failure');
  if (phase === 'preparation' && failures.length > 1) fail('record.failures', 'preparation stops at its first failure');
  if (phase === 'evaluation') {
    const methods = failures.map((failure) => (failure as EvaluationFailure).method);
    if (new Set(methods).size !== methods.length) fail('record.failures', 'lists a method more than once');
  }
  if (!isPlainObject(record['evidence'])) fail('record.evidence', 'is not an object');
  validateEvidence(record['evidence'], 'record.evidence');
  return record as unknown as JournalRecord;
}

function validateFailure(value: unknown, phase: JournalPhase, at: string): void {
  if (phase === 'preparation') {
    const failure = object(value, at, ['stage', 'errorName', 'message']);
    exact(failure['stage'], `${at}.stage`, PREPARATION_STAGES);
    text(failure['errorName'], `${at}.errorName`, true);
    text(failure['message'], `${at}.message`, false);
  } else {
    const failure = object(value, at, ['method', 'stage', 'errorName', 'message']);
    exact(failure['method'], `${at}.method`, EVALUATION_METHODS);
    exact(failure['stage'], `${at}.stage`, EVALUATION_STAGES);
    text(failure['errorName'], `${at}.errorName`, true);
    text(failure['message'], `${at}.message`, false);
  }
}

/** Plain JSON only (canonicalJson rejects the rest), with the path-key convention checked. */
function validateEvidence(value: unknown, at: string): void {
  try {
    canonicalJson(value);
  } catch (error) {
    fail(at, error instanceof Error ? error.message : String(error));
  }
  const walk = (node: unknown, where: string): void => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${where}[${i}]`));
    if (typeof node !== 'object' || node === null) return;
    for (const [key, child] of Object.entries(node)) {
      const here = `${where}.${key}`;
      if (key === 'path' || key.endsWith('Path')) {
        if (child !== null) portable(child, here);
      } else if (key === 'paths' || key.endsWith('Paths')) {
        if (!Array.isArray(child)) fail(here, 'must be an array of paths');
        child.forEach((item, i) => portable(item, `${here}[${i}]`));
      } else {
        walk(child, here);
      }
    }
  };
  walk(value, at);
}

function portable(value: unknown, at: string): void {
  if (typeof value !== 'string') fail(at, 'must be a path string');
  try {
    assertPortablePath(value);
  } catch (error) {
    fail(at, error instanceof Error ? error.message : String(error));
  }
}

function validateExpected(expected: ExpectedJournal): JournalHeader {
  const header = validateHeader(expected.header);
  if (new Set(expected.keys).size !== expected.keys.length) fail('expected.keys', 'repeat a key');
  expected.keys.forEach((key, i) => matching(key, `expected.keys[${i}]`, COMMIT_SHA, 'a full lowercase commit SHA'));
  return header;
}

// ---------------------------------------------------------------------------------------------
// Parsing (pure)

export type InvalidReason =
  | 'not-utf8'
  | 'malformed-header'
  | 'header-mismatch'
  | 'malformed-record'
  | 'foreign-record'
  | 'duplicate-record'
  | 'out-of-order-record'
  /** The journal has a torn tail and `<journal>.torn` already holds different bytes. */
  | 'torn-artifact-conflict';

export type ParsedJournal =
  | {
      status: 'parsed';
      /** The journal's header, or the expected one when no complete header line exists yet. */
      header: JournalHeader;
      headerComplete: boolean;
      records: JournalRecord[];
      /** Bytes up to and including the last newline. */
      completeBytes: number;
      /** Bytes after the last newline, never parsed: empty for an empty file, null when the journal ends in a newline. */
      tornBytes: Buffer | null;
    }
  | { status: 'invalid'; reason: InvalidReason; line: number | null; detail: string };

/**
 * Parses journal bytes against what the journal must be. Complete lines are those ending in "\n";
 * bytes after the last "\n" are a torn line and are returned untouched, never parsed. A journal
 * with no complete line (empty, or only a torn header) parses with `headerComplete: false`, the
 * expected header and `completeBytes` 0. Every complete line must be canonical JSON: the header equal to the
 * expected one, then records whose keys are exactly the first keys in manifest order.
 */
export function parseJournal(bytes: Buffer, expected: ExpectedJournal): ParsedJournal {
  const expectedHeader = validateExpected(expected);
  const end = bytes.lastIndexOf(0x0a) + 1;
  const tornBytes = end === bytes.length ? null : Buffer.from(bytes.subarray(end));
  let complete: string;
  try {
    complete = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
  } catch {
    return { status: 'invalid', reason: 'not-utf8', line: null, detail: 'The complete lines are not valid UTF-8' };
  }
  const lines = complete.length === 0 ? [] : complete.slice(0, -1).split('\n');
  if (lines.length === 0) {
    return { status: 'parsed', header: expectedHeader, headerComplete: false, records: [], completeBytes: 0, tornBytes: tornBytes ?? Buffer.alloc(0) };
  }

  const canonicalLine = (line: string, lineNumber: number): unknown => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new JournalValidationError(`line ${lineNumber} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (canonicalJson(value) !== line) throw new JournalValidationError(`line ${lineNumber} is not canonical JSON`);
    return value;
  };

  let header: JournalHeader;
  try {
    header = validateHeader(canonicalLine(lines[0]!, 1));
  } catch (error) {
    return { status: 'invalid', reason: 'malformed-header', line: 1, detail: messageOf(error) };
  }
  if (canonicalJson(header) !== canonicalJson(expectedHeader)) {
    return { status: 'invalid', reason: 'header-mismatch', line: 1, detail: 'The journal was written for another run identity' };
  }

  const position = new Map(expected.keys.map((key, i) => [key, i]));
  const records: JournalRecord[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    let record: JournalRecord;
    try {
      record = validateRecord(canonicalLine(lines[i]!, lineNumber), header.phase);
    } catch (error) {
      return { status: 'invalid', reason: 'malformed-record', line: lineNumber, detail: messageOf(error) };
    }
    const key = recordKey(record);
    if (!position.has(key)) return { status: 'invalid', reason: 'foreign-record', line: lineNumber, detail: `${key} is not in the manifest` };
    if (seen.has(key)) return { status: 'invalid', reason: 'duplicate-record', line: lineNumber, detail: `${key} is recorded more than once` };
    if (position.get(key) !== records.length) {
      return { status: 'invalid', reason: 'out-of-order-record', line: lineNumber, detail: `${key} is recorded where ${expected.keys[records.length]} is expected` };
    }
    seen.add(key);
    records.push(record);
  }
  return { status: 'parsed', header, headerComplete: true, records, completeBytes: end, tornBytes };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// Files

/** The journal's bytes as inspected; recovery refuses to act on a file that no longer matches. */
export interface JournalSnapshot {
  bytes: number;
  sha256: string;
}

/** A torn last line: the bytes after the last newline, which are never parsed. */
export interface TornTail {
  /** Byte offset where the torn bytes start (the length of the complete lines). */
  offset: number;
  bytes: number;
  sha256: string;
  /** No complete header line exists: the torn bytes are a partial header, or the file is empty. */
  headerTorn: boolean;
}

/** An existing `<journal>.torn` file. */
export interface TornArtifact {
  path: string;
  bytes: number;
  sha256: string;
}

export type JournalInspection =
  /** Every line is complete and valid. `previousRecovery` reports a `.torn` file left by an earlier recovery. */
  | { status: 'valid'; journal: CochangeJournal; snapshot: JournalSnapshot; previousRecovery: TornArtifact | null }
  /**
   * The journal ends in a torn line (or is empty). Its complete records are valid and final; the
   * torn bytes are not a record. Nothing can be appended until `recoverJournal` succeeds.
   * `artifact` says how the torn bytes stand: nothing to keep, not yet kept, or already kept in an
   * identical `.torn` file (a recovery that stopped before cutting the journal).
   */
  | {
      status: 'interrupted';
      path: string;
      snapshot: JournalSnapshot;
      header: JournalHeader;
      records: readonly JournalRecord[];
      next: string | null;
      torn: TornTail;
      tornPath: string;
      artifact: 'not-needed' | 'absent' | 'identical';
    }
  /** The run must not continue with this journal. */
  | { status: 'invalid'; reason: InvalidReason; line: number | null; detail: string };

export type JournalRecoveryResult =
  | {
      status: 'recovered';
      journal: CochangeJournal;
      /** The torn bytes and where they are kept; `artifact` says whether this call wrote the copy. */
      recovery: TornTail & { tornPath: string; artifact: 'not-needed' | 'written' | 'already-kept'; headerRewritten: boolean };
    }
  /** The journal was not changed. */
  | { status: 'refused'; reason: 'stale-inspection' | 'torn-artifact-conflict'; detail: string };

/**
 * An open journal: its records so far and the next key to record. Appends go through `append`.
 *
 * Single-writer contract. Within one process every file operation here is synchronous, so a stale
 * handle (the file grew or shrank since this handle last read or wrote it, for example through
 * another handle or a recovery) is refused before anything is written. Between processes nothing
 * is guaranteed: the size check and the write are separate system calls, so a write by another
 * process in between can be overwritten, and a same-size replacement is not noticed. The caller
 * must hold an exclusive lock for the whole run; this module does not take one.
 */
export class CochangeJournal {
  readonly path: string;
  readonly header: JournalHeader;
  readonly keys: readonly string[];
  #records: JournalRecord[];
  #size: number;

  constructor(path: string, header: JournalHeader, keys: readonly string[], records: JournalRecord[], size: number) {
    this.path = path;
    this.header = header;
    this.keys = keys;
    this.#records = records;
    this.#size = size;
  }

  get phase(): JournalPhase {
    return this.header.phase;
  }

  get records(): readonly JournalRecord[] {
    return [...this.#records];
  }

  /** Keys with a terminal record, success or failure. These are never run again. */
  get completed(): ReadonlySet<string> {
    return new Set(this.#records.map(recordKey));
  }

  /** The first key in manifest order without a record, or null when every key is recorded. */
  get next(): string | null {
    return this.keys[this.#records.length] ?? null;
  }

  /** Keys still to record, in manifest order. */
  get remaining(): readonly string[] {
    return this.keys.slice(this.#records.length);
  }

  /**
   * Validates `record`, requires it to be the next key in manifest order (so a recorded success or
   * failure can never be recorded again), appends it as one canonical line and fsyncs before
   * returning. Refuses if the file's size is not what this handle last saw.
   */
  append(record: JournalRecord): void {
    const valid = validateRecord(record, this.phase);
    const key = recordKey(valid);
    if (this.completed.has(key)) throw new JournalValidationError(`${key} is already recorded`);
    if (!this.keys.includes(key)) throw new JournalValidationError(`${key} is not in the manifest`);
    if (key !== this.next) throw new JournalValidationError(`${key} is out of manifest order; ${this.next ?? 'nothing'} is next`);
    const line = Buffer.from(`${canonicalJson(valid)}\n`, 'utf8');
    // Keep a copy as written, so later changes to the caller's object cannot alter the record.
    const stored = JSON.parse(line.toString('utf8')) as JournalRecord;
    const fd = openSync(this.path, 'r+');
    try {
      if (fstatSync(fd).size !== this.#size) throw new JournalValidationError(`${this.path} changed on disk since this handle last read or wrote it`);
      writeAll(fd, line, this.#size);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#size += line.length;
    this.#records.push(stored);
  }
}

/** Creates a new journal holding only its header (fsynced). Refuses an existing file. */
export function createJournal(path: string, expected: ExpectedJournal): CochangeJournal {
  const header = validateExpected(expected);
  const line = Buffer.from(`${canonicalJson(header)}\n`, 'utf8');
  const fd = openSync(path, 'wx');
  try {
    writeAll(fd, line, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return new CochangeJournal(path, header, [...expected.keys], [], line.length);
}

/**
 * Reads an existing journal and reports its state. Never writes, creates or removes a file.
 *
 * - Complete lines that are invalid (malformed, foreign, duplicate, out of order, another run's
 *   header) make it `invalid`, whatever follows: corruption is never repaired.
 * - A torn last line, or an empty file, makes it `interrupted`, unless `<journal>.torn` exists with
 *   bytes other than the torn tail (a partial copy included): that is `invalid`
 *   (`torn-artifact-conflict`), for an operator to resolve; nothing is overwritten.
 * - Otherwise it is `valid`, with a handle for appending.
 */
export function inspectJournal(path: string, expected: ExpectedJournal): JournalInspection {
  const bytes = readFileSync(path);
  const parsed = parseJournal(bytes, expected);
  if (parsed.status === 'invalid') return parsed;
  const snapshot = { bytes: bytes.length, sha256: sha256Hex(bytes) };
  const tornPath = `${path}.torn`;
  const existing = existsSync(tornPath) ? readFileSync(tornPath) : null;

  if (parsed.tornBytes === null) {
    const journal = new CochangeJournal(path, parsed.header, [...expected.keys], parsed.records, bytes.length);
    const previousRecovery = existing === null ? null : { path: tornPath, bytes: existing.length, sha256: sha256Hex(existing) };
    return { status: 'valid', journal, snapshot, previousRecovery };
  }

  let artifact: 'not-needed' | 'absent' | 'identical';
  if (parsed.tornBytes.length === 0) artifact = 'not-needed';
  else if (existing === null) artifact = 'absent';
  else if (existing.equals(parsed.tornBytes)) artifact = 'identical';
  else {
    return {
      status: 'invalid',
      reason: 'torn-artifact-conflict',
      line: null,
      detail: `${tornPath} holds ${existing.length} bytes that differ from the journal's ${parsed.tornBytes.length} torn bytes; resolve it before resuming`,
    };
  }
  return {
    status: 'interrupted',
    path,
    snapshot,
    header: parsed.header,
    records: parsed.records,
    next: expected.keys[parsed.records.length] ?? null,
    torn: { offset: parsed.completeBytes, bytes: parsed.tornBytes.length, sha256: sha256Hex(parsed.tornBytes), headerTorn: !parsed.headerComplete },
    tornPath,
    artifact,
  };
}

/**
 * Recovers a journal that `inspectJournal` reported as `interrupted` under the same expectation:
 *
 * 1. The journal must still be byte-for-byte what was inspected (size and SHA-256), or nothing is
 *    changed (`stale-inspection`).
 * 2. Non-empty torn bytes are kept first: written to `<journal>.torn` (created exclusively),
 *    fsynced and read back. An identical existing `.torn` (an earlier recovery that stopped before
 *    step 3) is kept as is; a different one refuses the recovery.
 * 3. Only then is the journal cut back to its complete lines, the header written again when no
 *    complete header existed, and the journal fsynced.
 *
 * A crash after step 2 leaves an identical `.torn`, which the next inspection reports, and the
 * recovery can be repeated. A crash during step 2 can leave a partial `.torn`, which the next
 * inspection reports as a conflict. A crash during step 3 of a header recovery can leave an empty
 * journal, which is again `interrupted` with nothing to keep.
 */
export function recoverJournal(expected: ExpectedJournal, inspection: Extract<JournalInspection, { status: 'interrupted' }>): JournalRecoveryResult {
  const { path, tornPath } = inspection;
  const bytes = readFileSync(path);
  if (bytes.length !== inspection.snapshot.bytes || sha256Hex(bytes) !== inspection.snapshot.sha256) {
    return { status: 'refused', reason: 'stale-inspection', detail: `${path} changed since it was inspected` };
  }
  const parsed = parseJournal(bytes, expected);
  if (
    parsed.status !== 'parsed' ||
    parsed.tornBytes === null ||
    parsed.completeBytes !== inspection.torn.offset ||
    canonicalJson(parsed.header) !== canonicalJson(inspection.header)
  ) {
    return { status: 'refused', reason: 'stale-inspection', detail: `The inspection does not describe ${path} under this expectation` };
  }
  const torn = parsed.tornBytes;

  let artifact: 'not-needed' | 'written' | 'already-kept' = 'not-needed';
  if (torn.length > 0) {
    if (existsSync(tornPath)) {
      if (!readFileSync(tornPath).equals(torn)) {
        return { status: 'refused', reason: 'torn-artifact-conflict', detail: `${tornPath} holds other bytes than the torn tail` };
      }
      artifact = 'already-kept';
    } else {
      const tornFd = openSync(tornPath, 'wx');
      try {
        writeAll(tornFd, torn, 0);
        fsyncSync(tornFd);
      } finally {
        closeSync(tornFd);
      }
      if (!readFileSync(tornPath).equals(torn)) throw new Error(`${tornPath} does not hold the torn bytes after writing them`);
      artifact = 'written';
    }
  }

  const headerRewritten = !parsed.headerComplete;
  let size = parsed.completeBytes;
  const fd = openSync(path, 'r+');
  try {
    if (fstatSync(fd).size !== bytes.length) {
      return { status: 'refused', reason: 'stale-inspection', detail: `${path} changed during recovery; its torn bytes are kept in ${tornPath}` };
    }
    ftruncateSync(fd, parsed.completeBytes);
    if (headerRewritten) {
      const line = Buffer.from(`${canonicalJson(parsed.header)}\n`, 'utf8');
      writeAll(fd, line, 0);
      size = line.length;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return {
    status: 'recovered',
    journal: new CochangeJournal(path, parsed.header, [...expected.keys], parsed.records, size),
    recovery: { ...inspection.torn, tornPath, artifact, headerRewritten },
  };
}

function writeAll(fd: number, data: Buffer, position: number): void {
  let written = 0;
  while (written < data.length) written += writeSync(fd, data, written, data.length - written, position + written);
}

