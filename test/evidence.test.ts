import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexSnapshotStructurally, StructuralIndexNotBuiltError } from '../src/analysis/structural-index.js';
import { findArtifactAtSnapshot } from '../src/artifacts/artifacts.js';
import { openDatabase, type Database } from '../src/db/database.js';
import { ingestSnapshot } from '../src/ingestion/ingest-snapshot.js';
import { createProject, NotFoundError, registerRepository, type Repository } from '../src/projects/projects.js';
import {
  constructEvidence,
  DEFAULT_EVIDENCE_LIMIT,
  type Evidence,
  type EvidenceBundle,
  type FusionEvidence,
  type LexicalEvidence,
  type SemanticEvidence,
  type StructuralEvidence,
} from '../src/retrieval/evidence.js';
import { searchHybrid, searchHybridDetailed, type HybridQuery, type HybridSearchResult } from '../src/retrieval/hybrid-search.js';
import { indexSnapshotLexically, LexicalIndexNotBuiltError } from '../src/retrieval/lexical-index.js';
import { fuseRrf, InconsistentCandidateError } from '../src/retrieval/rrf.js';
import { chunkArtifact, embeddingInputHash } from '../src/semantic/chunking.js';
import type { EmbeddingProvider } from '../src/semantic/provider.js';
import { indexSnapshotSemantically, SemanticIndexNotBuiltError } from '../src/semantic/semantic-index.js';
import { findSnapshot, SnapshotNotReadyError } from '../src/snapshots/snapshots.js';
import { FakeEmbeddingProvider } from './fake-embedding-provider.js';
import { FixtureRepo } from './git-fixture.js';

const VOCABULARY = ['billing', 'ledger', 'refund', 'invoice', 'money'];

let db: Database;
let fixture: FixtureRepo;
let repository: Repository;
let provider: FakeEmbeddingProvider;

// A change to src/billing.ts. invoice.ts (multi-line import) and billing.test.ts (a .js specifier)
// import it; billing.ts imports ledger.ts and money.ts.
const BILLING = [
  `import { post } from './ledger';`,
  `import type { Money } from "./money";`,
  `export const billing = post;`,
  ``,
].join('\n');
const INVOICE = [`// invoices`, `import {`, `  billing,`, `} from './billing';`, `export const invoice = billing;`, ``].join('\n');
const FILES: Record<string, string> = {
  'src/billing.ts': BILLING,
  'src/ledger.ts': `export const post = 1;\n`,
  'src/money.ts': `export type Money = number;\n`,
  'src/invoice.ts': INVOICE,
  'src/billing.test.ts': `import { billing } from './billing.js';\nexport const check = billing;\n`,
  'docs/refunds.md': `A refund is posted to the billing ledger.\n`,
  'docs/other.md': `Nothing to do with it.\n`,
};

const QUERY: HybridQuery = { description: 'fix refund billing', changedPaths: ['src/billing.ts'] };

async function ingest(sha: string): Promise<number> {
  return (await ingestSnapshot(db, repository.id, sha)).snapshot.id;
}

async function readySnapshot(files: Record<string, string> = FILES, using: EmbeddingProvider = provider): Promise<number> {
  const snapshotId = await ingest(fixture.commit(files));
  indexSnapshotLexically(db, snapshotId);
  indexSnapshotStructurally(db, snapshotId);
  await indexSnapshotSemantically(db, snapshotId, using);
  return snapshotId;
}

async function evidenceFor(
  files: Record<string, string> = FILES,
  query: HybridQuery = QUERY,
  options: { limit?: number } = {},
): Promise<{ snapshotId: number; result: HybridSearchResult; bundle: EvidenceBundle }> {
  const snapshotId = await readySnapshot(files);
  const result = await searchHybridDetailed(db, snapshotId, provider, query);
  return { snapshotId, result, bundle: constructEvidence(db, snapshotId, provider, result, options) };
}

const candidateOf = (bundle: EvidenceBundle, path: string) => bundle.candidates.find((c) => c.path === path)!;
const ofType = <T extends Evidence['type']>(bundle: EvidenceBundle, path: string, type: T) =>
  candidateOf(bundle, path).evidence.filter((e): e is Extract<Evidence, { type: T }> => e.type === type);

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

describe('the detailed hybrid result', () => {
  it('returns exactly what searchHybrid returns, along with the rankings that produced it', async () => {
    const snapshotId = await readySnapshot();

    const detailed = await searchHybridDetailed(db, snapshotId, provider, QUERY);

    expect(detailed.fused).toEqual(await searchHybrid(db, snapshotId, provider, QUERY));
    expect(detailed).toMatchObject({ snapshotId, query: QUERY, rrfK: 60, modelId: provider.modelId });
    expect(detailed.fused).toEqual(fuseRrf(detailed.deterministic, detailed.semantic));
  });
});

describe('structural evidence', () => {
  it('describes an incoming import with its endpoints, specifier and exact multi-line declaration', async () => {
    const { bundle, snapshotId } = await evidenceFor();

    const [evidence] = ofType(bundle, 'src/invoice.ts', 'structural');

    const invoice = findArtifactAtSnapshot(db, snapshotId, 'src/invoice.ts')!;
    const billing = findArtifactAtSnapshot(db, snapshotId, 'src/billing.ts')!;
    expect(evidence).toEqual({
      type: 'structural',
      id: `structural:incoming-import:${invoice.versionId}>${billing.versionId}`,
      snapshotId,
      signal: 'incoming-import',
      relationship: 'imports',
      source: { artifactId: invoice.artifactId, versionId: invoice.versionId, path: 'src/invoice.ts' },
      target: { artifactId: billing.artifactId, versionId: billing.versionId, path: 'src/billing.ts' },
      candidateIs: 'source',
      changedPath: 'src/billing.ts',
      declarations: [
        {
          specifier: './billing',
          startLine: 2,
          endLine: 4,
          excerpt: { text: `import {\n  billing,\n} from './billing';`, truncated: false, totalChars: 39 },
        },
      ],
    });
    // The lines named are the lines of the file.
    expect(INVOICE.split('\n').slice(1, 4).join('\n')).toBe(evidence!.declarations![0]!.excerpt.text);
  });

  it('describes outgoing imports from the changed file, located in the changed file', async () => {
    const { bundle } = await evidenceFor();

    const [ledger] = ofType(bundle, 'src/ledger.ts', 'structural');
    const [money] = ofType(bundle, 'src/money.ts', 'structural');

    expect(ledger).toMatchObject({
      signal: 'outgoing-import',
      relationship: 'imports',
      candidateIs: 'target',
      source: { path: 'src/billing.ts' },
      target: { path: 'src/ledger.ts' },
      changedPath: 'src/billing.ts',
      declarations: [{ specifier: './ledger', startLine: 1, endLine: 1, excerpt: { text: `import { post } from './ledger';`, truncated: false } }],
    });
    // A type-only import is an import declaration too, and its quotes are the file's own.
    expect(money!.declarations).toEqual([
      { specifier: './money', startLine: 2, endLine: 2, excerpt: { text: `import type { Money } from "./money";`, truncated: false, totalChars: 37 } },
    ]);
  });

  it('describes a test as test-to-source, found through the specifier the file wrote', async () => {
    const { bundle } = await evidenceFor();

    const evidence = ofType(bundle, 'src/billing.test.ts', 'structural');

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      signal: 'test-to-source',
      relationship: 'test-to-source',
      candidateIs: 'source',
      source: { path: 'src/billing.test.ts' },
      target: { path: 'src/billing.ts' },
      declarations: [{ specifier: './billing.js', startLine: 1, endLine: 1 }],
    });
  });

  it('gives no structural evidence to a candidate with no relationship to a changed file', async () => {
    const { bundle } = await evidenceFor();
    expect(ofType(bundle, 'docs/refunds.md', 'structural')).toEqual([]);
  });

  it('keeps the fact but no source location when the declaration cannot be located', async () => {
    const files = { 'src/a.ts': `export const a = 1;\n`, 'src/b.ts': `export const b = 1;\n`, 'src/c.ts': `const = ;\n` };
    const snapshotId = await readySnapshot(files);
    // Relationships whose importing files hold no resolvable import: one has no import at all,
    // the other does not parse.
    const insert = db.prepare(
      `INSERT INTO snapshot_relationship (snapshot_id, source_artifact_id, target_artifact_id, kind) VALUES (?, ?, ?, 'imports')`,
    );
    const id = (path: string) => findArtifactAtSnapshot(db, snapshotId, path)!.artifactId;
    insert.run(snapshotId, id('src/a.ts'), id('src/b.ts'));
    insert.run(snapshotId, id('src/c.ts'), id('src/b.ts'));
    const result = await searchHybridDetailed(db, snapshotId, provider, { description: 'unrelated', changedPaths: ['src/b.ts'] });

    const bundle = constructEvidence(db, snapshotId, provider, result);

    for (const path of ['src/a.ts', 'src/c.ts']) {
      const [evidence] = ofType(bundle, path, 'structural');
      expect(evidence).toMatchObject({ signal: 'incoming-import', relationship: 'imports', source: { path }, target: { path: 'src/b.ts' } });
      expect(evidence!.declarations).toBeNull();
    }
  });

  it('bounds a long import statement and says it was cut', async () => {
    const names = Array.from({ length: 80 }, (_, i) => `exportedName${i}`);
    const longImport = `import {\n  ${names.join(',\n  ')},\n} from './billing';\n`;
    const { bundle } = await evidenceFor({ ...FILES, 'src/invoice.ts': longImport });

    const [evidence] = ofType(bundle, 'src/invoice.ts', 'structural');
    const [declaration] = evidence!.declarations!;

    expect(declaration!.excerpt.truncated).toBe(true);
    expect(declaration!.excerpt.text).toHaveLength(500);
    expect(declaration!.excerpt.totalChars).toBeGreaterThan(500);
    expect(longImport.startsWith(declaration!.excerpt.text)).toBe(true);
    expect(declaration).toMatchObject({ startLine: 1, endLine: 82 });
  });

  it('reports every declaration that resolves to the same file, without merging relationships', async () => {
    const twice = `import { a } from './billing';\nimport type { B } from './billing.js';\nexport const x = 1;\n`;
    const { bundle } = await evidenceFor({ ...FILES, 'src/invoice.ts': twice });

    const evidence = ofType(bundle, 'src/invoice.ts', 'structural');

    expect(evidence).toHaveLength(1); // one file-level relationship
    expect(evidence[0]!.declarations!.map((d) => [d.specifier, d.startLine])).toEqual([
      ['./billing', 1],
      ['./billing.js', 2],
    ]);
  });
});

describe('lexical evidence', () => {
  it('reports the matched terms, category and distinct-term counts of the deterministic candidate', async () => {
    const { bundle, result } = await evidenceFor();

    const [evidence] = ofType(bundle, 'docs/refunds.md', 'lexical');
    const source = result.deterministic.find((c) => c.path === 'docs/refunds.md')!;

    // Query terms are fix, refund and billing; the document contains refund and billing once each.
    expect(evidence).toEqual({
      type: 'lexical',
      id: `lexical:${source.versionId}`,
      matchedTerms: ['billing', 'refund'],
      lexicalCategory: 'multiple-terms',
      contentMatchCount: 2,
      pathMatchCount: 0,
    });
  });

  it('gives no lexical evidence to a purely structural or purely semantic candidate', async () => {
    const { bundle } = await evidenceFor();
    expect(ofType(bundle, 'src/ledger.ts', 'lexical')).toEqual([]); // found through the import only
    expect(ofType(bundle, 'docs/other.md', 'lexical')).toEqual([]); // found by meaning only
  });
});

describe('semantic evidence', () => {
  it('records the model, similarity, chunk, input hash and the original chunk text', async () => {
    const { bundle, result } = await evidenceFor();

    const [evidence] = ofType(bundle, 'docs/refunds.md', 'semantic');
    const source = result.semantic.find((c) => c.path === 'docs/refunds.md')!;

    expect(evidence).toEqual({
      type: 'semantic',
      id: `semantic:${source.versionId}:${provider.modelId}:0`,
      modelId: 'fake:model',
      similarityScore: source.similarityScore,
      bestChunkIndex: 0,
      chunkCount: 1,
      embeddingInputHash: embeddingInputHash('search_document: File: docs/refunds.md\n\nA refund is posted to the billing ledger.\n'),
      chunk: { text: 'A refund is posted to the billing ledger.\n', truncated: false, totalChars: 42 },
    });
  });

  it('shows the source of the winning chunk of a file with several, without the embedding framing', async () => {
    const small = new FakeEmbeddingProvider(VOCABULARY, { maxInputChars: 500 });
    const text = `# Intro\n${'filler '.repeat(60)}\n# Refunds\n${'refund billing '.repeat(25)}\n# Outro\n${'filler '.repeat(60)}\n`;
    const snapshotId = await readySnapshot({ 'docs/big.md': text, 'docs/other.md': 'invoice\n' }, small);
    const result = await searchHybridDetailed(db, snapshotId, small, { description: 'refund billing', changedPaths: [] });

    const bundle = constructEvidence(db, snapshotId, small, result);
    const [evidence] = ofType(bundle, 'docs/big.md', 'semantic');

    const inputs = chunkArtifact('docs/big.md', text, 500);
    expect(inputs.length).toBeGreaterThanOrEqual(3);
    expect(evidence!.chunkCount).toBe(inputs.length);
    const winner = inputs[evidence!.bestChunkIndex]!;
    expect(evidence!.embeddingInputHash).toBe(embeddingInputHash(winner.text));
    expect(evidence!.chunk!.text).toBe(winner.text.slice(winner.text.indexOf('\n\n') + 2));
    expect(evidence!.chunk!.text).toContain('refund billing');
    expect(evidence!.chunk!.text).not.toContain('search_document');
    expect(text).toContain(evidence!.chunk!.text.trimEnd());
  });

  it('finds the chunk of an artifact that indexing had to split smaller', async () => {
    const dense = Array.from({ length: 16 }, (_, i) => `DENSE ${i} refund billing ${'k'.repeat(90)}\n`).join('');
    const picky = new FakeEmbeddingProvider(VOCABULARY, { maxInputChars: 3000, rejects: (text) => text.includes('DENSE') && text.length > 1000 });
    const snapshotId = await readySnapshot({ 'keys.json': dense }, picky);
    const result = await searchHybridDetailed(db, snapshotId, picky, { description: 'refund billing', changedPaths: [] });

    const [evidence] = ofType(constructEvidence(db, snapshotId, picky, result), 'keys.json', 'semantic');

    expect(evidence!.chunkCount).toBeGreaterThan(2);
    expect(evidence!.chunk).not.toBeNull();
    expect(evidence!.chunk!.text.length).toBeLessThan(dense.length);
    expect(dense).toContain(evidence!.chunk!.text.trimEnd());
    expect(evidence!.chunk!.text).not.toContain('search_document');
  });

  it('omits the chunk text, and invents none, when the stored chunk cannot be matched to the content', async () => {
    const snapshotId = await readySnapshot();
    const result = await searchHybridDetailed(db, snapshotId, provider, QUERY);
    // Point the stored chunk at another document's embedding: a valid row that is not this file's input.
    const other = db.prepare(`SELECT input_hash FROM semantic_embedding WHERE input_hash <> ? LIMIT 1`).get(
      embeddingInputHash('search_document: File: docs/refunds.md\n\nA refund is posted to the billing ledger.\n'),
    ) as { input_hash: string };
    const artifactId = findArtifactAtSnapshot(db, snapshotId, 'docs/refunds.md')!.artifactId;
    db.prepare(`UPDATE semantic_chunk SET input_hash = ? WHERE snapshot_id = ? AND artifact_id = ?`).run(other.input_hash, snapshotId, artifactId);

    const [evidence] = ofType(constructEvidence(db, snapshotId, provider, result), 'docs/refunds.md', 'semantic');

    expect(evidence!.embeddingInputHash).toBe(other.input_hash); // what is stored is reported as stored
    expect(evidence!.chunk).toBeNull();
  });

  it('bounds a long chunk and says it was cut', async () => {
    const roomy = new FakeEmbeddingProvider(VOCABULARY, { maxInputChars: 3000 });
    const long = `${'refund billing '.repeat(150)}\n`; // 2,251 characters, one input
    const snapshotId = await readySnapshot({ 'docs/long.md': long }, roomy);
    const result = await searchHybridDetailed(db, snapshotId, roomy, { description: 'refund', changedPaths: [] });

    const [evidence] = ofType(constructEvidence(db, snapshotId, roomy, result), 'docs/long.md', 'semantic');

    expect(evidence!.chunk).toEqual({ text: long.slice(0, 1000), truncated: true, totalChars: long.length });
  });

  it('gives no semantic evidence to a candidate the semantic ranking did not rank', async () => {
    const snapshotId = await readySnapshot();
    const result = await searchHybridDetailed(db, snapshotId, provider, QUERY);
    const trimmed: HybridSearchResult = { ...result, semantic: [], fused: fuseRrf(result.deterministic, []) };

    const bundle = constructEvidence(db, snapshotId, provider, trimmed);

    expect(bundle.candidates.every((c) => c.evidence.every((e) => e.type !== 'semantic'))).toBe(true);
  });
});

describe('fusion evidence', () => {
  it('reports the rank, K, both modality ranks and contributions that add up to the score', async () => {
    const { bundle } = await evidenceFor();

    for (const candidate of bundle.candidates) {
      const [fusion] = candidate.evidence.filter((e): e is FusionEvidence => e.type === 'fusion');
      expect(fusion!.k).toBe(60);
      expect(fusion!.fusedRank).toBe(candidate.rank);
      for (const part of [fusion!.deterministic, fusion!.semantic]) {
        if (part) expect(part.contribution).toBe(1 / (60 + part.rank));
      }
      const sum = (fusion!.deterministic?.contribution ?? 0) + (fusion!.semantic?.contribution ?? 0);
      expect(Math.abs(sum - fusion!.rrfScore)).toBeLessThan(1e-12);
    }
    const invoice = ofType(bundle, 'src/invoice.ts', 'fusion')[0]!;
    expect(invoice.deterministic).not.toBeNull();
    expect(invoice.semantic).not.toBeNull();
  });

  it('uses the K the run recorded, not 60', async () => {
    const snapshotId = await readySnapshot();
    const run = await searchHybridDetailed(db, snapshotId, provider, QUERY);
    const tenth: HybridSearchResult = { ...run, rrfK: 10, fused: fuseRrf(run.deterministic, run.semantic, { k: 10 }) };

    const bundle = constructEvidence(db, snapshotId, provider, tenth);

    expect(bundle.rrfK).toBe(10);
    const [fusion] = ofType(bundle, 'docs/refunds.md', 'fusion');
    expect(fusion!.k).toBe(10);
    expect(fusion!.semantic!.contribution).toBe(1 / (10 + fusion!.semantic!.rank));
  });

  it('rejects a run whose scores do not match its recorded K', async () => {
    const snapshotId = await readySnapshot();
    const run = await searchHybridDetailed(db, snapshotId, provider, QUERY);

    expect(() => constructEvidence(db, snapshotId, provider, { ...run, rrfK: 10 })).toThrow(/RRF score/);
  });
});

describe('ordering, ids and immutability', () => {
  it('orders evidence structural, lexical, semantic, fusion, and candidates by fused rank', async () => {
    const { bundle } = await evidenceFor();

    expect(bundle.candidates.map((c) => c.rank)).toEqual([...bundle.candidates.map((c) => c.rank)].sort((a, b) => a - b));
    const order = ['structural', 'lexical', 'semantic', 'fusion'];
    for (const candidate of bundle.candidates) {
      const positions = candidate.evidence.map((e) => order.indexOf(e.type));
      expect(positions, candidate.path).toEqual([...positions].sort((a, b) => a - b));
      expect(candidate.evidence.at(-1)!.type).toBe('fusion');
    }
    expect(candidateOf(bundle, 'src/invoice.ts').evidence.map((e) => e.type)).toEqual(['structural', 'lexical', 'semantic', 'fusion']);
  });

  it('orders several structural facts by signal kind, then changed path, and keeps each relationship', async () => {
    const files = {
      'src/a.ts': `export const a = 1;\n`,
      'src/b.ts': `export const b = 1;\n`,
      'src/mid.ts': `import { a } from './a';\nimport { b } from './b';\n`,
      'src/mid.test.ts': `import { a } from './a';\nimport { b } from './b';\n`,
      'src/user.ts': `import { m } from './mid';\n`,
    };
    const { bundle } = await evidenceFor(files, { description: 'unrelated', changedPaths: ['src/b.ts', 'src/a.ts', 'src/mid.ts'] });

    expect(ofType(bundle, 'src/mid.test.ts', 'structural').map((e) => [e.signal, e.changedPath])).toEqual([
      ['test-to-source', 'src/a.ts'],
      ['test-to-source', 'src/b.ts'],
    ]);
    expect(ofType(bundle, 'src/user.ts', 'structural').map((e) => [e.signal, e.changedPath, e.source.path, e.target.path])).toEqual([
      ['incoming-import', 'src/mid.ts', 'src/user.ts', 'src/mid.ts'],
    ]);
  });

  it('merges identical evidence but not distinct relationships when a changed path is listed twice', async () => {
    const files = {
      'src/a.ts': `export const a = 1;\n`,
      'src/b.ts': `export const b = 1;\n`,
      'src/both.ts': `import { a } from './a';\nimport { b } from './b';\n`,
    };
    const { bundle } = await evidenceFor(files, { description: 'unrelated', changedPaths: ['src/a.ts', 'src/a.ts', 'src/b.ts'] });

    const evidence = ofType(bundle, 'src/both.ts', 'structural');
    expect(evidence.map((e) => e.changedPath)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(new Set(evidence.map((e) => e.id)).size).toBe(2);
    expect(bundle.changed.map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('generates the same ids and the same bundle for the same run, and unique ids within it', async () => {
    const { bundle, snapshotId, result } = await evidenceFor();

    const again = constructEvidence(db, snapshotId, provider, result);
    const rerun = constructEvidence(db, snapshotId, provider, await searchHybridDetailed(db, snapshotId, provider, QUERY));

    expect(again).toEqual(bundle);
    expect(rerun).toEqual(bundle);
    const ids = bundle.candidates.flatMap((c) => c.evidence.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^(structural|lexical|semantic|fusion):/.test(id) && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(id))).toBe(true);
  });

  it('returns deeply immutable evidence', async () => {
    const { bundle } = await evidenceFor();
    const evidence = candidateOf(bundle, 'src/invoice.ts').evidence[0] as StructuralEvidence;

    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.candidates[0])).toBe(true);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.declarations![0]!.excerpt)).toBe(true);
    expect(() => {
      (evidence as { signal: string }).signal = 'x';
    }).toThrow(TypeError);
  });

  it('does not search or embed again, and does not change the run or the database', async () => {
    const snapshotId = await readySnapshot();
    const result = await searchHybridDetailed(db, snapshotId, provider, QUERY);
    const calls = provider.calls;
    const before = JSON.stringify(result);
    const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const tables = ['content_token', 'snapshot_relationship', 'semantic_embedding', 'semantic_chunk', 'repository_snapshot'];
    const rows = tables.map(count);

    constructEvidence(db, snapshotId, provider, result);

    expect(provider.calls).toBe(calls);
    expect(JSON.stringify(result)).toBe(before);
    expect(tables.map(count)).toEqual(rows);
  });
});

describe('changed paths and the limit', () => {
  it('removes the changed files before applying the limit and keeps the fused ranks', async () => {
    const { snapshotId, result } = await evidenceFor();
    const changedRank = result.fused.find((c) => c.path === 'src/billing.ts')!.rank;
    const limit = changedRank; // the changed file would have taken one of these places
    expect(changedRank).toBeGreaterThan(1);

    const bundle = constructEvidence(db, snapshotId, provider, result, { limit });

    const expected = result.fused.filter((c) => c.path !== 'src/billing.ts').slice(0, limit);
    expect(bundle.candidates.map((c) => [c.rank, c.path])).toEqual(expected.map((c) => [c.rank, c.path]));
    expect(bundle.candidates).toHaveLength(limit);
    expect(bundle.candidates.map((c) => c.rank)).toContain(changedRank + 1); // ranks after the changed file are kept as they were
    expect(bundle.limit).toBe(limit);
  });

  it('compares changed paths exactly: a path differing in case is not the changed file', async () => {
    const { bundle } = await evidenceFor(FILES, { ...QUERY, changedPaths: ['SRC/billing.ts'] });
    expect(bundle.candidates.some((c) => c.path === 'src/billing.ts')).toBe(true);
    expect(bundle.changed).toEqual([{ path: 'SRC/billing.ts', artifactId: null, versionId: null }]);
  });

  it('does not modify the underlying hybrid result', async () => {
    const { result } = await evidenceFor(FILES, QUERY, { limit: 2 });
    expect(result.fused).toHaveLength(Object.keys(FILES).length);
  });

  it('defaults to 20 candidates and honours another limit', async () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`docs/d${String(i).padStart(2, '0')}.md`, `refund ${i}\n`]));
    const { bundle, result } = await evidenceFor(many, { description: 'refund', changedPaths: [] });

    expect(DEFAULT_EVIDENCE_LIMIT).toBe(20);
    expect(bundle.candidates).toHaveLength(20);
    expect(bundle.candidates.map((c) => c.path)).toEqual(result.fused.slice(0, 20).map((c) => c.path));
    expect(constructEvidence(db, bundle.snapshotId, provider, result, { limit: 25 }).candidates).toHaveLength(25);
    expect(constructEvidence(db, bundle.snapshotId, provider, result, { limit: 100 }).candidates).toHaveLength(30);
  });

  it('rejects a limit that is not a positive integer', async () => {
    const { snapshotId, result } = await evidenceFor();
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => constructEvidence(db, snapshotId, provider, result, { limit }), String(limit)).toThrow(RangeError);
    }
  });

  it('keeps a changed path that the snapshot does not contain, without inventing its artifact', async () => {
    const { bundle } = await evidenceFor(FILES, { ...QUERY, changedPaths: ['src/billing.ts', 'src/brand-new.ts'] });

    expect(bundle.changed).toEqual([
      { path: 'src/billing.ts', artifactId: expect.any(Number), versionId: expect.any(Number) },
      { path: 'src/brand-new.ts', artifactId: null, versionId: null },
    ]);
    expect(bundle.candidates.some((c) => c.path === 'src/brand-new.ts')).toBe(false);
  });

  it('handles an empty snapshot and an empty run', async () => {
    const snapshotId = await readySnapshot({ 'logo.png': 'not a supported file' });
    const result = await searchHybridDetailed(db, snapshotId, provider, QUERY);

    const bundle = constructEvidence(db, snapshotId, provider, result);

    expect(result.fused).toEqual([]);
    expect(bundle.candidates).toEqual([]);
    expect(bundle.changed).toEqual([{ path: 'src/billing.ts', artifactId: null, versionId: null }]);
  });
});

describe('validation against the snapshot', () => {
  it('rejects unknown and failed snapshots', async () => {
    const { result } = await evidenceFor();
    const sha = fixture.commit({ 'a.md': 'broken blob\n' });
    fixture.deleteObject(fixture.git('rev-parse', `${sha}:a.md`));
    await expect(ingestSnapshot(db, repository.id, sha)).rejects.toThrow();
    const failedId = findSnapshot(db, repository.id, sha)!.id;

    expect(() => constructEvidence(db, 999, provider, result)).toThrow(NotFoundError);
    expect(() => constructEvidence(db, failedId, provider, result)).toThrow(SnapshotNotReadyError);
  });

  it('rejects a snapshot that lacks the lexical, structural or semantic index', async () => {
    const { result } = await evidenceFor();
    const bare = await ingest(fixture.commit({ 'src/other.ts': `export const o = 1;\n` }));

    expect(() => constructEvidence(db, bare, provider, result)).toThrow(LexicalIndexNotBuiltError);
    indexSnapshotLexically(db, bare);
    expect(() => constructEvidence(db, bare, provider, result)).toThrow(StructuralIndexNotBuiltError);
    indexSnapshotStructurally(db, bare);
    expect(() => constructEvidence(db, bare, provider, result)).toThrow(SemanticIndexNotBuiltError);
  });

  it('rejects a run from another snapshot or another model', async () => {
    const { snapshotId, result } = await evidenceFor();
    const second = await readySnapshot({ ...FILES, 'docs/extra.md': 'refund\n' });

    expect(() => constructEvidence(db, second, provider, result)).toThrow(InconsistentCandidateError);
    expect(() => constructEvidence(db, second, provider, result)).toThrow(/snapshot/);
    expect(() => constructEvidence(db, snapshotId, provider, { ...result, modelId: 'fake:other' })).toThrow(/fake:other/);
  });

  it('rejects, instead of dropping, a candidate that is not that version in the snapshot', async () => {
    const { snapshotId, result } = await evidenceFor();
    const tamper = (change: Partial<HybridSearchResult['fused'][number]>): HybridSearchResult => ({
      ...result,
      fused: result.fused.map((c, i) => (i === 0 ? { ...c, ...change } : c)),
    });
    const other = result.fused[1]!;

    expect(() => constructEvidence(db, snapshotId, provider, tamper({ versionId: 999_999 }))).toThrow(InconsistentCandidateError);
    expect(() => constructEvidence(db, snapshotId, provider, tamper({ versionId: other.versionId }))).toThrow(InconsistentCandidateError);
    expect(() => constructEvidence(db, snapshotId, provider, tamper({ path: 'src/not-there.ts' }))).toThrow(/not that version/);
    expect(() => constructEvidence(db, snapshotId, provider, tamper({ kind: 'config' }))).toThrow(InconsistentCandidateError);
    expect(() => constructEvidence(db, snapshotId, provider, tamper({ artifactId: 999_999 }))).toThrow(InconsistentCandidateError);
  });

  it('rejects a fused candidate that disagrees with the run’s own rankings', async () => {
    const { snapshotId, result } = await evidenceFor();
    const index = result.fused.findIndex((c) => c.path === 'src/invoice.ts');
    const tamper = (change: Partial<HybridSearchResult['fused'][number]>): HybridSearchResult => ({
      ...result,
      fused: result.fused.map((c, i) => (i === index ? { ...c, ...change } : c)),
    });

    expect(() => constructEvidence(db, snapshotId, provider, tamper({ deterministicRank: null, deterministicCategory: null }))).toThrow(/deterministic ranking/);
    expect(() => constructEvidence(db, snapshotId, provider, tamper({ semanticRank: 9999 }))).toThrow(/semantic ranking/);
    expect(() => constructEvidence(db, snapshotId, provider, tamper({ rrfScore: 1 }))).toThrow(/RRF score/);
  });

  it('rejects a structural signal that the snapshot does not back', async () => {
    const { snapshotId, result } = await evidenceFor();
    const invoice = result.deterministic.find((c) => c.path === 'src/invoice.ts')!;
    const forged = {
      ...result,
      deterministic: result.deterministic.map((c) =>
        c === invoice ? { ...c, structuralSignals: [{ kind: 'test-to-source' as const, changedPath: 'src/billing.ts' }] } : c,
      ),
    };

    expect(() => constructEvidence(db, snapshotId, provider, forged)).toThrow(/No test-to-source relationship/);

    const missingFile = {
      ...result,
      deterministic: result.deterministic.map((c) =>
        c === invoice ? { ...c, structuralSignals: [{ kind: 'incoming-import' as const, changedPath: 'src/ghost.ts' }] } : c,
      ),
    };
    expect(() => constructEvidence(db, snapshotId, provider, missingFile)).toThrow(/src\/ghost\.ts/);
  });
});

describe('a consensus false positive', () => {
  // The shape of the benchmark's TB-0009: an internal utility is fixed, and a helper that imports it
  // shares its vocabulary, so both modalities rank the helper high although the change is internal.
  const files = {
    'src/utils/stream.ts': `export class StreamingApi {\n  abort() {}\n}\n`,
    'src/helper/streaming/stream.ts': `import { StreamingApi } from '../../utils/stream';\nexport const stream = new StreamingApi();\n`,
    'src/helper/streaming/stream.test.ts': `import { stream } from './stream';\nexport const t = stream;\n`,
    'docs/readme.md': `Nothing here.\n`,
  };

  it('records what both modalities found and the import, and states no impact', async () => {
    const streamProvider = new FakeEmbeddingProvider(['stream', 'abort']);
    const snapshotId = await readySnapshot(files, streamProvider);
    const query: HybridQuery = { description: 'fix(utils/stream): do not let abort listeners crash abort()', changedPaths: ['src/utils/stream.ts'] };
    const result = await searchHybridDetailed(db, snapshotId, streamProvider, query);

    const bundle = constructEvidence(db, snapshotId, streamProvider, result);
    const helper = candidateOf(bundle, 'src/helper/streaming/stream.ts');

    const [structural] = helper.evidence.filter((e): e is StructuralEvidence => e.type === 'structural');
    const [lexical] = helper.evidence.filter((e): e is LexicalEvidence => e.type === 'lexical');
    const [semantic] = helper.evidence.filter((e): e is SemanticEvidence => e.type === 'semantic');
    const [fusion] = helper.evidence.filter((e): e is FusionEvidence => e.type === 'fusion');
    expect(structural).toMatchObject({
      signal: 'incoming-import',
      relationship: 'imports',
      source: { path: 'src/helper/streaming/stream.ts' },
      target: { path: 'src/utils/stream.ts' },
      declarations: [{ specifier: '../../utils/stream', startLine: 1, endLine: 1 }],
    });
    expect(lexical!.matchedTerms).toContain('stream');
    expect(semantic!.similarityScore).toBeGreaterThan(0);
    expect(fusion!.deterministic).not.toBeNull();
    expect(fusion!.semantic).not.toBeNull();
    expect(helper.rank).toBeLessThanOrEqual(2);
    // The test file imports the helper, not the changed file: no relationship to the change is claimed.
    expect(ofType(bundle, 'src/helper/streaming/stream.test.ts', 'structural')).toEqual([]);
    // Evidence is facts only: nothing in it labels the candidate as impacted.
    expect(JSON.stringify(bundle)).not.toMatch(/impact|affected|relevant|conclusion/i);
  });
});
