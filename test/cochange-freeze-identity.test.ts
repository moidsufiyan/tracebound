import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from '../src/evaluation/m9/canonical.js';
import { freezeDatabase } from '../src/evaluation/m9/freeze-database.js';
import {
  bindingsOf,
  buildFreezeIdentity,
  claimedDatabaseSha256,
  FREEZE_IDENTITY_FILE,
  parseFreezeIdentity,
  publishFreezeIdentity,
  serializeFreezeIdentity,
  verifyFreezeIdentity,
  type FreezeBindings,
  type FreezeIdentity,
  type FreezeIdentityInput,
} from '../src/evaluation/cochange/freeze-identity.js';
import { acquireWorkLock, LOCK_FILE, releaseWorkLock } from '../src/evaluation/cochange/lock.js';

// Freezing a small database spawns no process, but the suite runs in parallel with Git-heavy files.
vi.setConfig({ testTimeout: 60_000 });

let dir: string;
let files: { identity: string; database: string; preparationJournal: string };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracebound-freeze-identity-test-'));
  files = { identity: join(dir, FREEZE_IDENTITY_FILE), database: join(dir, 'frozen.sqlite'), preparationJournal: join(dir, 'preparation.jsonl') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BINDINGS: FreezeBindings = {
  protocolVersion: '1.0.0',
  manifestSha256: 'd'.repeat(64),
  repository: { name: 'owner/repo', head: 'c'.repeat(40) },
  tracebound: { commit: 'e'.repeat(40), sourceClean: true, buildSha256: 'b'.repeat(64) },
  nodeVersion: 'v24.20.0',
  embeddingModelId: 'ollama:nomic-embed-text:v1.5@0a109f422b47',
};

/** A real frozen database (via freezeDatabase), a journal file, and the identity describing both. */
async function frozen(): Promise<FreezeIdentity> {
  const source = join(dir, 'working.sqlite');
  const db = new DatabaseSync(source);
  db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO item (name) VALUES ('a'), ('b'); PRAGMA user_version = 7;");
  db.close();
  const result = await freezeDatabase(source, files.database);
  writeFileSync(files.preparationJournal, 'header\nrecord one\nrecord two\n');
  return buildFreezeIdentity(inputFor(result));
}

function inputFor(result: Awaited<ReturnType<typeof freezeDatabase>>): FreezeIdentityInput {
  return {
    ...BINDINGS,
    preparation: { journalSha256: sha256Hex(readFileSync(files.preparationJournal)), bases: 2, succeeded: 1, failed: 1 },
    database: {
      file: 'frozen.sqlite',
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

const write = (value: unknown) => writeFileSync(files.identity, typeof value === 'string' ? value : canonicalJson(value));

describe('building and serializing', () => {
  it('serializes deterministically to canonical JSON without a trailing newline, whatever the key order', async () => {
    const identity = await frozen();
    const reordered = Object.fromEntries(Object.entries(identity).reverse());
    expect(serializeFreezeIdentity(identity).equals(serializeFreezeIdentity({ ...identity }))).toBe(true);
    expect(serializeFreezeIdentity(identity).toString('utf8')).toBe(canonicalJson(identity));
    expect(serializeFreezeIdentity(identity).toString('utf8').endsWith('}')).toBe(true);
    expect(canonicalJson(reordered)).toBe(canonicalJson(identity));
    expect(identity).toMatchObject({ schema: 'tracebound.cochange.freeze-identity', schemaVersion: '1.0.0', database: { userVersion: 7, journalMode: 'delete', integrityCheck: 'ok' } });
  });

  it.each([
    ['a path for the database file', (i: FreezeIdentityInput) => ({ ...i, database: { ...i.database, file: '/work/frozen.sqlite' } })],
    ['a Windows path for the database file', (i: FreezeIdentityInput) => ({ ...i, database: { ...i.database, file: 'C:\\work\\frozen.sqlite' } })],
    ['a database that failed its integrity check', (i: FreezeIdentityInput) => ({ ...i, database: { ...i.database, integrityCheck: 'page 3 broken' } })],
    ['a database in WAL mode', (i: FreezeIdentityInput) => ({ ...i, database: { ...i.database, journalMode: 'wal' } })],
    ['no table digests', (i: FreezeIdentityInput) => ({ ...i, database: { ...i.database, tables: [] } })],
    ['an empty preparation', (i: FreezeIdentityInput) => ({ ...i, preparation: { ...i.preparation, bases: 0, succeeded: 0, failed: 0 } })],
    ['counts that do not add up', (i: FreezeIdentityInput) => ({ ...i, preparation: { ...i.preparation, failed: 5 } })],
    ['an abbreviated commit', (i: FreezeIdentityInput) => ({ ...i, tracebound: { ...i.tracebound, commit: 'abc' } })],
    ['a malformed hash', (i: FreezeIdentityInput) => ({ ...i, database: { ...i.database, sha256: 'xyz' } })],
  ])('refuses to build an identity with %s', async (_label, change) => {
    const { schema: _s, schemaVersion: _v, ...input } = await frozen();
    expect(() => buildFreezeIdentity(change(input) as FreezeIdentityInput)).toThrow(RangeError);
  });
});

describe('parsing', () => {
  it('accepts exactly its own canonical bytes', async () => {
    const identity = await frozen();
    expect(parseFreezeIdentity(serializeFreezeIdentity(identity))).toEqual({ status: 'ok', identity });
    for (const bytes of [
      Buffer.from(JSON.stringify(identity, null, 2)),
      Buffer.from(`${canonicalJson(identity)}\n`),
      Buffer.from(canonicalJson({ ...identity, extra: 1 })),
      Buffer.from(canonicalJson({ ...identity, schemaVersion: '2.0.0' })),
      Buffer.from('not json'),
      Buffer.from([0xff, 0xfe]),
    ]) {
      expect(parseFreezeIdentity(bytes).status).toBe('malformed');
    }
  });

  it('reports the claimed database hash only for a well-formed identity', async () => {
    const identity = await frozen();
    expect(claimedDatabaseSha256(files.identity)).toBeNull();
    write('garbage');
    expect(claimedDatabaseSha256(files.identity)).toBeNull();
    write(identity);
    expect(claimedDatabaseSha256(files.identity)).toBe(identity.database.sha256);
  });
});

describe('verification', () => {
  it('verifies an identity against the files, shallowly and deeply', async () => {
    const identity = await frozen();
    write(identity);
    expect(await verifyFreezeIdentity(files, BINDINGS, { deep: false })).toEqual({ status: 'verified', identity, deep: false });
    expect(await verifyFreezeIdentity(files, BINDINGS, { deep: true })).toEqual({ status: 'verified', identity, deep: true });
    expect(bindingsOf(identity)).toEqual(BINDINGS);
  });

  it('reports an absent identity as absent, not as verified or trusted', async () => {
    await frozen();
    expect(await verifyFreezeIdentity(files, BINDINGS, { deep: true })).toEqual({ status: 'absent' });
  });

  it.each(Object.keys(BINDINGS) as (keyof FreezeBindings)[])('refuses an identity made for a run with another %s', async (key) => {
    const identity = await frozen();
    write(identity);
    const other = { ...BINDINGS, [key]: key === 'repository' ? { name: 'owner/repo', head: 'f'.repeat(40) } : key === 'tracebound' ? { ...BINDINGS.tracebound, buildSha256: 'f'.repeat(64) } : 'other' };
    expect(await verifyFreezeIdentity(files, other as FreezeBindings, { deep: false })).toMatchObject({ status: 'refused', reason: 'run-mismatch', detail: expect.stringContaining(key) });
  });

  it('refuses an identity whose preparation journal is missing or changed', async () => {
    const identity = await frozen();
    write(identity);
    writeFileSync(files.preparationJournal, 'header\nrecord one\n');
    expect(await verifyFreezeIdentity(files, BINDINGS, { deep: false })).toMatchObject({ status: 'refused', reason: 'journal-mismatch' });
    rmSync(files.preparationJournal);
    expect(await verifyFreezeIdentity(files, BINDINGS, { deep: false })).toMatchObject({ status: 'refused', reason: 'journal-mismatch' });
  });

  it('recomputes the database hash rather than trusting the recorded one', async () => {
    const identity = await frozen();
    write(identity);
    const db = new DatabaseSync(files.database);
    db.exec("INSERT INTO item (name) VALUES ('c')");
    db.close();
    expect(await verifyFreezeIdentity(files, BINDINGS, { deep: false })).toMatchObject({ status: 'refused', reason: 'database-mismatch' });
    rmSync(files.database);
    expect(await verifyFreezeIdentity(files, BINDINGS, { deep: false })).toMatchObject({ status: 'refused', reason: 'database-missing' });
  });

  it('recomputes the structure and table digests when deep, which a shallow check cannot see', async () => {
    const identity = await frozen();
    write({ ...identity, database: { ...identity.database, tables: [{ ...identity.database.tables[0]!, rows: 3 }] } });
    expect((await verifyFreezeIdentity(files, BINDINGS, { deep: false })).status).toBe('verified');
    expect(await verifyFreezeIdentity(files, BINDINGS, { deep: true })).toMatchObject({ status: 'refused', reason: 'database-inconsistent' });
    write({ ...identity, database: { ...identity.database, userVersion: 8 } });
    expect(await verifyFreezeIdentity(files, BINDINGS, { deep: true })).toMatchObject({ status: 'refused', reason: 'database-inconsistent' });
  });

  it('refuses a malformed identity', async () => {
    await frozen();
    write('{"schema":"tracebound.cochange.freeze-identity"}');
    expect(await verifyFreezeIdentity(files, BINDINGS, { deep: false })).toMatchObject({ status: 'refused', reason: 'malformed' });
  });
});

describe('publication', () => {
  it('publishes under the lock without replacing an existing identity', async () => {
    const identity = await frozen();
    const held = acquireWorkLock(dir, 'test');
    if (held.status !== 'acquired') throw new Error('lock');
    expect(publishFreezeIdentity(dir, identity, held.lock)).toMatchObject({ status: 'written', artifacts: [{ name: FREEZE_IDENTITY_FILE, action: 'written' }] });
    expect(readFileSync(files.identity).equals(serializeFreezeIdentity(identity))).toBe(true);
    expect(publishFreezeIdentity(dir, identity, held.lock)).toMatchObject({ status: 'written', artifacts: [{ action: 'unchanged' }] });
    const other = buildFreezeIdentity({ ...bindingsOf(identity), preparation: identity.preparation, database: { ...identity.database, pageCount: identity.database.pageCount + 1 } });
    expect(publishFreezeIdentity(dir, other, held.lock)).toMatchObject({ status: 'refused', reason: 'artifact-conflict' });
    expect(readFileSync(files.identity).equals(serializeFreezeIdentity(identity))).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    releaseWorkLock(held.lock);
  });

  it('writes nothing when the lock is no longer held', async () => {
    const identity = await frozen();
    const held = acquireWorkLock(dir, 'test');
    if (held.status !== 'acquired') throw new Error('lock');
    rmSync(join(dir, LOCK_FILE));
    expect(publishFreezeIdentity(dir, identity, held.lock)).toMatchObject({ status: 'refused', reason: 'lock-lost' });
    expect(readdirSync(dir)).not.toContain(FREEZE_IDENTITY_FILE);
  });

  it('holds no absolute path', async () => {
    const identity = await frozen();
    const text = serializeFreezeIdentity(identity).toString('utf8');
    for (const forbidden of [dir, tmpdir(), 'C:\\', '/tmp/', '\\\\']) expect(text, forbidden).not.toContain(forbidden);
  });
});
