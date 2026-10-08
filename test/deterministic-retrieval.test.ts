import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexSnapshotStructurally, StructuralIndexNotBuiltError } from '../src/analysis/structural-index.js';
import { openDatabase, type Database } from '../src/db/database.js';
import { ingestSnapshot } from '../src/ingestion/ingest-snapshot.js';
import { createProject, NotFoundError, registerRepository, type Repository } from '../src/projects/projects.js';
import { retrieveCandidates } from '../src/retrieval/deterministic-retrieval.js';
import { indexSnapshotLexically, LexicalIndexNotBuiltError } from '../src/retrieval/lexical-index.js';
import { searchLexical } from '../src/retrieval/lexical-search.js';
import { findSnapshot, SnapshotNotReadyError } from '../src/snapshots/snapshots.js';
import { FixtureRepo } from './git-fixture.js';

let db: Database;
let fixture: FixtureRepo;
let repository: Repository;

/** Ingests a commit and builds both indexes. */
async function snapshotOf(sha: string): Promise<number> {
  const { snapshot } = await ingestSnapshot(db, repository.id, sha);
  indexSnapshotLexically(db, snapshot.id);
  indexSnapshotStructurally(db, snapshot.id);
  return snapshot.id;
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  fixture = new FixtureRepo();
  const project = createProject(db, 'p');
  repository = await registerRepository(db, { projectId: project.id, name: 'r', sourcePath: fixture.path });
});

afterEach(() => {
  db.close();
  fixture.remove();
});

// A change to src/billing.ts. src/invoice.ts and src/billing.test.ts import it, and src/billing.ts
// imports src/ledger.ts. Prose in docs/ mentions the change's vocabulary.
const BASE_FILES = {
  'src/billing.ts': `import { post } from './ledger';\nexport const billing = post;\n`,
  'src/ledger.ts': `export const post = 1;\n`,
  'src/invoice.ts': `import { billing } from './billing';\nexport const invoice = billing;\n`,
  'src/billing.test.ts': `import { billing } from './billing';\nexport const check = billing;\n`,
  'docs/overview.md': `Notes on discount and refund policy.\n`,
  'docs/standalone.md': `A refund discount statement.\n`,
};

describe('structural signals on candidates', () => {
  it('reports test-to-source, incoming and outgoing imports with the changed artifact they relate to', async () => {
    const snapshotId = await snapshotOf(fixture.commit(BASE_FILES));

    const candidates = retrieveCandidates(db, snapshotId, { text: '', changedPaths: ['src/billing.ts'] });

    const byPath = new Map(candidates.map((c) => [c.path, c]));
    expect(byPath.get('src/billing.test.ts')).toMatchObject({
      category: 'critical-structural',
      structuralSignals: [{ kind: 'test-to-source', changedPath: 'src/billing.ts' }],
      structuralCounts: { 'test-to-source': 1, 'incoming-import': 0, 'outgoing-import': 0 },
    });
    expect(byPath.get('src/invoice.ts')).toMatchObject({
      category: 'critical-structural',
      structuralSignals: [{ kind: 'incoming-import', changedPath: 'src/billing.ts' }],
      structuralCounts: { 'test-to-source': 0, 'incoming-import': 1, 'outgoing-import': 0 },
    });
    expect(byPath.get('src/ledger.ts')).toMatchObject({
      category: 'weak-structural',
      structuralSignals: [{ kind: 'outgoing-import', changedPath: 'src/billing.ts' }],
      structuralCounts: { 'test-to-source': 0, 'incoming-import': 0, 'outgoing-import': 1 },
    });
    expect(candidates.map((c) => c.path).sort()).toEqual(['src/billing.test.ts', 'src/invoice.ts', 'src/ledger.ts']);
  });

  it('exposes the retrieval facts of the candidate contract', async () => {
    const snapshotId = await snapshotOf(fixture.commit(BASE_FILES));

    const candidates = retrieveCandidates(db, snapshotId, { text: '', changedPaths: ['src/billing.ts'] });

    // Equal category and no lexical terms: the shorter path ranks first.
    expect(candidates.map((c) => c.path)).toEqual(['src/invoice.ts', 'src/billing.test.ts', 'src/ledger.ts']);
    expect(candidates[1]).toEqual({
      rank: 2,
      artifactId: expect.any(Number),
      versionId: expect.any(Number),
      path: 'src/billing.test.ts',
      kind: 'code',
      category: 'critical-structural',
      lexicalCategory: null,
      contentMatchCount: 0,
      pathMatchCount: 0,
      matchedTerms: [],
      structuralSignals: [{ kind: 'test-to-source', changedPath: 'src/billing.ts' }],
      structuralCounts: { 'test-to-source': 1, 'incoming-import': 0, 'outgoing-import': 0 },
    });
  });

  it('counts one signal per related changed artifact and keeps a test and its source distinct', async () => {
    const sha = fixture.commit({
      'src/a.ts': `export const a = 1;\n`,
      'src/b.ts': `export const b = 1;\n`,
      'src/both.ts': `import { a } from './a';\nimport { b } from './b';\n`,
      'src/both.test.ts': `import { a } from './a';\nimport { b } from './b';\n`,
    });
    const snapshotId = await snapshotOf(sha);

    const candidates = retrieveCandidates(db, snapshotId, { text: '', changedPaths: ['src/b.ts', 'src/a.ts'] });

    expect(candidates.find((c) => c.path === 'src/both.ts')).toMatchObject({
      structuralSignals: [
        { kind: 'incoming-import', changedPath: 'src/a.ts' },
        { kind: 'incoming-import', changedPath: 'src/b.ts' },
      ],
      structuralCounts: { 'test-to-source': 0, 'incoming-import': 2, 'outgoing-import': 0 },
    });
    expect(candidates.find((c) => c.path === 'src/both.test.ts')).toMatchObject({
      structuralCounts: { 'test-to-source': 2, 'incoming-import': 0, 'outgoing-import': 0 },
    });
  });

  it('ignores changed paths that the snapshot does not contain', async () => {
    const snapshotId = await snapshotOf(fixture.commit(BASE_FILES));
    expect(retrieveCandidates(db, snapshotId, { text: '', changedPaths: ['src/new-file.ts'] })).toEqual([]);
  });
});

describe('union of structural and lexical candidates', () => {
  it('returns structural-only, lexical-only and combined candidates', async () => {
    const snapshotId = await snapshotOf(fixture.commit(BASE_FILES));

    const candidates = retrieveCandidates(db, snapshotId, {
      text: 'refund discount statement',
      changedPaths: ['src/billing.ts'],
    });

    const byPath = new Map(candidates.map((c) => [c.path, c]));
    // Found only through the import graph.
    expect(byPath.get('src/invoice.ts')).toMatchObject({ lexicalCategory: null, matchedTerms: [] });
    expect(byPath.get('src/billing.test.ts')).toMatchObject({ lexicalCategory: null, matchedTerms: [] });
    // Found only through the text.
    expect(byPath.get('docs/overview.md')).toMatchObject({ lexicalCategory: 'multiple-terms', structuralSignals: [] });
    expect(byPath.get('docs/standalone.md')).toMatchObject({ lexicalCategory: 'multiple-terms', structuralSignals: [] });
    expect([...byPath.keys()].sort()).toEqual([
      'docs/overview.md',
      'docs/standalone.md',
      'src/billing.test.ts',
      'src/invoice.ts',
      'src/ledger.ts',
    ]);
  });

  it('keeps every lexical candidate eligible when nothing is structurally related', async () => {
    const snapshotId = await snapshotOf(fixture.commit(BASE_FILES));
    const query = { text: 'refund discount statement' };

    const lexical = searchLexical(db, snapshotId, query);
    const deterministic = retrieveCandidates(db, snapshotId, query);

    expect(deterministic.map((c) => c.path)).toEqual(lexical.map((c) => c.path));
    expect(deterministic.map((c) => c.category)).toEqual(lexical.map((c) => c.category));
    expect(deterministic.map((c) => c.rank)).toEqual(lexical.map((c) => c.rank));
  });

  it('attaches structural signals to a candidate that also matched lexically', async () => {
    const snapshotId = await snapshotOf(fixture.commit(BASE_FILES));

    const candidates = retrieveCandidates(db, snapshotId, { text: 'billing ledger', changedPaths: ['src/billing.ts'] });
    const invoice = candidates.find((c) => c.path === 'src/invoice.ts')!;

    expect(invoice.matchedTerms).toEqual(['billing']);
    expect(invoice.contentMatchCount).toBe(1);
    expect(invoice.lexicalCategory).toBe('single-term');
    expect(invoice.category).toBe('critical-structural');
    expect(invoice.structuralSignals).toHaveLength(1);
  });
});

describe('structural precedence over lexical evidence', () => {
  it('ranks dependents and tests first, strong lexical next, outgoing imports before weaker lexical', async () => {
    const sha = fixture.commit({
      ...BASE_FILES,
      'docs/dense.md': `refund discount statement invoice ledger together\n`,
      'docs/weak.md': `A lone refund appears here.\n`,
    });
    const snapshotId = await snapshotOf(sha);

    const candidates = retrieveCandidates(db, snapshotId, {
      text: 'refund discount statement invoice ledger',
      changedPaths: ['src/billing.ts'],
    });

    expect(candidates.map((c) => [c.rank, c.path, c.category])).toEqual([
      [1, 'src/invoice.ts', 'critical-structural'],
      [2, 'src/billing.test.ts', 'critical-structural'],
      [3, 'docs/dense.md', 'high-content-density'],
      // Its path matches 'ledger' (lexically path-only), but B6 ranks an outgoing import above that.
      [4, 'src/ledger.ts', 'weak-structural'],
      [5, 'docs/standalone.md', 'multiple-terms'],
      [6, 'docs/overview.md', 'multiple-terms'],
      [7, 'docs/weak.md', 'single-term'],
      [8, 'src/billing.ts', 'single-term'], // the changed artifact itself, matched by 'ledger' in its content
    ]);
  });

  it('ranks an outgoing import above weaker lexical categories when it has no lexical strength', async () => {
    const snapshotId = await snapshotOf(fixture.commit(BASE_FILES));

    const candidates = retrieveCandidates(db, snapshotId, { text: 'refund', changedPaths: ['src/billing.ts'] });

    const order = candidates.map((c) => c.path);
    expect(order.indexOf('src/ledger.ts')).toBeLessThan(order.indexOf('docs/standalone.md'));
    expect(candidates.find((c) => c.path === 'src/ledger.ts')!.category).toBe('weak-structural');
  });

  it('is deterministic', async () => {
    const snapshotId = await snapshotOf(fixture.commit(BASE_FILES));
    const query = { text: 'refund billing', symbols: ['billing'], changedPaths: ['src/billing.ts'] };

    expect(retrieveCandidates(db, snapshotId, query)).toEqual(retrieveCandidates(db, snapshotId, query));
    expect(retrieveCandidates(db, snapshotId, query).map((c) => c.rank)).toEqual(
      retrieveCandidates(db, snapshotId, query).map((_, index) => index + 1),
    );
  });
});

describe('historical snapshot isolation', () => {
  it('sees only the dependents that existed in the requested snapshot', async () => {
    const early = fixture.commit({ 'src/core.ts': `export const core = 1;\n` });
    const late = fixture.commit({
      'src/core.ts': `export const core = 1;\n`,
      'src/consumer.ts': `import { core } from './core';\nexport const c = core;\n`,
      'src/core.test.ts': `import { core } from './core';\n`,
    });
    const earlyId = await snapshotOf(early);
    const lateId = await snapshotOf(late);
    const query = { text: '', changedPaths: ['src/core.ts'] };

    expect(retrieveCandidates(db, earlyId, query)).toEqual([]);
    expect(retrieveCandidates(db, lateId, query).map((c) => c.path)).toEqual(['src/consumer.ts', 'src/core.test.ts']);
  });

  it('does not use a dependent that was removed in a later snapshot', async () => {
    const early = fixture.commit({
      'src/core.ts': `export const core = 1;\n`,
      'src/consumer.ts': `import { core } from './core';\n`,
    });
    const late = fixture.commit({}, { remove: ['src/consumer.ts'] });
    const earlyId = await snapshotOf(early);
    const lateId = await snapshotOf(late);
    const query = { text: '', changedPaths: ['src/core.ts'] };

    expect(retrieveCandidates(db, earlyId, query).map((c) => c.path)).toEqual(['src/consumer.ts']);
    expect(retrieveCandidates(db, lateId, query)).toEqual([]);
  });
});

describe('snapshot and index state', () => {
  it('rejects unknown and failed snapshots', async () => {
    const sha = fixture.commit({ 'a.ts': 'export const broken = 1;\n' });
    fixture.deleteObject(fixture.git('rev-parse', `${sha}:a.ts`));
    await expect(ingestSnapshot(db, repository.id, sha)).rejects.toThrow();
    const failedId = findSnapshot(db, repository.id, sha)!.id;

    expect(() => retrieveCandidates(db, 999, { text: 'x' })).toThrow(NotFoundError);
    expect(() => retrieveCandidates(db, failedId, { text: 'x' })).toThrow(SnapshotNotReadyError);
  });

  it('refuses a snapshot missing either index instead of returning partial candidates', async () => {
    const { snapshot } = await ingestSnapshot(db, repository.id, fixture.commit(BASE_FILES));
    const query = { text: 'refund', changedPaths: ['src/billing.ts'] };

    expect(() => retrieveCandidates(db, snapshot.id, query)).toThrow(LexicalIndexNotBuiltError);
    indexSnapshotLexically(db, snapshot.id);
    expect(() => retrieveCandidates(db, snapshot.id, query)).toThrow(StructuralIndexNotBuiltError);
    indexSnapshotStructurally(db, snapshot.id);
    expect(retrieveCandidates(db, snapshot.id, query).length).toBeGreaterThan(0);
  });
});
