import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../src/db/database.js';
import { ingestSnapshot } from '../src/ingestion/ingest-snapshot.js';
import { createProject, NotFoundError, registerRepository, type Repository } from '../src/projects/projects.js';
import {
  indexSnapshotLexically,
  isSnapshotLexicallyIndexed,
  LexicalIndexNotBuiltError,
} from '../src/retrieval/lexical-index.js';
import { searchLexical } from '../src/retrieval/lexical-search.js';
import { findSnapshot, SnapshotNotReadyError } from '../src/snapshots/snapshots.js';
import { FixtureRepo } from './git-fixture.js';

let db: Database;
let fixture: FixtureRepo;
let repository: Repository;
const extraFixtures: FixtureRepo[] = [];

async function register(source: FixtureRepo): Promise<Repository> {
  const project = createProject(db, `project-${Math.random()}`);
  return registerRepository(db, { projectId: project.id, name: 'repo', sourcePath: source.path });
}

/** Ingests and lexically indexes a commit, returning the snapshot id. */
async function snapshotOf(sha: string, target: Repository = repository): Promise<number> {
  const { snapshot } = await ingestSnapshot(db, target.id, sha);
  indexSnapshotLexically(db, snapshot.id);
  return snapshot.id;
}

function count(table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  fixture = new FixtureRepo();
  repository = await register(fixture);
});

afterEach(() => {
  db.close();
  fixture.remove();
  for (const extra of extraFixtures.splice(0)) extra.remove();
});

describe('what a candidate contains', () => {
  it('reports ids, path, kind, category, counts and matched terms with 1-based consecutive ranks', async () => {
    const sha = fixture.commit({
      'docs/checkout.md': 'The reservation lock expires.\n',
      'src/other.ts': 'export const reservation = 1;\n',
    });
    const snapshotId = await snapshotOf(sha);

    const candidates = searchLexical(db, snapshotId, { text: 'checkout reservation lock' });

    expect(candidates.map((c) => c.rank)).toEqual([1, 2]);
    expect(candidates[0]).toEqual({
      rank: 1,
      artifactId: expect.any(Number),
      versionId: expect.any(Number),
      path: 'docs/checkout.md',
      kind: 'document',
      category: 'path-and-multi-content',
      contentMatchCount: 2,
      pathMatchCount: 1,
      matchedTerms: ['checkout', 'lock', 'reservation'],
    });
    expect(candidates[1]).toMatchObject({ path: 'src/other.ts', category: 'single-term', kind: 'code' });
  });
});

describe('path and content matching', () => {
  it('finds content-only, path-only and combined matches', async () => {
    const sha = fixture.commit({
      'notes.md': 'about invoices\n',
      'invoice-helper.ts': 'export const unrelated = 1;\n',
      'invoices/ledger.md': 'every invoice is listed\n',
    });
    const snapshotId = await snapshotOf(sha);

    const byPath = new Map(searchLexical(db, snapshotId, { text: 'invoices' }).map((c) => [c.path, c]));

    expect(byPath.get('notes.md')).toMatchObject({ contentMatchCount: 1, pathMatchCount: 0, category: 'single-term' });
    // 'invoice' is not 'invoices': tokens match whole words, never substrings.
    expect(byPath.has('invoice-helper.ts')).toBe(false);
    expect(byPath.get('invoices/ledger.md')).toMatchObject({
      contentMatchCount: 0,
      pathMatchCount: 1,
      category: 'path-only',
      matchedTerms: ['invoices'],
    });

    const both = new Map(searchLexical(db, snapshotId, { text: 'invoice invoices' }).map((c) => [c.path, c]));
    expect(both.get('invoice-helper.ts')).toMatchObject({ contentMatchCount: 0, pathMatchCount: 1 });
    expect(both.get('invoices/ledger.md')).toMatchObject({ contentMatchCount: 1, pathMatchCount: 1 });
  });

  it('does not lose a path match when the content matches nothing', async () => {
    const snapshotId = await snapshotOf(fixture.commit({ 'billing/empty.md': '', 'x.md': 'billing\n' }));
    const paths = searchLexical(db, snapshotId, { text: 'billing' }).map((c) => c.path);
    expect(paths).toEqual(['billing/empty.md', 'x.md']);
  });

  it('matches compound identifiers by their parts and by their joined name', async () => {
    const snapshotId = await snapshotOf(
      fixture.commit({ 'a.ts': 'const releaseLockLua = 1;\n', 'b.ts': 'const RELEASE_LOCK_LUA = 2;\n', 'c.ts': 'lock\n' }),
    );

    const joined = searchLexical(db, snapshotId, { text: '', symbols: ['RELEASE_LOCK_LUA'] });
    expect(joined.map((c) => c.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(joined[0]!.matchedTerms).toEqual(['lock', 'lua', 'release', 'releaselocklua']);
    expect(joined[2]!.matchedTerms).toEqual(['lock']);
  });

  it('matches normalized content, so CRLF and LF checkouts of a file are found alike', async () => {
    const snapshotId = await snapshotOf(fixture.commit({ 'a.md': 'alpha\r\nbeta\r\n' }));
    expect(searchLexical(db, snapshotId, { text: 'alpha beta' })[0]).toMatchObject({ contentMatchCount: 2 });
  });

  it('returns nothing for a query without searchable terms', async () => {
    const snapshotId = await snapshotOf(fixture.commit({ 'a.md': 'the and of\n' }));
    expect(searchLexical(db, snapshotId, { text: 'the and of to' })).toEqual([]);
    expect(searchLexical(db, snapshotId, { text: 'zzzzunmatched' })).toEqual([]);
  });
});

describe('shared content', () => {
  it('returns each artifact with identical content once, and indexes the content once', async () => {
    const sha = fixture.commit({ 'one/a.md': 'shared telemetry text\n', 'two/b.md': 'shared telemetry text\n' });
    const snapshotId = await snapshotOf(sha);

    const candidates = searchLexical(db, snapshotId, { text: 'telemetry' });

    expect(candidates.map((c) => c.path)).toEqual(['one/a.md', 'two/b.md']);
    expect(candidates[0]!.artifactId).not.toBe(candidates[1]!.artifactId);
    expect(candidates[0]!.versionId).not.toBe(candidates[1]!.versionId);
    expect(db.prepare("SELECT count(*) AS n FROM content_token WHERE token = 'telemetry'").get()).toEqual({ n: 1 });
  });

  it('does not tokenize content again for later snapshots that reuse it', async () => {
    const first = fixture.commit({ 'a.md': 'stable text\n' });
    const second = fixture.commit({ 'b.md': 'new text\n' });
    const s1 = (await ingestSnapshot(db, repository.id, first)).snapshot.id;
    const s2 = (await ingestSnapshot(db, repository.id, second)).snapshot.id;

    expect(indexSnapshotLexically(db, s1)).toEqual({ contentsIndexed: 1, artifactsIndexed: 1 });
    expect(indexSnapshotLexically(db, s2)).toEqual({ contentsIndexed: 1, artifactsIndexed: 1 });
  });
});

describe('categories', () => {
  it('assigns every lexical category from real artifacts', async () => {
    const snapshotId = await snapshotOf(
      fixture.commit({
        'alpha/notes.md': 'bravo charlie\n', // path term + 2 content terms = 3 distinct
        'z-dense.md': 'alpha bravo charlie delta echo\n', // 5 distinct, no path term
        'alpha.md': 'unrelated words\n', // path term only
        'm-multi.md': 'alpha bravo\n', // 2 distinct, no path term
        'q-single.md': 'alpha\n', // 1 distinct
      }),
    );

    const candidates = searchLexical(db, snapshotId, { text: 'alpha bravo charlie delta echo foxtrot' });

    expect(candidates.map((c) => [c.path, c.category])).toEqual([
      ['alpha/notes.md', 'path-and-multi-content'],
      ['z-dense.md', 'high-content-density'],
      ['alpha.md', 'path-only'],
      ['m-multi.md', 'multiple-terms'],
      ['q-single.md', 'single-term'],
    ]);
  });

  it('orders ties deterministically and identically across independent databases', async () => {
    const sha = fixture.commit({ 'd.md': 'tango\n', 'a.md': 'tango\n', 'C.md': 'tango\n', 'longer.md': 'tango\n' });
    const first = searchLexical(db, await snapshotOf(sha), { text: 'tango' });
    expect(first.map((c) => c.path)).toEqual(['C.md', 'a.md', 'd.md', 'longer.md']);

    const other = openDatabase(':memory:');
    try {
      const project = createProject(other, 'p');
      const repo = await registerRepository(other, { projectId: project.id, name: 'r', sourcePath: fixture.path });
      const id = (await ingestSnapshot(other, repo.id, sha)).snapshot.id;
      indexSnapshotLexically(other, id);
      const strip = (list: typeof first) => list.map(({ artifactId, versionId, ...rest }) => rest);
      expect(strip(searchLexical(other, id, { text: 'tango' }))).toEqual(strip(first));
    } finally {
      other.close();
    }
  });
});

describe('snapshot scoping', () => {
  it('cannot see artifacts or content introduced only in a later snapshot', async () => {
    const early = fixture.commit({ 'src/cart.ts': 'export const cart = 1;\n' });
    const late = fixture.commit({
      'docs/refunds.md': 'refunds policy\n',
      'src/cart.ts': 'export const cart = 1;\nconst refunds = 2;\n',
    });
    const earlyId = await snapshotOf(early);
    const lateId = await snapshotOf(late);

    expect(searchLexical(db, earlyId, { text: 'refunds' })).toEqual([]);
    expect(searchLexical(db, lateId, { text: 'refunds' }).map((c) => c.path)).toEqual(['docs/refunds.md', 'src/cart.ts']);
  });

  it('cannot see artifacts that were deleted by a later snapshot, and shows the old content of changed ones', async () => {
    const early = fixture.commit({ 'gone.md': 'legacy ledger\n', 'kept.md': 'legacy ledger\n' });
    const late = fixture.commit({ 'kept.md': 'modern journal\n' }, { remove: ['gone.md'] });
    const earlyId = await snapshotOf(early);
    const lateId = await snapshotOf(late);

    expect(searchLexical(db, earlyId, { text: 'legacy' }).map((c) => c.path)).toEqual(['gone.md', 'kept.md']);
    expect(searchLexical(db, lateId, { text: 'legacy' })).toEqual([]);
    expect(searchLexical(db, earlyId, { text: 'modern' })).toEqual([]);
  });

  it('ignores the working tree and HEAD', async () => {
    const early = fixture.commit({ 'a.md': 'committed\n' });
    fixture.commit({ 'a.md': 'headonly\n' });
    fixture.write({ 'a.md': 'dirty\n', 'untracked.md': 'untracked headonly\n' });
    const earlyId = await snapshotOf(early);

    expect(searchLexical(db, earlyId, { text: 'headonly dirty untracked' })).toEqual([]);
    expect(searchLexical(db, earlyId, { text: 'committed' })).toHaveLength(1);
  });

  it('never returns artifacts of another repository', async () => {
    const other = new FixtureRepo();
    extraFixtures.push(other);
    const otherRepository = await register(other);
    await snapshotOf(other.commit({ 'foreign.md': 'zeppelin\n' }), otherRepository);
    const mine = await snapshotOf(fixture.commit({ 'mine.md': 'zeppelin\n' }));

    expect(searchLexical(db, mine, { text: 'zeppelin' }).map((c) => c.path)).toEqual(['mine.md']);
  });
});

describe('snapshot and index state', () => {
  it('rejects unknown snapshots', () => {
    expect(() => searchLexical(db, 999, { text: 'x' })).toThrow(NotFoundError);
    expect(() => indexSnapshotLexically(db, 999)).toThrow(NotFoundError);
  });

  it('rejects failed snapshots for searching and indexing', async () => {
    const sha = fixture.commit({ 'a.md': 'broken blob\n' });
    fixture.deleteObject(fixture.git('rev-parse', `${sha}:a.md`));
    await expect(ingestSnapshot(db, repository.id, sha)).rejects.toThrow();
    const failedId = findSnapshot(db, repository.id, sha)!.id;

    expect(() => searchLexical(db, failedId, { text: 'broken' })).toThrow(SnapshotNotReadyError);
    expect(() => indexSnapshotLexically(db, failedId)).toThrow(SnapshotNotReadyError);
    expect(count('content_token')).toBe(0);
  });

  it('refuses to search a snapshot that has not been indexed instead of returning partial results', async () => {
    const { snapshot } = await ingestSnapshot(db, repository.id, fixture.commit({ 'a.md': 'alpha\n' }));

    expect(isSnapshotLexicallyIndexed(db, snapshot.id)).toBe(false);
    expect(() => searchLexical(db, snapshot.id, { text: 'alpha' })).toThrow(LexicalIndexNotBuiltError);

    indexSnapshotLexically(db, snapshot.id);
    expect(isSnapshotLexicallyIndexed(db, snapshot.id)).toBe(true);
    expect(searchLexical(db, snapshot.id, { text: 'alpha' })).toHaveLength(1);
  });

  it('indexes idempotently and treats empty content as indexed', async () => {
    const { snapshot } = await ingestSnapshot(db, repository.id, fixture.commit({ 'empty.md': '', 'a.md': 'alpha\n' }));

    expect(indexSnapshotLexically(db, snapshot.id)).toEqual({ contentsIndexed: 2, artifactsIndexed: 2 });
    const before = [count('content_token'), count('artifact_path_token'), count('lexical_indexed_content')];
    expect(indexSnapshotLexically(db, snapshot.id)).toEqual({ contentsIndexed: 0, artifactsIndexed: 0 });
    expect([count('content_token'), count('artifact_path_token'), count('lexical_indexed_content')]).toEqual(before);
    expect(isSnapshotLexicallyIndexed(db, snapshot.id)).toBe(true);
  });

  it('leaves snapshot state and canonical rows untouched', async () => {
    const { snapshot } = await ingestSnapshot(db, repository.id, fixture.commit({ 'a.md': 'alpha\n' }));
    const canonical = () => [count('repository_snapshot'), count('artifact'), count('artifact_version'), count('content')];
    const before = canonical();

    indexSnapshotLexically(db, snapshot.id);

    expect(canonical()).toEqual(before);
    expect(findSnapshot(db, repository.id, snapshot.commitSha)).toEqual(snapshot);
  });
});
