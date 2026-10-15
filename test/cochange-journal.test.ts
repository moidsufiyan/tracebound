import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../src/evaluation/m9/canonical.js';
import {
  CochangeJournal,
  createJournal,
  journalKeys,
  inspectJournal,
  JournalValidationError,
  parseJournal,
  recoverJournal,
  validateHeader,
  validateRecord,
  type EvaluationHeader,
  type EvaluationRecord,
  type ExpectedJournal,
  type JournalInspection,
  type PreparationHeader,
  type PreparationRecord,
} from '../src/evaluation/cochange/journal.js';

const sha = (digit: string) => digit.repeat(40);
const hash = (digit: string) => digit.repeat(64);
const COMMITS = [sha('1'), sha('2'), sha('3')];
const BASES = [sha('a'), sha('b'), sha('c')];

const preparationHeader: PreparationHeader = {
  kind: 'header',
  schema: 'tracebound.cochange.journal',
  schemaVersion: '1.0.0',
  phase: 'preparation',
  protocolVersion: '1.0.0',
  manifestSha256: hash('d'),
  repository: { name: 'owner/repo', head: sha('f') },
  tracebound: { commit: sha('e'), sourceClean: true, buildSha256: hash('b') },
  nodeVersion: 'v24.20.0',
  embeddingModelId: 'fake:model',
};
const evaluationHeader: EvaluationHeader = { ...preparationHeader, phase: 'evaluation', frozenDatabaseSha256: hash('c') };

const evaluation: ExpectedJournal = { header: evaluationHeader, keys: COMMITS };
const preparation: ExpectedJournal = { header: preparationHeader, keys: BASES };

const succeeded = (commit: string, evidence: Record<string, unknown> = {}): EvaluationRecord => ({
  kind: 'record',
  phase: 'evaluation',
  commit,
  status: 'succeeded',
  failures: [],
  evidence,
});
const failed = (commit: string): EvaluationRecord => ({
  kind: 'record',
  phase: 'evaluation',
  commit,
  status: 'failed',
  failures: [{ method: 'hybrid', stage: 'retrieval', errorName: 'EmbeddingProviderError', message: 'Cannot reach Ollama' }],
  evidence: {},
});
const prepared = (base: string): PreparationRecord => ({ kind: 'record', phase: 'preparation', base, status: 'succeeded', failures: [], evidence: { snapshotId: 1 } });

const line = (value: unknown) => `${canonicalJson(value)}\n`;

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracebound-journal-'));
  path = join(dir, 'eval.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function valid(result: JournalInspection) {
  if (result.status !== 'valid') throw new Error(`expected a valid journal, got ${JSON.stringify(result)}`);
  return result;
}
function interrupted(result: JournalInspection) {
  if (result.status !== 'interrupted') throw new Error(`expected an interrupted journal, got ${JSON.stringify(result)}`);
  return result;
}
/** Every file in the test directory with its bytes, to show an operation changed nothing. */
function files(): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name)).toString('base64')]));
}

describe('journal keys', () => {
  it('lists bases once, in first-occurrence order, and commits in manifest order', () => {
    const manifest = { commits: [{ sha: sha('1'), base: sha('a') }, { sha: sha('2'), base: sha('b') }, { sha: sha('3'), base: sha('a') }] } as never;
    expect(journalKeys(manifest, 'preparation')).toEqual([sha('a'), sha('b')]);
    expect(journalKeys(manifest, 'evaluation')).toEqual([sha('1'), sha('2'), sha('3')]);
  });
});

describe('header and record validation', () => {
  it('accepts both phases', () => {
    expect(validateHeader(preparationHeader)).toEqual(preparationHeader);
    expect(validateHeader(evaluationHeader)).toEqual(evaluationHeader);
  });

  it.each([
    ['an unknown phase', { ...preparationHeader, phase: 'other' }],
    ['another schema version', { ...preparationHeader, schemaVersion: '2.0.0' }],
    ['another protocol version', { ...preparationHeader, protocolVersion: '1.1.0' }],
    ['an uppercase manifest hash', { ...preparationHeader, manifestSha256: hash('D') }],
    ['a short manifest hash', { ...preparationHeader, manifestSha256: 'abc' }],
    ['an abbreviated head', { ...preparationHeader, repository: { name: 'owner/repo', head: 'f'.repeat(12) } }],
    ['a repository without owner', { ...preparationHeader, repository: { name: 'repo', head: sha('f') } }],
    ['a string for sourceClean', { ...preparationHeader, tracebound: { ...preparationHeader.tracebound, sourceClean: 'yes' } }],
    ['a malformed build hash', { ...preparationHeader, tracebound: { ...preparationHeader.tracebound, buildSha256: hash('g') } }],
    ['a malformed Node version', { ...preparationHeader, nodeVersion: '24' }],
    ['an empty model id', { ...preparationHeader, embeddingModelId: '' }],
    ['an unknown field', { ...preparationHeader, extra: 1 }],
    ['a missing field', (({ nodeVersion: _, ...rest }) => rest)(preparationHeader)],
    ['a frozen database hash in a preparation header', { ...preparationHeader, frozenDatabaseSha256: hash('c') }],
    ['an evaluation header without the frozen database', { ...preparationHeader, phase: 'evaluation' }],
    ['a malformed frozen database hash', { ...evaluationHeader, frozenDatabaseSha256: 'x' }],
  ])('rejects a header with %s', (_label, value) => {
    expect(() => validateHeader(value)).toThrow(JournalValidationError);
  });

  it('accepts success and failure records of each phase', () => {
    expect(validateRecord(succeeded(sha('1')), 'evaluation')).toEqual(succeeded(sha('1')));
    expect(validateRecord(failed(sha('1')), 'evaluation')).toEqual(failed(sha('1')));
    expect(validateRecord(prepared(sha('a')), 'preparation')).toEqual(prepared(sha('a')));
    const prepFailure: PreparationRecord = { ...prepared(sha('a')), status: 'failed', failures: [{ stage: 'semantic-index', errorName: 'EmbeddingProviderError', message: '' }] };
    expect(validateRecord(prepFailure, 'preparation')).toEqual(prepFailure);
  });

  it.each([
    ['the other phase', { ...succeeded(sha('1')), phase: 'preparation' }],
    ['an abbreviated commit', succeeded('1234567')],
    ['an unknown status', { ...succeeded(sha('1')), status: 'skipped' }],
    ['success with failures', { ...failed(sha('1')), status: 'succeeded' }],
    ['failure without failures', { ...succeeded(sha('1')), status: 'failed' }],
    ['an unknown method', { ...failed(sha('1')), failures: [{ method: 'bm25', stage: 'retrieval', errorName: 'E', message: '' }] }],
    ['an empty error name', { ...failed(sha('1')), failures: [{ method: 'hybrid', stage: 'retrieval', errorName: '', message: '' }] }],
    ['a method failing twice', { ...failed(sha('1')), failures: [failed(sha('1')).failures[0], failed(sha('1')).failures[0]] }],
    ['evidence that is not an object', { ...succeeded(sha('1')), evidence: [] }],
    ['evidence with a non-JSON number', succeeded(sha('1'), { score: Number.NaN })],
    ['an absolute path', succeeded(sha('1'), { targetPath: '/home/me/repo/a.ts' })],
    ['a Windows path', succeeded(sha('1'), { paths: ['C:\\repo\\a.ts'] })],
    ['a dot-dot path', succeeded(sha('1'), { ranking: [{ path: '../a.ts', rank: 1 }] })],
    ['a path list that is not an array', succeeded(sha('1'), { inputPaths: 'src/a.ts' })],
    ['an unknown field', { ...succeeded(sha('1')), retried: false }],
  ])('rejects an evaluation record with %s', (_label, value) => {
    expect(() => validateRecord(value, 'evaluation')).toThrow(JournalValidationError);
  });

  it('accepts portable paths anywhere in the evidence', () => {
    const evidence = { inputPaths: ['src/a.ts'], ranking: [{ path: 'test/a.test.ts', rank: 1 }], missing: { targetPath: null } };
    expect(validateRecord(succeeded(sha('1'), evidence), 'evaluation')).toEqual(succeeded(sha('1'), evidence));
  });

  it('rejects a preparation failure with more than one stage', () => {
    const value = {
      ...prepared(sha('a')),
      status: 'failed',
      failures: [
        { stage: 'ingestion', errorName: 'E', message: '' },
        { stage: 'lexical-index', errorName: 'E', message: '' },
      ],
    };
    expect(() => validateRecord(value, 'preparation')).toThrow(JournalValidationError);
  });
});

describe('creating and appending', () => {
  it('writes the header and each record as one canonical line ending in a newline', () => {
    const journal = createJournal(path, evaluation);
    journal.append(succeeded(COMMITS[0]!, { rankedPaths: ['b.ts', 'a.ts'] }));
    journal.append(failed(COMMITS[1]!));
    const content = readFileSync(path, 'utf8');
    expect(content).toBe(line(evaluationHeader) + line(succeeded(COMMITS[0]!, { rankedPaths: ['b.ts', 'a.ts'] })) + line(failed(COMMITS[1]!)));
    expect(content.endsWith('\n')).toBe(true);
    expect(journal.next).toBe(COMMITS[2]);
    expect(journal.remaining).toEqual([COMMITS[2]]);
  });

  it('refuses to overwrite an existing journal', () => {
    writeFileSync(path, 'keep me');
    expect(() => createJournal(path, evaluation)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('keep me');
  });

  it('refuses duplicates, recorded failures, foreign commits and out-of-order commits', () => {
    const journal = createJournal(path, evaluation);
    journal.append(failed(COMMITS[0]!));
    expect(() => journal.append(failed(COMMITS[0]!))).toThrow(/already recorded/);
    expect(() => journal.append(succeeded(COMMITS[0]!))).toThrow(/already recorded/);
    expect(() => journal.append(succeeded(sha('9')))).toThrow(/not in the manifest/);
    expect(() => journal.append(succeeded(COMMITS[2]!))).toThrow(/out of manifest order/);
    expect(() => journal.append(prepared(BASES[0]!) as never)).toThrow(JournalValidationError);
    expect(readFileSync(path, 'utf8')).toBe(line(evaluationHeader) + line(failed(COMMITS[0]!)));
  });

  it('validates a record before writing anything', () => {
    const journal = createJournal(path, evaluation);
    expect(() => journal.append(succeeded(COMMITS[0]!, { targetPath: 'C:/x' }))).toThrow(JournalValidationError);
    expect(readFileSync(path, 'utf8')).toBe(line(evaluationHeader));
    expect(journal.next).toBe(COMMITS[0]);
  });

  it('refuses to append when the file changed on disk', () => {
    const journal = createJournal(path, evaluation);
    appendFileSync(path, 'x');
    expect(() => journal.append(succeeded(COMMITS[0]!))).toThrow(/changed on disk/);
  });

  it('keeps the record as written, whatever the caller does with its object later', () => {
    const journal = createJournal(path, evaluation);
    const record = succeeded(COMMITS[0]!, { rank: 1 });
    journal.append(record);
    record.evidence['rank'] = 2;
    expect(journal.records[0]!.evidence).toEqual({ rank: 1 });
  });
});


describe('inspecting and resuming', () => {
  it('resumes at the first unrecorded commit and skips a recorded failure', () => {
    const journal = createJournal(path, evaluation);
    journal.append(failed(COMMITS[0]!));
    const result = valid(inspectJournal(path, evaluation));
    expect([...result.journal.completed]).toEqual([COMMITS[0]]);
    expect(result.journal.next).toBe(COMMITS[1]);
    expect(result.journal.records[0]).toEqual(failed(COMMITS[0]!));
    expect(result.previousRecovery).toBeNull();
    expect(() => result.journal.append(succeeded(COMMITS[0]!))).toThrow(/already recorded/);
    result.journal.append(succeeded(COMMITS[1]!));
    expect(valid(inspectJournal(path, evaluation)).journal.next).toBe(COMMITS[2]);
  });

  it('reports a complete journal with nothing left', () => {
    const journal = createJournal(path, preparation);
    for (const base of BASES) journal.append(prepared(base));
    const result = valid(inspectJournal(path, preparation));
    expect(result.journal.next).toBeNull();
    expect(result.journal.remaining).toEqual([]);
  });

  it('inspects the same way every time and never changes a file', () => {
    const journal = createJournal(path, evaluation);
    journal.append(succeeded(COMMITS[0]!));
    const before = files();
    const first = valid(inspectJournal(path, evaluation));
    const second = valid(inspectJournal(path, evaluation));
    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.journal.records).toEqual(first.journal.records);
    expect(second.journal.next).toBe(first.journal.next);
    expect(files()).toEqual(before);
  });

  it('refuses a journal written for another run identity', () => {
    createJournal(path, evaluation);
    const other = { header: { ...evaluationHeader, frozenDatabaseSha256: hash('a') }, keys: COMMITS };
    expect(inspectJournal(path, other)).toMatchObject({ status: 'invalid', reason: 'header-mismatch', line: 1 });
    expect(inspectJournal(path, { header: { ...evaluationHeader, embeddingModelId: 'other' }, keys: COMMITS })).toMatchObject({ reason: 'header-mismatch' });
    expect(inspectJournal(path, preparation)).toMatchObject({ reason: 'header-mismatch' });
  });

  it.each([
    ['a header that is not JSON', '{oops\n', 'malformed-header', 1],
    ['a header that fails the schema', line({ ...evaluationHeader, nodeVersion: 'x' }), 'malformed-header', 1],
    ['a header that is not canonical', `${JSON.stringify(evaluationHeader, null, 1).replace(/\n/g, '')}\n`, 'malformed-header', 1],
    ['a record that is not JSON', line(evaluationHeader) + 'not json\n', 'malformed-record', 2],
    ['an empty line', line(evaluationHeader) + '\n', 'malformed-record', 2],
    ['a record that fails the schema', line(evaluationHeader) + line({ ...succeeded(COMMITS[0]!), status: 'done' }), 'malformed-record', 2],
    ['a record of the other phase', line(evaluationHeader) + line(prepared(BASES[0]!)), 'malformed-record', 2],
    ['a foreign commit', line(evaluationHeader) + line(succeeded(sha('9'))), 'foreign-record', 2],
    ['a duplicate commit', line(evaluationHeader) + line(failed(COMMITS[0]!)) + line(succeeded(COMMITS[0]!)), 'duplicate-record', 3],
    ['a skipped commit', line(evaluationHeader) + line(succeeded(COMMITS[1]!)), 'out-of-order-record', 2],
    ['commits out of order', line(evaluationHeader) + line(succeeded(COMMITS[0]!)) + line(succeeded(COMMITS[2]!)) + line(succeeded(COMMITS[1]!)), 'out-of-order-record', 3],
  ])('refuses %s and changes nothing', (_label, content, reason, lineNumber) => {
    writeFileSync(path, content);
    const before = files();
    expect(inspectJournal(path, evaluation)).toMatchObject({ status: 'invalid', reason, line: lineNumber });
    expect(files()).toEqual(before);
  });

  it('refuses bytes that are not UTF-8 in the complete lines', () => {
    writeFileSync(path, Buffer.concat([Buffer.from(line(evaluationHeader)), Buffer.from([0xff, 0x0a])]));
    expect(inspectJournal(path, evaluation)).toMatchObject({ status: 'invalid', reason: 'not-utf8' });
  });

  it('never repairs corruption before the final line, even with a torn tail', () => {
    writeFileSync(path, line(evaluationHeader) + 'garbage\n' + line(succeeded(COMMITS[1]!)) + '{"kind":"rec');
    const before = files();
    expect(inspectJournal(path, evaluation)).toMatchObject({ status: 'invalid', reason: 'malformed-record', line: 2 });
    expect(files()).toEqual(before);
  });

  it('rejects an invalid expectation before reading anything', () => {
    writeFileSync(path, line(evaluationHeader));
    expect(() => inspectJournal(path, { header: evaluationHeader, keys: [COMMITS[0]!, COMMITS[0]!] })).toThrow(JournalValidationError);
    expect(() => inspectJournal(path, { header: evaluationHeader, keys: ['abc'] })).toThrow(JournalValidationError);
    expect(() => parseJournal(Buffer.from(''), { header: { ...evaluationHeader, manifestSha256: 'x' }, keys: [] })).toThrow(JournalValidationError);
  });
});

describe('torn tails', () => {
  // Torn bytes that are not even UTF-8, to show they are kept exactly and never decoded.
  const tornBody = Buffer.concat([Buffer.from(line(succeeded(COMMITS[1]!)).slice(0, 40)), Buffer.from([0xe2, 0x82])]);
  const journalWithTornBody = () => Buffer.concat([Buffer.from(line(evaluationHeader) + line(failed(COMMITS[0]!))), tornBody]);

  it('reports a torn body record exactly and changes nothing', () => {
    writeFileSync(path, journalWithTornBody());
    const before = files();
    const result = interrupted(inspectJournal(path, evaluation));
    const completeBytes = Buffer.byteLength(line(evaluationHeader) + line(failed(COMMITS[0]!)));
    expect(result.torn).toEqual({ offset: completeBytes, bytes: tornBody.length, sha256: sha256Hex(tornBody), headerTorn: false });
    expect(result.snapshot).toEqual({ bytes: completeBytes + tornBody.length, sha256: sha256Hex(journalWithTornBody()) });
    expect(result.records).toEqual([failed(COMMITS[0]!)]);
    expect(result.next).toBe(COMMITS[1]);
    expect(result.artifact).toBe('absent');
    expect(result.tornPath).toBe(`${path}.torn`);
    expect(files()).toEqual(before);
  });

  it('recovers explicitly: keeps the exact torn bytes, cuts the journal, and resumes at that commit', () => {
    writeFileSync(path, journalWithTornBody());
    const result = recoverJournal(evaluation, interrupted(inspectJournal(path, evaluation)));
    if (result.status !== 'recovered') throw new Error(JSON.stringify(result));
    expect(result.recovery).toMatchObject({ artifact: 'written', headerRewritten: false, bytes: tornBody.length, tornPath: `${path}.torn` });
    expect(readFileSync(`${path}.torn`).equals(tornBody)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(line(evaluationHeader) + line(failed(COMMITS[0]!)));
    expect(result.journal.next).toBe(COMMITS[1]);
    expect([...result.journal.completed]).toEqual([COMMITS[0]]);
    result.journal.append(succeeded(COMMITS[1]!));
    const after = valid(inspectJournal(path, evaluation));
    expect(after.previousRecovery).toEqual({ path: `${path}.torn`, bytes: tornBody.length, sha256: sha256Hex(tornBody) });
    expect(after.journal.next).toBe(COMMITS[2]);
  });

  it('treats a complete record without its newline as torn, not as recorded', () => {
    const almost = line(succeeded(COMMITS[0]!)).slice(0, -1);
    writeFileSync(path, line(evaluationHeader) + almost);
    const inspection = interrupted(inspectJournal(path, evaluation));
    expect(inspection.records).toEqual([]);
    expect(inspection.next).toBe(COMMITS[0]);
    const result = recoverJournal(evaluation, inspection);
    expect(result.status).toBe('recovered');
    expect(readFileSync(`${path}.torn`, 'utf8')).toBe(almost);
  });

  it('recovers a torn header by keeping it and writing the header again', () => {
    const torn = line(evaluationHeader).slice(0, 30);
    writeFileSync(path, torn);
    const inspection = interrupted(inspectJournal(path, evaluation));
    expect(inspection.torn).toMatchObject({ offset: 0, bytes: 30, headerTorn: true });
    const result = recoverJournal(evaluation, inspection);
    if (result.status !== 'recovered') throw new Error(JSON.stringify(result));
    expect(result.recovery).toMatchObject({ artifact: 'written', headerRewritten: true });
    expect(readFileSync(path, 'utf8')).toBe(line(evaluationHeader));
    expect(readFileSync(`${path}.torn`, 'utf8')).toBe(torn);
    expect(result.journal.next).toBe(COMMITS[0]);
  });

  it('treats an empty journal as interrupted with nothing to keep, leaving an earlier .torn alone', () => {
    // As left by a crash while creating the journal, or while rewriting a torn header.
    writeFileSync(path, '');
    writeFileSync(`${path}.torn`, 'an earlier torn header');
    const inspection = interrupted(inspectJournal(path, evaluation));
    expect(inspection).toMatchObject({ artifact: 'not-needed', torn: { offset: 0, bytes: 0, headerTorn: true } });
    const result = recoverJournal(evaluation, inspection);
    if (result.status !== 'recovered') throw new Error(JSON.stringify(result));
    expect(result.recovery).toMatchObject({ artifact: 'not-needed', headerRewritten: true });
    expect(readFileSync(path, 'utf8')).toBe(line(evaluationHeader));
    expect(readFileSync(`${path}.torn`, 'utf8')).toBe('an earlier torn header');
  });

  it('completes a recovery that stopped after keeping the torn bytes, without rewriting them', () => {
    writeFileSync(path, journalWithTornBody());
    writeFileSync(`${path}.torn`, tornBody);
    const inspection = interrupted(inspectJournal(path, evaluation));
    expect(inspection.artifact).toBe('identical');
    const result = recoverJournal(evaluation, inspection);
    if (result.status !== 'recovered') throw new Error(JSON.stringify(result));
    expect(result.recovery.artifact).toBe('already-kept');
    expect(readFileSync(`${path}.torn`).equals(tornBody)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(line(evaluationHeader) + line(failed(COMMITS[0]!)));
  });

  it.each([
    ['different bytes', Buffer.from('earlier torn bytes')],
    ['a partial copy of the torn bytes', tornBody.subarray(0, 10)],
  ])('refuses when .torn already holds %s, changing nothing', (_label, existing) => {
    writeFileSync(path, journalWithTornBody());
    writeFileSync(`${path}.torn`, existing);
    const before = files();
    expect(inspectJournal(path, evaluation)).toMatchObject({ status: 'invalid', reason: 'torn-artifact-conflict' });
    expect(files()).toEqual(before);
  });

  it('refuses a recovery when .torn appeared after the inspection', () => {
    writeFileSync(path, journalWithTornBody());
    const inspection = interrupted(inspectJournal(path, evaluation));
    writeFileSync(`${path}.torn`, 'written by someone else');
    const before = files();
    expect(recoverJournal(evaluation, inspection)).toMatchObject({ status: 'refused', reason: 'torn-artifact-conflict' });
    expect(files()).toEqual(before);
  });

  it.each([
    ['grew', (content: Buffer) => Buffer.concat([content, Buffer.from('x')])],
    ['shrank', (content: Buffer) => content.subarray(0, content.length - 1)],
    ['changed at the same size', (content: Buffer) => Buffer.concat([content.subarray(0, content.length - 1), Buffer.from('?')])],
  ])('refuses a stale inspection when the journal %s, changing nothing', (_label, change) => {
    writeFileSync(path, journalWithTornBody());
    const inspection = interrupted(inspectJournal(path, evaluation));
    writeFileSync(path, change(journalWithTornBody()));
    const before = files();
    expect(recoverJournal(evaluation, inspection)).toMatchObject({ status: 'refused', reason: 'stale-inspection' });
    expect(files()).toEqual(before);
  });

  it('refuses to apply an inspection a second time', () => {
    writeFileSync(path, journalWithTornBody());
    const inspection = interrupted(inspectJournal(path, evaluation));
    expect(recoverJournal(evaluation, inspection).status).toBe('recovered');
    const before = files();
    expect(recoverJournal(evaluation, inspection)).toMatchObject({ status: 'refused', reason: 'stale-inspection' });
    expect(files()).toEqual(before);
  });

  it('refuses an inspection made under another expectation', () => {
    writeFileSync(path, journalWithTornBody());
    const inspection = interrupted(inspectJournal(path, evaluation));
    const other = { header: { ...evaluationHeader, embeddingModelId: 'other' }, keys: COMMITS };
    const before = files();
    expect(recoverJournal(other, inspection)).toMatchObject({ status: 'refused', reason: 'stale-inspection' });
    expect(files()).toEqual(before);
  });
});

describe('the single-writer contract', () => {
  it('refuses a stale handle in the same process, leaving the other writer\'s record intact', () => {
    createJournal(path, evaluation);
    const first = valid(inspectJournal(path, evaluation)).journal;
    const second = valid(inspectJournal(path, evaluation)).journal;
    first.append(succeeded(COMMITS[0]!));
    expect(() => second.append(succeeded(COMMITS[0]!))).toThrow(/changed on disk/);
    expect(readFileSync(path, 'utf8')).toBe(line(evaluationHeader) + line(succeeded(COMMITS[0]!)));
  });

  it('refuses a handle made stale by a recovery', () => {
    writeFileSync(path, line(evaluationHeader) + '{"kind"');
    const inspection = interrupted(inspectJournal(path, evaluation));
    const staleSize = new CochangeJournal(path, evaluationHeader, COMMITS, [], inspection.snapshot.bytes);
    expect(recoverJournal(evaluation, inspection).status).toBe('recovered');
    expect(() => staleSize.append(succeeded(COMMITS[0]!))).toThrow(/changed on disk/);
    expect(readFileSync(path, 'utf8')).toBe(line(evaluationHeader));
  });
});
