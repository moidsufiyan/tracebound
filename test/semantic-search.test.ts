import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findArtifactAtSnapshot } from '../src/artifacts/artifacts.js';
import { openDatabase, type Database } from '../src/db/database.js';
import { ingestSnapshot } from '../src/ingestion/ingest-snapshot.js';
import { createProject, NotFoundError, registerRepository, type Repository } from '../src/projects/projects.js';
import { findSnapshot, SnapshotNotReadyError } from '../src/snapshots/snapshots.js';
import { chunkArtifact, embeddingInputHash, formatSemanticQuery } from '../src/semantic/chunking.js';
import { EmbeddingInputTooLongError, type EmbeddingProvider } from '../src/semantic/provider.js';
import {
  indexSnapshotSemantically,
  isSnapshotSemanticallyIndexed,
  SemanticIndexIncompatibleError,
  SemanticIndexNotBuiltError,
} from '../src/semantic/semantic-index.js';
import { searchSemantic } from '../src/semantic/semantic-search.js';
import { cosineSimilarity, decodeVector, EmbeddingResponseError } from '../src/semantic/vectors.js';
import { FakeEmbeddingProvider } from './fake-embedding-provider.js';
import { FixtureRepo } from './git-fixture.js';

const VOCABULARY = ['lock', 'order', 'refund', 'cart', 'stock'];

let db: Database;
let fixture: FixtureRepo;
let repository: Repository;
let provider: FakeEmbeddingProvider;
const extraFixtures: FixtureRepo[] = [];

async function register(source: FixtureRepo): Promise<Repository> {
  const project = createProject(db, `project-${Math.random()}`);
  return registerRepository(db, { projectId: project.id, name: 'repo', sourcePath: source.path });
}

async function ingest(sha: string, target: Repository = repository): Promise<number> {
  return (await ingestSnapshot(db, target.id, sha)).snapshot.id;
}

function count(table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const QUERY = { description: 'fix the lock', changedPaths: ['src/lock.ts'] };

beforeEach(async () => {
  db = openDatabase(':memory:');
  fixture = new FixtureRepo();
  repository = await register(fixture);
  provider = new FakeEmbeddingProvider(VOCABULARY);
});

afterEach(() => {
  db.close();
  fixture.remove();
  for (const extra of extraFixtures.splice(0)) extra.remove();
});

describe('indexSnapshotSemantically', () => {
  it('embeds the exact B7.1 input of every artifact and stores it under the model and input hash', async () => {
    const sha = fixture.commit({ 'docs/locks.md': 'lock lock\n', 'src/cart.ts': 'cart stock\n' });
    const snapshotId = await ingest(sha);

    const result = await indexSnapshotSemantically(db, snapshotId, provider);

    expect(result).toEqual({ indexed: true, artifacts: 2, chunks: 2, embeddingsReused: 0, embeddingsCreated: 2 });
    expect([...provider.embedded].sort()).toEqual([
      'search_document: File: docs/locks.md\n\nlock lock\n',
      'search_document: File: src/cart.ts\n\ncart stock\n',
    ]);
    const stored = db
      .prepare('SELECT model_id, input_hash, dimensions, length(vector) AS bytes FROM semantic_embedding ORDER BY input_hash')
      .all() as unknown as { model_id: string; input_hash: string; dimensions: number; bytes: number }[];
    expect(stored.map((r) => r.input_hash)).toEqual(provider.embedded.map(embeddingInputHash).sort());
    expect(stored.every((r) => r.model_id === 'fake:model' && r.dimensions === 6 && r.bytes === 24)).toBe(true);
    expect(isSnapshotSemanticallyIndexed(db, snapshotId, provider)).toBe(true);
  });

  it('stores vectors that decode to exactly what the provider returned', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.md': 'lock order\n' }));
    await indexSnapshotSemantically(db, snapshotId, provider);

    const row = db.prepare('SELECT vector, dimensions FROM semantic_embedding').get() as { vector: Uint8Array; dimensions: number };
    const [expected] = await provider.embed(['search_document: File: a.md\n\nlock order\n']);
    expect(decodeVector(row.vector, row.dimensions)).toEqual(expected);
  });

  it('is idempotent and does not call the provider again', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.md': 'lock\n', 'b.md': 'order\n' }));
    await indexSnapshotSemantically(db, snapshotId, provider);
    const calls = provider.calls;
    const before = [count('semantic_embedding'), count('semantic_chunk'), count('semantic_indexed_snapshot')];

    expect(await indexSnapshotSemantically(db, snapshotId, provider)).toEqual({
      indexed: false,
      artifacts: 0,
      chunks: 0,
      embeddingsReused: 0,
      embeddingsCreated: 0,
    });
    expect(provider.calls).toBe(calls);
    expect([count('semantic_embedding'), count('semantic_chunk'), count('semantic_indexed_snapshot')]).toEqual(before);
  });

  it('reuses stored embeddings across snapshots and only embeds what is new or changed', async () => {
    const first = fixture.commit({ 'a.md': 'lock\n', 'b.md': 'order\n', 'c.md': 'cart\n' });
    const second = fixture.commit({ 'b.md': 'order refund\n', 'd.md': 'stock\n' });
    const s1 = await ingest(first);
    const s2 = await ingest(second);
    await indexSnapshotSemantically(db, s1, provider);
    provider.embedded.length = 0;

    const result = await indexSnapshotSemantically(db, s2, provider);

    expect(result).toMatchObject({ artifacts: 4, embeddingsReused: 2, embeddingsCreated: 2 });
    expect([...provider.embedded].sort()).toEqual([
      'search_document: File: b.md\n\norder refund\n',
      'search_document: File: d.md\n\nstock\n',
    ]);
  });

  it('embeds identical content again under another path, because the path is part of the input', async () => {
    const snapshotId = await ingest(fixture.commit({ 'one/a.md': 'lock\n', 'two/a.md': 'lock\n' }));
    const result = await indexSnapshotSemantically(db, snapshotId, provider);
    expect(result).toMatchObject({ chunks: 2, embeddingsCreated: 2 });
  });

  it('embeds an input once when it appears twice in the snapshot', async () => {
    const path = 'same.md';
    const snapshotId = await ingest(fixture.commit({ [path]: 'lock\n' }));
    // Reuse across repositories: the same path and text in a second repository is already embedded.
    const other = new FixtureRepo();
    extraFixtures.push(other);
    const otherSnapshot = await ingest(other.commit({ [path]: 'lock\n' }), await register(other));

    await indexSnapshotSemantically(db, snapshotId, provider);
    expect(await indexSnapshotSemantically(db, otherSnapshot, provider)).toMatchObject({ embeddingsReused: 1, embeddingsCreated: 0 });
    expect(count('semantic_embedding')).toBe(1);
    expect(count('semantic_chunk')).toBe(2);
  });

  it('records every chunk of a large artifact and embeds each piece within the limit', async () => {
    const small = new FakeEmbeddingProvider(VOCABULARY, { maxInputChars: 400 });
    const text = Array.from({ length: 8 }, (_, i) => `# Part ${i}\n${'lock '.repeat(40)}\n`).join('');
    const snapshotId = await ingest(fixture.commit({ 'docs/big.md': text }));

    const result = await indexSnapshotSemantically(db, snapshotId, small);

    const expected = chunkArtifact('docs/big.md', text, 400);
    expect(expected.length).toBeGreaterThan(3);
    expect(result).toMatchObject({ artifacts: 1, chunks: expected.length });
    expect(small.embedded.every((input) => input.length <= 400)).toBe(true);
  });

  it('leaves canonical rows and the snapshot status untouched', async () => {
    const sha = fixture.commit({ 'a.md': 'lock\n' });
    const snapshotId = await ingest(sha);
    const canonical = () => [count('repository_snapshot'), count('artifact'), count('artifact_version'), count('content')];
    const before = canonical();
    const snapshot = findSnapshot(db, repository.id, sha);

    await indexSnapshotSemantically(db, snapshotId, provider);

    expect(canonical()).toEqual(before);
    expect(findSnapshot(db, repository.id, sha)).toEqual(snapshot);
  });
});

describe('failed or incomplete indexing', () => {
  const manyFiles = () => Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`docs/f${String(i).padStart(2, '0')}.md`, `lock ${i}\n`]));

  it('does not mark the snapshot indexed or record chunks when a later batch fails, and a retry sends only what is missing', async () => {
    const snapshotId = await ingest(fixture.commit(manyFiles()));
    provider.failOnCall = 2;

    await expect(indexSnapshotSemantically(db, snapshotId, provider)).rejects.toThrow(/Embedding failed for a batch of 4 inputs/);

    expect(isSnapshotSemanticallyIndexed(db, snapshotId, provider)).toBe(false);
    expect(count('semantic_chunk')).toBe(0);
    expect(count('semantic_indexed_snapshot')).toBe(0);
    expect(count('semantic_embedding')).toBe(16); // the first batch was kept
    await expect(searchSemantic(db, snapshotId, provider, QUERY)).rejects.toThrow(SemanticIndexNotBuiltError);

    provider.failOnCall = undefined;
    provider.embedded.length = 0;
    const retry = await indexSnapshotSemantically(db, snapshotId, provider);

    expect(provider.embedded).toHaveLength(4);
    expect(retry).toMatchObject({ indexed: true, chunks: 20, embeddingsReused: 16, embeddingsCreated: 4 });
    expect(count('semantic_chunk')).toBe(20);
  });

  it('keeps the cause of a provider failure', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.md': 'lock\n' }));
    provider.failOnCall = 1;
    await expect(indexSnapshotSemantically(db, snapshotId, provider)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'provider unavailable' }),
    });
  });

  it('rejects a provider answer with the wrong number of vectors and stores nothing', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.md': 'lock\n', 'b.md': 'order\n' }));
    const short: EmbeddingProvider = { ...provider, embed: async (texts) => (await provider.embed(texts)).slice(1) };

    await expect(indexSnapshotSemantically(db, snapshotId, short)).rejects.toMatchObject({ cause: expect.any(EmbeddingResponseError) });
    expect(count('semantic_embedding')).toBe(0);
    expect(count('semantic_indexed_snapshot')).toBe(0);
  });

  it('rejects vectors of the wrong dimensionality and all-zero vectors', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.md': 'lock\n' }));
    const wrongSize: EmbeddingProvider = { ...provider, embed: async (texts) => texts.map(() => Float32Array.from([1, 2])) };
    const zero: EmbeddingProvider = { ...provider, embed: async (texts) => texts.map(() => new Float32Array(provider.dimensions)) };

    await expect(indexSnapshotSemantically(db, snapshotId, wrongSize)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/2 dimensions, expected 6/) }),
    });
    await expect(indexSnapshotSemantically(db, snapshotId, zero)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/zero vector/) }),
    });
    expect(count('semantic_embedding')).toBe(0);
  });

  it('rejects unknown and failed snapshots for indexing and searching', async () => {
    const sha = fixture.commit({ 'a.md': 'broken blob\n' });
    fixture.deleteObject(fixture.git('rev-parse', `${sha}:a.md`));
    await expect(ingestSnapshot(db, repository.id, sha)).rejects.toThrow();
    const failedId = findSnapshot(db, repository.id, sha)!.id;

    await expect(indexSnapshotSemantically(db, 999, provider)).rejects.toThrow(NotFoundError);
    await expect(indexSnapshotSemantically(db, failedId, provider)).rejects.toThrow(SnapshotNotReadyError);
    await expect(searchSemantic(db, 999, provider, QUERY)).rejects.toThrow(NotFoundError);
    await expect(searchSemantic(db, failedId, provider, QUERY)).rejects.toThrow(SnapshotNotReadyError);
    expect(provider.calls).toBe(0);
  });

  it('refuses to search a snapshot that has not been indexed, without calling the provider', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.md': 'lock\n' }));
    await expect(searchSemantic(db, snapshotId, provider, QUERY)).rejects.toThrow(SemanticIndexNotBuiltError);
    expect(provider.calls).toBe(0);
  });
});

describe('inputs the provider rejects as too long', () => {
  // A long input that contains DENSE is beyond this model's context, like encoded keys are for a real one.
  const denseLine = (i: number) => `DENSE ${i} lock ${'k'.repeat(90)}\n`;
  const dense = Array.from({ length: 16 }, (_, i) => denseLine(i)).join('');
  const pickyProvider = () =>
    new FakeEmbeddingProvider(VOCABULARY, { maxInputChars: 3000, rejects: (text) => text.includes('DENSE') && text.length > 1000 });
  const chunksOf = (path: string) =>
    (db.prepare('SELECT count(*) AS n FROM semantic_chunk c JOIN artifact a ON a.id = c.artifact_id WHERE a.path = ?').get(path) as { n: number }).n;

  it('chunks the artifact smaller instead of truncating, until every piece is accepted', async () => {
    const picky = pickyProvider();
    const snapshotId = await ingest(fixture.commit({ 'keys.json': dense, 'docs/plain.md': 'order\n' }));

    const result = await indexSnapshotSemantically(db, snapshotId, picky);

    expect(result.indexed).toBe(true);
    expect(result.artifacts).toBe(2);
    expect(chunksOf('keys.json')).toBeGreaterThan(2);
    // Everything the provider accepted is a complete piece of the file: nothing was cut short.
    const accepted = (
      db
        .prepare(
          `SELECT c.chunk_index, e.input_hash FROM semantic_chunk c
           JOIN artifact a ON a.id = c.artifact_id JOIN semantic_embedding e ON e.input_hash = c.input_hash
           WHERE a.path = 'keys.json' ORDER BY c.chunk_index`,
        )
        .all() as unknown as { chunk_index: number; input_hash: string }[]
    ).map((row) => picky.embedded.find((text) => embeddingInputHash(text) === row.input_hash)!);
    expect(accepted.every((text) => text.length <= 1000)).toBe(true);
    // Line splitting ends every line with a newline, as in B7.1, so a final newline is repeated.
    expect(accepted.map((text) => text.slice(text.indexOf('\n\n') + 2)).join('')).toBe(`${dense}\n`);
    // The plain file keeps its single whole-file input.
    expect(picky.embedded).toContain('search_document: File: docs/plain.md\n\norder\n');
    expect((await searchSemantic(db, snapshotId, picky, QUERY)).map((c) => c.path).sort()).toEqual(['docs/plain.md', 'keys.json']);
  });

  it('only shrinks the artifacts that were rejected', async () => {
    const other = Array.from({ length: 16 }, (_, i) => `plain ${i} lock ${'k'.repeat(90)}\n`).join('');
    const snapshotId = await ingest(fixture.commit({ 'keys.json': dense, 'other.json': other }));

    await indexSnapshotSemantically(db, snapshotId, pickyProvider());

    expect(chunksOf('other.json')).toBe(chunkArtifact('other.json', other, 3000).length);
    expect(chunksOf('keys.json')).toBeGreaterThan(chunksOf('other.json'));
  });

  it('fails clearly, without marking the snapshot indexed, when even small pieces are rejected', async () => {
    const hopeless = new FakeEmbeddingProvider(VOCABULARY, { maxInputChars: 3000, rejects: (text) => text.includes('DENSE') });
    const snapshotId = await ingest(fixture.commit({ 'keys.json': dense, 'docs/plain.md': 'order\n' }));

    await expect(indexSnapshotSemantically(db, snapshotId, hopeless)).rejects.toThrow(EmbeddingInputTooLongError);
    await expect(indexSnapshotSemantically(db, snapshotId, hopeless)).rejects.toThrow(/keys\.json is still rejected/);

    expect(isSnapshotSemanticallyIndexed(db, snapshotId, hopeless)).toBe(false);
    expect(count('semantic_chunk')).toBe(0);
    expect(count('semantic_indexed_snapshot')).toBe(0);
  });
});

describe('searchSemantic', () => {
  async function indexed(files: Record<string, string>, using: EmbeddingProvider = provider): Promise<number> {
    const snapshotId = await ingest(fixture.commit(files));
    await indexSnapshotSemantically(db, snapshotId, using);
    return snapshotId;
  }

  it('ranks artifacts by exact cosine similarity and reports the candidate contract', async () => {
    const snapshotId = await indexed({
      'docs/locks.md': 'lock lock lock\n',
      'docs/orders.md': 'order lock\n',
      'src/cart.ts': 'cart stock\n',
    });

    const candidates = await searchSemantic(db, snapshotId, provider, QUERY);

    expect(candidates.map((c) => [c.rank, c.path])).toEqual([
      [1, 'docs/locks.md'],
      [2, 'docs/orders.md'],
      [3, 'src/cart.ts'],
    ]);
    const first = candidates[0]!;
    const artifact = findArtifactAtSnapshot(db, snapshotId, 'docs/locks.md')!;
    expect(first).toEqual({
      rank: 1,
      artifactId: artifact.artifactId,
      versionId: artifact.versionId,
      path: 'docs/locks.md',
      kind: 'document',
      similarityScore: expect.any(Number),
      bestChunkIndex: 0,
    });
    expect(candidates[2]!.kind).toBe('code');
  });

  it('computes the similarity of the formatted query and the formatted document', async () => {
    const snapshotId = await indexed({ 'docs/locks.md': 'lock lock lock\n' });
    const [query] = await provider.embed([formatSemanticQuery(QUERY.description, QUERY.changedPaths)]);
    const [document] = await provider.embed(['search_document: File: docs/locks.md\n\nlock lock lock\n']);

    const [candidate] = await searchSemantic(db, snapshotId, provider, QUERY);

    expect(candidate!.similarityScore).toBeCloseTo(cosineSimilarity(query!, document!), 6);
    expect(provider.embedded.at(-1)).toBe(
      'search_query: Change Description: fix the lock\nFiles Modified:\n- src/lock.ts',
    );
  });

  it('returns one candidate per artifact, scored by its best chunk', async () => {
    const small = new FakeEmbeddingProvider(VOCABULARY, { maxInputChars: 500 });
    const text = `# Intro\n${'filler '.repeat(60)}\n# Locks\n${'lock '.repeat(80)}\n# Outro\n${'filler '.repeat(60)}\n`;
    const snapshotId = await indexed({ 'docs/big.md': text, 'docs/other.md': 'order\n' }, small);
    const chunks = chunkArtifact('docs/big.md', text, 500);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const candidates = await searchSemantic(db, snapshotId, small, QUERY);

    expect(candidates.map((c) => c.path)).toEqual(['docs/big.md', 'docs/other.md']);
    const winner = chunks.findIndex((chunk) => chunk.text.includes('lock lock'));
    expect(candidates[0]!.bestChunkIndex).toBe(winner);
    const [query] = await small.embed([formatSemanticQuery(QUERY.description, QUERY.changedPaths)]);
    const scores = await Promise.all(chunks.map(async (chunk) => cosineSimilarity(query!, (await small.embed([chunk.text]))[0]!)));
    expect(candidates[0]!.similarityScore).toBeCloseTo(Math.max(...scores), 6);
  });

  it('orders equal scores by path, deterministically', async () => {
    // Same text under different paths: the vocabulary ignores paths, so the vectors are identical.
    const snapshotId = await indexed({ 'z/x.md': 'lock\n', 'a/x.md': 'lock\n', 'm/x.md': 'lock\n' });

    const first = await searchSemantic(db, snapshotId, provider, QUERY);

    expect(first.map((c) => c.path)).toEqual(['a/x.md', 'm/x.md', 'z/x.md']);
    expect(new Set(first.map((c) => c.similarityScore)).size).toBe(1);
    expect(await searchSemantic(db, snapshotId, provider, QUERY)).toEqual(first);
  });

  it('gives identical results in independent databases', async () => {
    const sha = fixture.commit({ 'a.md': 'lock\n', 'b.md': 'order lock\n', 'c.md': 'cart\n' });
    const mine = await ingest(sha);
    await indexSnapshotSemantically(db, mine, provider);

    const other = openDatabase(':memory:');
    try {
      const repo = await registerRepository(other, { projectId: createProject(other, 'p').id, name: 'r', sourcePath: fixture.path });
      const id = (await ingestSnapshot(other, repo.id, sha)).snapshot.id;
      const otherProvider = new FakeEmbeddingProvider(VOCABULARY);
      await indexSnapshotSemantically(other, id, otherProvider);
      const strip = (list: Awaited<ReturnType<typeof searchSemantic>>) => list.map(({ artifactId, versionId, ...rest }) => rest);
      expect(strip(await searchSemantic(other, id, otherProvider, QUERY))).toEqual(strip(await searchSemantic(db, mine, provider, QUERY)));
    } finally {
      other.close();
    }
  });
});

describe('snapshot isolation', () => {
  it('never returns an artifact absent from the snapshot, even when its embedding exists', async () => {
    const early = fixture.commit({ 'docs/a.md': 'lock\n' });
    const late = fixture.commit({ 'docs/new.md': 'lock lock lock lock\n' });
    const earlyId = await ingest(early);
    const lateId = await ingest(late);
    // The later snapshot is indexed first, so the late-only embedding is already in the database.
    await indexSnapshotSemantically(db, lateId, provider);
    await indexSnapshotSemantically(db, earlyId, provider);

    expect((await searchSemantic(db, earlyId, provider, QUERY)).map((c) => c.path)).toEqual(['docs/a.md']);
    expect((await searchSemantic(db, lateId, provider, QUERY)).map((c) => c.path)).toEqual(['docs/new.md', 'docs/a.md']);
  });

  it('shows deleted artifacts and old content in the snapshot where they existed', async () => {
    const early = fixture.commit({ 'gone.md': 'lock\n', 'kept.md': 'lock lock\n' });
    const late = fixture.commit({ 'kept.md': 'order order\n' }, { remove: ['gone.md'] });
    const earlyId = await ingest(early);
    const lateId = await ingest(late);
    await indexSnapshotSemantically(db, earlyId, provider);
    await indexSnapshotSemantically(db, lateId, provider);

    const atEarly = await searchSemantic(db, earlyId, provider, QUERY);
    const atLate = await searchSemantic(db, lateId, provider, QUERY);

    expect(atEarly.map((c) => c.path)).toEqual(['kept.md', 'gone.md']);
    expect(atLate.map((c) => c.path)).toEqual(['kept.md']);
    expect(atLate[0]!.similarityScore).toBeLessThan(atEarly[0]!.similarityScore);
  });

  it('keeps repositories apart even when their paths and texts are identical', async () => {
    const other = new FixtureRepo();
    extraFixtures.push(other);
    const otherRepository = await register(other);
    const mine = await ingest(fixture.commit({ 'docs/a.md': 'lock\n' }));
    const theirs = await ingest(other.commit({ 'docs/a.md': 'lock\n', 'docs/extra.md': 'lock\n' }), otherRepository);
    await indexSnapshotSemantically(db, mine, provider);
    await indexSnapshotSemantically(db, theirs, provider);

    const mineResults = await searchSemantic(db, mine, provider, QUERY);
    const theirResults = await searchSemantic(db, theirs, provider, QUERY);

    expect(mineResults.map((c) => c.path)).toEqual(['docs/a.md']);
    expect(theirResults.map((c) => c.path)).toEqual(['docs/a.md', 'docs/extra.md']);
    expect(mineResults[0]!.artifactId).not.toBe(theirResults[0]!.artifactId);
  });
});

describe('model isolation', () => {
  it('indexes and searches each model separately and never mixes their vectors', async () => {
    const other = new FakeEmbeddingProvider(['lock', 'order'], { modelId: 'fake:other' });
    const snapshotId = await ingest(fixture.commit({ 'a.md': 'lock\n', 'b.md': 'order order\n' }));
    await indexSnapshotSemantically(db, snapshotId, provider);

    // The second model has no index yet, although the first one does.
    await expect(searchSemantic(db, snapshotId, other, QUERY)).rejects.toThrow(SemanticIndexNotBuiltError);
    await indexSnapshotSemantically(db, snapshotId, other);

    expect(count('semantic_embedding')).toBe(4);
    const rows = db.prepare('SELECT model_id, dimensions, count(*) AS n FROM semantic_embedding GROUP BY model_id ORDER BY model_id').all();
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { model_id: 'fake:model', dimensions: 6, n: 2 },
      { model_id: 'fake:other', dimensions: 3, n: 2 },
    ]);
    const first = await searchSemantic(db, snapshotId, provider, QUERY);
    const second = await searchSemantic(db, snapshotId, other, QUERY);
    expect(first.map((c) => c.path)).toEqual(['a.md', 'b.md']);
    expect(second.map((c) => c.path)).toEqual(['a.md', 'b.md']);
  });

  it('refuses stored data for the same model id when dimensions or limits differ', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.md': 'lock\n' }));
    await indexSnapshotSemantically(db, snapshotId, provider);

    const otherDimensions = new FakeEmbeddingProvider(['lock'], { modelId: provider.modelId });
    const otherLimit = new FakeEmbeddingProvider(VOCABULARY, { modelId: provider.modelId, maxInputChars: 999 });

    await expect(searchSemantic(db, snapshotId, otherDimensions, QUERY)).rejects.toThrow(SemanticIndexIncompatibleError);
    await expect(indexSnapshotSemantically(db, snapshotId, otherDimensions)).rejects.toThrow(/stored 6 dimensions, provider has 2/);
    await expect(searchSemantic(db, snapshotId, otherLimit, QUERY)).rejects.toThrow(/chunked for 2000 characters/);
    expect(otherDimensions.calls).toBe(0);
  });

  it('refuses to reuse a stored embedding of the same model id with other dimensions', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.md': 'lock\n' }));
    const impostor = new FakeEmbeddingProvider(['lock'], { modelId: provider.modelId });
    await indexSnapshotSemantically(db, snapshotId, impostor);
    db.prepare('DELETE FROM semantic_chunk').run();
    db.prepare('DELETE FROM semantic_indexed_snapshot').run();

    await expect(indexSnapshotSemantically(db, snapshotId, provider)).rejects.toThrow(SemanticIndexIncompatibleError);
  });

  it('does not accept a zero query vector', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.md': 'lock\n' }));
    await indexSnapshotSemantically(db, snapshotId, provider);
    const zeroQuery: EmbeddingProvider = { ...provider, embed: async (texts) => texts.map(() => new Float32Array(provider.dimensions)) };

    await expect(searchSemantic(db, snapshotId, zeroQuery, QUERY)).rejects.toThrow(/zero vector/);
  });
});
