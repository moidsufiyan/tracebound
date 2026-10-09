import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexSnapshotStructurally, StructuralIndexNotBuiltError } from '../src/analysis/structural-index.js';
import { openDatabase, type Database } from '../src/db/database.js';
import { ingestSnapshot } from '../src/ingestion/ingest-snapshot.js';
import { createProject, NotFoundError, registerRepository, type Repository } from '../src/projects/projects.js';
import { retrieveCandidates } from '../src/retrieval/deterministic-retrieval.js';
import { searchHybrid } from '../src/retrieval/hybrid-search.js';
import { indexSnapshotLexically, LexicalIndexNotBuiltError } from '../src/retrieval/lexical-index.js';
import { fuseRrf } from '../src/retrieval/rrf.js';
import { indexSnapshotSemantically, SemanticIndexIncompatibleError, SemanticIndexNotBuiltError } from '../src/semantic/semantic-index.js';
import { searchSemantic } from '../src/semantic/semantic-search.js';
import { findSnapshot, SnapshotNotReadyError } from '../src/snapshots/snapshots.js';
import { FakeEmbeddingProvider } from './fake-embedding-provider.js';
import { FixtureRepo } from './git-fixture.js';

const VOCABULARY = ['billing', 'ledger', 'refund', 'invoice'];

let db: Database;
let fixture: FixtureRepo;
let repository: Repository;
let provider: FakeEmbeddingProvider;

// A change to src/billing.ts. invoice.ts and billing.test.ts import it, and billing.ts imports ledger.ts.
const FILES = {
  'src/billing.ts': `import { post } from './ledger';\nexport const billing = post;\n`,
  'src/ledger.ts': `export const post = 1;\n`,
  'src/invoice.ts': `import { billing } from './billing';\nexport const invoice = billing;\n`,
  'src/billing.test.ts': `import { billing } from './billing';\nexport const check = billing;\n`,
  'docs/refunds.md': `A refund is posted to the billing ledger.\n`,
  'docs/other.md': `Nothing to do with it.\n`,
};

const QUERY = { description: 'fix refund billing', changedPaths: ['src/billing.ts'] };

async function ingest(sha: string): Promise<number> {
  return (await ingestSnapshot(db, repository.id, sha)).snapshot.id;
}

/** Ingests a commit and builds all three indexes. */
async function readySnapshot(files: Record<string, string> = FILES): Promise<number> {
  const snapshotId = await ingest(fixture.commit(files));
  indexSnapshotLexically(db, snapshotId);
  indexSnapshotStructurally(db, snapshotId);
  await indexSnapshotSemantically(db, snapshotId, provider);
  return snapshotId;
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  fixture = new FixtureRepo();
  const project = createProject(db, 'p');
  repository = await registerRepository(db, { projectId: project.id, name: 'r', sourcePath: fixture.path });
  provider = new FakeEmbeddingProvider(VOCABULARY);
});

afterEach(() => {
  db.close();
  fixture.remove();
});

describe('searchHybrid', () => {
  it('fuses the real deterministic and semantic candidates of the snapshot', async () => {
    const snapshotId = await readySnapshot();

    const hybrid = await searchHybrid(db, snapshotId, provider, QUERY);

    // The lexical text is the description plus the changed files' base names, as the research built it.
    const deterministic = retrieveCandidates(db, snapshotId, {
      text: 'fix refund billing billing.ts',
      changedPaths: QUERY.changedPaths,
    });
    const semantic = await searchSemantic(db, snapshotId, provider, QUERY);
    expect(hybrid).toEqual(fuseRrf(deterministic, semantic));
  });

  it('returns the whole semantic universe with the audit fields and consecutive ranks', async () => {
    const snapshotId = await readySnapshot();

    const hybrid = await searchHybrid(db, snapshotId, provider, QUERY);

    expect(hybrid.map((c) => c.rank)).toEqual(hybrid.map((_, i) => i + 1));
    expect(hybrid.map((c) => c.path).sort()).toEqual(Object.keys(FILES).sort());
    const byPath = new Map(hybrid.map((c) => [c.path, c]));
    expect(byPath.get('src/invoice.ts')).toEqual({
      rank: expect.any(Number),
      artifactId: expect.any(Number),
      versionId: expect.any(Number),
      path: 'src/invoice.ts',
      kind: 'code',
      rrfScore: expect.any(Number),
      deterministicRank: expect.any(Number),
      semanticRank: expect.any(Number),
      deterministicCategory: 'critical-structural',
    });
    // Found by the semantic ranking alone.
    expect(byPath.get('docs/other.md')).toMatchObject({ deterministicRank: null, deterministicCategory: null, semanticRank: expect.any(Number) });
    // The changed file is an ordinary candidate: the production API does not remove it.
    expect(byPath.has('src/billing.ts')).toBe(true);
  });

  it('lets agreement between the two rankings lift a candidate', async () => {
    const snapshotId = await readySnapshot();
    const hybrid = await searchHybrid(db, snapshotId, provider, QUERY);

    const refunds = hybrid.find((c) => c.path === 'docs/refunds.md')!;
    const other = hybrid.find((c) => c.path === 'docs/other.md')!;
    expect(refunds.deterministicRank).not.toBeNull();
    expect(refunds.semanticRank).not.toBeNull();
    expect(refunds.rank).toBeLessThan(other.rank);
  });

  it('passes explicit symbols to the lexical side', async () => {
    const snapshotId = await readySnapshot({ 'src/some.ts': `export function some() {}\n`, 'docs/a.md': `text\n` });
    const without = await searchHybrid(db, snapshotId, provider, { description: 'unrelated words', changedPaths: [] });
    const withSymbol = await searchHybrid(db, snapshotId, provider, { description: 'unrelated words', changedPaths: [], symbols: ['some'] });

    expect(without.find((c) => c.path === 'src/some.ts')!.deterministicRank).toBeNull();
    expect(withSymbol.find((c) => c.path === 'src/some.ts')!.deterministicRank).not.toBeNull();
  });

  it('is deterministic', async () => {
    const snapshotId = await readySnapshot();
    expect(await searchHybrid(db, snapshotId, provider, QUERY)).toEqual(await searchHybrid(db, snapshotId, provider, QUERY));
  });

  it('never returns an artifact that is not in the requested snapshot', async () => {
    const early = await readySnapshot({ 'src/billing.ts': `export const billing = 1;\n`, 'docs/a.md': `refund\n` });
    const late = await readySnapshot({
      'src/invoice.ts': `import { billing } from './billing';\n`,
      'docs/new-refunds.md': `refund refund billing\n`,
    });

    const atEarly = await searchHybrid(db, early, provider, QUERY);
    const atLate = await searchHybrid(db, late, provider, QUERY);

    expect(atEarly.map((c) => c.path).sort()).toEqual(['docs/a.md', 'src/billing.ts']);
    expect(atLate.map((c) => c.path)).toContain('docs/new-refunds.md');
    expect(atLate.map((c) => c.path)).toContain('src/invoice.ts');
    expect(atEarly.find((c) => c.path === 'src/billing.ts')!.versionId).not.toBe(atLate.find((c) => c.path === 'src/billing.ts')!.versionId);
  });
});

describe('searchHybrid requirements', () => {
  it('rejects an unknown snapshot and a failed one', async () => {
    const sha = fixture.commit({ 'a.md': 'broken blob\n' });
    fixture.deleteObject(fixture.git('rev-parse', `${sha}:a.md`));
    await expect(ingestSnapshot(db, repository.id, sha)).rejects.toThrow();
    const failedId = findSnapshot(db, repository.id, sha)!.id;

    await expect(searchHybrid(db, 999, provider, QUERY)).rejects.toThrow(NotFoundError);
    await expect(searchHybrid(db, failedId, provider, QUERY)).rejects.toThrow(SnapshotNotReadyError);
    expect(provider.calls).toBe(0);
  });

  it('rejects a snapshot without a lexical index, before calling the provider', async () => {
    const snapshotId = await ingest(fixture.commit(FILES));
    indexSnapshotStructurally(db, snapshotId);
    await indexSnapshotSemantically(db, snapshotId, provider);
    const calls = provider.calls;

    await expect(searchHybrid(db, snapshotId, provider, QUERY)).rejects.toThrow(LexicalIndexNotBuiltError);
    expect(provider.calls).toBe(calls);
  });

  it('rejects a snapshot without a structural index, before calling the provider', async () => {
    const snapshotId = await ingest(fixture.commit(FILES));
    indexSnapshotLexically(db, snapshotId);
    await indexSnapshotSemantically(db, snapshotId, provider);
    const calls = provider.calls;

    await expect(searchHybrid(db, snapshotId, provider, QUERY)).rejects.toThrow(StructuralIndexNotBuiltError);
    expect(provider.calls).toBe(calls);
  });

  it('rejects a snapshot without a semantic index for the provider, before calling the provider', async () => {
    const snapshotId = await ingest(fixture.commit(FILES));
    indexSnapshotLexically(db, snapshotId);
    indexSnapshotStructurally(db, snapshotId);

    await expect(searchHybrid(db, snapshotId, provider, QUERY)).rejects.toThrow(SemanticIndexNotBuiltError);
    expect(provider.calls).toBe(0);

    // Indexed for one model is not indexed for another.
    await indexSnapshotSemantically(db, snapshotId, provider);
    const other = new FakeEmbeddingProvider(VOCABULARY, { modelId: 'fake:other' });
    await expect(searchHybrid(db, snapshotId, other, QUERY)).rejects.toThrow(SemanticIndexNotBuiltError);
    expect(other.calls).toBe(0);
  });

  it('rejects an incompatible semantic index instead of using it', async () => {
    const snapshotId = await readySnapshot();
    const incompatible = new FakeEmbeddingProvider(['billing'], { modelId: provider.modelId });

    await expect(searchHybrid(db, snapshotId, incompatible, QUERY)).rejects.toThrow(SemanticIndexIncompatibleError);
    expect(incompatible.calls).toBe(0);
  });

  it('does not change what any index records', async () => {
    const snapshotId = await readySnapshot();
    const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const tables = ['content_token', 'snapshot_relationship', 'semantic_embedding', 'semantic_chunk', 'repository_snapshot'];
    const before = tables.map(count);

    await searchHybrid(db, snapshotId, provider, QUERY);

    expect(tables.map(count)).toEqual(before);
  });
});
