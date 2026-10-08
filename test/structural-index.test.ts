import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findIncomingRelationships, findOutgoingRelationships } from '../src/analysis/relationships.js';
import {
  indexSnapshotStructurally,
  isSnapshotStructurallyIndexed,
  StructuralIndexNotBuiltError,
} from '../src/analysis/structural-index.js';
import { findArtifactAtSnapshot } from '../src/artifacts/artifacts.js';
import { openDatabase, type Database } from '../src/db/database.js';
import { ingestSnapshot } from '../src/ingestion/ingest-snapshot.js';
import { createProject, NotFoundError, registerRepository, type Repository } from '../src/projects/projects.js';
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

async function ingest(sha: string, target: Repository = repository): Promise<number> {
  return (await ingestSnapshot(db, target.id, sha)).snapshot.id;
}

function artifactId(snapshotId: number, path: string): number {
  return findArtifactAtSnapshot(db, snapshotId, path)!.artifactId;
}

/** Every stored relationship of the snapshot as "source -> target (kind)", sorted. */
function edges(snapshotId: number): string[] {
  const rows = db
    .prepare(
      `SELECT sa.path AS source, ta.path AS target, r.kind
       FROM snapshot_relationship r
       JOIN artifact sa ON sa.id = r.source_artifact_id
       JOIN artifact ta ON ta.id = r.target_artifact_id
       WHERE r.snapshot_id = ?`,
    )
    .all(snapshotId) as unknown as { source: string; target: string; kind: string }[];
  return rows.map((r) => `${r.source} -> ${r.target} (${r.kind})`).sort();
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

describe('relationship resolution', () => {
  it('stores resolved relative imports once, source to target, and test-to-source for test files', async () => {
    const sha = fixture.commit({
      'src/core.ts': `import { helper } from './helper';\nimport { Config } from '../config/settings';\nexport const core = helper;\n`,
      'src/helper.ts': `export const helper = 1;\n`,
      'config/settings.ts': `export type Config = {};\n`,
      'src/core.test.ts': `import { core } from './core';\nimport { helper } from './helper';\n`,
    });
    const snapshotId = await ingest(sha);

    expect(indexSnapshotStructurally(db, snapshotId)).toMatchObject({ indexed: true, contentsWithSyntaxErrors: 0 });

    expect(edges(snapshotId)).toEqual([
      'src/core.test.ts -> src/core.ts (imports)',
      'src/core.test.ts -> src/core.ts (test-to-source)',
      'src/core.test.ts -> src/helper.ts (imports)',
      'src/core.test.ts -> src/helper.ts (test-to-source)',
      'src/core.ts -> config/settings.ts (imports)',
      'src/core.ts -> src/helper.ts (imports)',
    ]);
  });

  it('does not create edges for external modules, aliases, unresolved paths, or non-import syntax', async () => {
    const sha = fixture.commit({
      'src/a.ts': [
        `import x from 'hono';`,
        `import y from '@/alias/thing';`,
        `import z from './missing';`,
        `import w from './absent.js';`,
        `import s from './target.css';`,
        `export * from './reexported';`,
        `const r = require('./required');`,
        `const d = () => import('./dynamic');`,
      ].join('\n'),
      'src/target.ts': `export {};\n`,
      'src/reexported.ts': `export {};\n`,
      'src/required.ts': `export {};\n`,
      'src/dynamic.ts': `export {};\n`,
      'src/hono.ts': `export {};\n`,
    });
    const snapshotId = await ingest(sha);
    indexSnapshotStructurally(db, snapshotId);

    expect(edges(snapshotId)).toEqual([]);
  });

  it('resolves .js specifiers to TypeScript sources, but never over an exact target', async () => {
    const sha = fixture.commit({
      'src/app.ts': [
        `import a from './to-ts.js';`,
        `import b from './to-tsx.js';`,
        `import c from './exact.js';`,
        `import d from './both.js';`,
        `import e from './none.js';`,
      ].join('\n'),
      'src/to-ts.ts': `export {};\n`,
      'src/to-tsx.tsx': `export {};\n`,
      'src/exact.js': `export {};\n`,
      'src/exact.ts': `export {};\n`,
      'src/both.ts': `export {};\n`,
      'src/both.tsx': `export {};\n`,
      'src/app.test.ts': `import { a } from './to-ts.js';\n`,
    });
    const snapshotId = await ingest(sha);
    indexSnapshotStructurally(db, snapshotId);

    expect(edges(snapshotId)).toEqual([
      'src/app.test.ts -> src/to-ts.ts (imports)',
      'src/app.test.ts -> src/to-ts.ts (test-to-source)',
      'src/app.ts -> src/both.ts (imports)',
      'src/app.ts -> src/exact.js (imports)',
      'src/app.ts -> src/to-ts.ts (imports)',
      'src/app.ts -> src/to-tsx.tsx (imports)',
    ]);
  });

  it('resolves a .js specifier only against the snapshot being indexed', async () => {
    const before = fixture.commit({ 'src/a.ts': `import { b } from './b.js';\n` });
    const after = fixture.commit({ 'src/b.ts': `export const b = 1;\n` });
    const s1 = await ingest(before);
    const s2 = await ingest(after);
    indexSnapshotStructurally(db, s1);
    indexSnapshotStructurally(db, s2);

    expect(edges(s1)).toEqual([]);
    expect(edges(s2)).toEqual(['src/a.ts -> src/b.ts (imports)']);
  });

  it('resolves index files, JSON files and JSX sources, and ignores files B1 did not analyse', async () => {
    const sha = fixture.commit({
      'src/app.tsx': `import { Page } from './pages';\nimport data from './data.json';\nexport const App = () => <Page d={data} />;\n`,
      'src/pages/index.ts': `export const Page = 1;\n`,
      'src/data.json': `{}\n`,
      'src/module.mjs': `import { x } from './pages';\n`,
      'src/types.mts': `import { x } from './pages';\n`,
    });
    const snapshotId = await ingest(sha);
    indexSnapshotStructurally(db, snapshotId);

    expect(edges(snapshotId)).toEqual([
      'src/app.tsx -> src/data.json (imports)',
      'src/app.tsx -> src/pages/index.ts (imports)',
    ]);
  });

  it('ignores an import of the file itself', async () => {
    const snapshotId = await ingest(fixture.commit({ 'src/index.ts': `import { x } from './index';\nexport const x = 1;\n` }));
    indexSnapshotStructurally(db, snapshotId);
    expect(edges(snapshotId)).toEqual([]);
  });

  it('records a text the parser rejects without imports instead of failing the snapshot', async () => {
    const sha = fixture.commit({ 'src/broken.ts': `import { a } from './a';\nconst = ;\n`, 'src/a.ts': `export const a = 1;\n` });
    const snapshotId = await ingest(sha);

    expect(indexSnapshotStructurally(db, snapshotId)).toMatchObject({ contentsWithSyntaxErrors: 1 });
    expect(edges(snapshotId)).toEqual([]);
    expect(db.prepare("SELECT status FROM structural_parsed_content WHERE status = 'syntax_error'").all()).toHaveLength(1);
    expect(count('content_import')).toBe(0);
  });
});

describe('relationship lookup', () => {
  it('finds reverse dependencies and outgoing imports with versions, in deterministic order', async () => {
    const sha = fixture.commit({
      'src/core.ts': `import { h } from './helper';\n`,
      'src/helper.ts': `export const h = 1;\n`,
      'src/z-user.ts': `import { h } from './helper';\n`,
      'src/a-user.ts': `import { h } from './helper';\n`,
      'src/a-user.test.ts': `import { h } from './helper';\n`,
    });
    const snapshotId = await ingest(sha);
    indexSnapshotStructurally(db, snapshotId);
    const helper = artifactId(snapshotId, 'src/helper.ts');

    const incoming = findIncomingRelationships(db, snapshotId, [helper]);
    expect(incoming.map((r) => [r.source.path, r.kind])).toEqual([
      ['src/a-user.test.ts', 'imports'],
      ['src/a-user.test.ts', 'test-to-source'],
      ['src/a-user.ts', 'imports'],
      ['src/core.ts', 'imports'],
      ['src/z-user.ts', 'imports'],
    ]);
    expect(incoming[0]!.target).toEqual({
      artifactId: helper,
      versionId: findArtifactAtSnapshot(db, snapshotId, 'src/helper.ts')!.versionId,
      path: 'src/helper.ts',
      kind: 'code',
    });

    const outgoing = findOutgoingRelationships(db, snapshotId, [artifactId(snapshotId, 'src/core.ts')]);
    expect(outgoing.map((r) => [r.target.path, r.kind])).toEqual([['src/helper.ts', 'imports']]);
    expect(findIncomingRelationships(db, snapshotId, [])).toEqual([]);
  });
});

describe('content-level deduplication', () => {
  it('parses identical content once, across paths and across snapshots', async () => {
    const first = fixture.commit({
      'src/one.ts': `import { x } from './shared';\n`,
      'src/two.ts': `import { x } from './shared';\n`,
      'src/shared.ts': `export const x = 1;\n`,
    });
    const second = fixture.commit({ 'src/three.ts': `import { y } from './shared';\n` });
    const s1 = await ingest(first);
    const s2 = await ingest(second);

    // one.ts and two.ts share content: two texts are parsed, not three.
    expect(indexSnapshotStructurally(db, s1)).toMatchObject({ contentsParsed: 2 });
    // The second snapshot only has one new text; everything else is reused.
    expect(indexSnapshotStructurally(db, s2)).toMatchObject({ contentsParsed: 1 });
    expect(count('structural_parsed_content')).toBe(3);
    expect(edges(s2)).toContain('src/one.ts -> src/shared.ts (imports)');
    expect(edges(s2)).toContain('src/three.ts -> src/shared.ts (imports)');
  });

  it('parses the same text separately per dialect, because JSX changes how it parses', async () => {
    const text = `import { a } from './a';\nexport const v = <number>(1);\n`;
    const snapshotId = await ingest(fixture.commit({ 'src/x.ts': text, 'src/x.tsx': text, 'src/a.ts': `export const a = 1;\n` }));

    indexSnapshotStructurally(db, snapshotId);

    const rows = db
      .prepare('SELECT dialect, status FROM structural_parsed_content ORDER BY dialect')
      .all() as unknown as { dialect: string; status: string }[];
    // x.ts and a.ts parse in the plain dialect; the identical text of x.tsx is a separate JSX parse
    // that rejects the angle-bracket assertion.
    expect(rows.map((r) => `${r.dialect}:${r.status}`)).toEqual([
      'typescript:parsed',
      'typescript:parsed',
      'typescript-jsx:syntax_error',
    ]);
    expect(edges(snapshotId)).toEqual(['src/x.ts -> src/a.ts (imports)']);
  });
});

describe('snapshot scoping', () => {
  it('resolves imports only against the paths of the snapshot being indexed', async () => {
    const before = fixture.commit({ 'src/a.ts': `import { b } from './b';\n` });
    const after = fixture.commit({ 'src/b.ts': `export const b = 1;\n` });
    const s1 = await ingest(before);
    const s2 = await ingest(after);

    indexSnapshotStructurally(db, s1);
    indexSnapshotStructurally(db, s2);

    expect(edges(s1)).toEqual([]); // b.ts did not exist yet; HEAD's tree is never consulted
    expect(edges(s2)).toEqual(['src/a.ts -> src/b.ts (imports)']);
  });

  it('keeps a removed dependency visible in the historical snapshot only', async () => {
    const early = fixture.commit({ 'src/a.ts': `import { b } from './b';\n`, 'src/b.ts': `export const b = 1;\n` });
    const late = fixture.commit({ 'src/a.ts': `export const a = 1;\n` });
    const s1 = await ingest(early);
    const s2 = await ingest(late);
    indexSnapshotStructurally(db, s1);
    indexSnapshotStructurally(db, s2);

    expect(edges(s1)).toEqual(['src/a.ts -> src/b.ts (imports)']);
    expect(edges(s2)).toEqual([]);
  });

  it('never relates artifacts of different repositories', async () => {
    const other = new FixtureRepo();
    extraFixtures.push(other);
    const otherRepository = await register(other);
    const mine = await ingest(fixture.commit({ 'src/a.ts': `import { b } from './b';\n` }));
    const theirs = await ingest(other.commit({ 'src/a.ts': `import { b } from './b';\n`, 'src/b.ts': `export const b = 1;\n` }), otherRepository);

    indexSnapshotStructurally(db, mine);
    indexSnapshotStructurally(db, theirs);

    expect(edges(mine)).toEqual([]);
    expect(edges(theirs)).toEqual(['src/a.ts -> src/b.ts (imports)']);
    // Same path in both repositories, but different artifacts.
    expect(artifactId(mine, 'src/a.ts')).not.toBe(artifactId(theirs, 'src/a.ts'));
  });

  it('keeps results identical across independent databases', async () => {
    const sha = fixture.commit({
      'src/z.ts': `import './a';\nimport './m';\n`,
      'src/a.ts': `import './m';\n`,
      'src/m.ts': `export {};\n`,
    });
    const first = await ingest(sha);
    indexSnapshotStructurally(db, first);

    const other = openDatabase(':memory:');
    try {
      const project = createProject(other, 'p');
      const repo = await registerRepository(other, { projectId: project.id, name: 'r', sourcePath: fixture.path });
      const id = (await ingestSnapshot(other, repo.id, sha)).snapshot.id;
      indexSnapshotStructurally(other, id);
      const shape = (target: Database, snapshot: number) =>
        (
          target
            .prepare(
              `SELECT sa.path AS source, ta.path AS target, r.kind FROM snapshot_relationship r
               JOIN artifact sa ON sa.id = r.source_artifact_id JOIN artifact ta ON ta.id = r.target_artifact_id
               WHERE r.snapshot_id = ? ORDER BY sa.path, ta.path, r.kind`,
            )
            .all(snapshot) as unknown as object[]
        ).map((row) => ({ ...row }));
      expect(shape(other, id)).toEqual(shape(db, first));
    } finally {
      other.close();
    }
  });
});

describe('index state', () => {
  it('rejects unknown and failed snapshots', async () => {
    const sha = fixture.commit({ 'a.ts': 'export const broken = 1;\n' });
    fixture.deleteObject(fixture.git('rev-parse', `${sha}:a.ts`));
    await expect(ingestSnapshot(db, repository.id, sha)).rejects.toThrow();
    const failedId = findSnapshot(db, repository.id, sha)!.id;

    expect(() => indexSnapshotStructurally(db, 999)).toThrow(NotFoundError);
    expect(() => indexSnapshotStructurally(db, failedId)).toThrow(SnapshotNotReadyError);
    expect(() => findIncomingRelationships(db, failedId, [1])).toThrow(SnapshotNotReadyError);
    expect(count('structurally_indexed_snapshot')).toBe(0);
  });

  it('refuses relationship lookups on a snapshot that has not been indexed', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.ts': `import './b';\n`, 'b.ts': `export {};\n` }));

    expect(isSnapshotStructurallyIndexed(db, snapshotId)).toBe(false);
    expect(() => findIncomingRelationships(db, snapshotId, [1])).toThrow(StructuralIndexNotBuiltError);
    expect(() => findOutgoingRelationships(db, snapshotId, [1])).toThrow(StructuralIndexNotBuiltError);
  });

  it('is idempotent, and a snapshot without relationships still counts as indexed', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.ts': `export const a = 1;\n` }));

    expect(indexSnapshotStructurally(db, snapshotId)).toEqual({
      indexed: true,
      contentsParsed: 1,
      contentsWithSyntaxErrors: 0,
      relationships: 0,
    });
    expect(isSnapshotStructurallyIndexed(db, snapshotId)).toBe(true);
    const before = [count('structural_parsed_content'), count('content_import'), count('snapshot_relationship')];
    expect(indexSnapshotStructurally(db, snapshotId)).toEqual({
      indexed: false,
      contentsParsed: 0,
      contentsWithSyntaxErrors: 0,
      relationships: 0,
    });
    expect([count('structural_parsed_content'), count('content_import'), count('snapshot_relationship')]).toEqual(before);
    expect(findIncomingRelationships(db, snapshotId, [artifactId(snapshotId, 'a.ts')])).toEqual([]);
  });

  it('leaves snapshot state and canonical rows untouched', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.ts': `import './b';\n`, 'b.ts': `export {};\n` }));
    const canonical = () => [count('repository_snapshot'), count('artifact'), count('artifact_version'), count('content')];
    const before = canonical();
    const snapshot = findSnapshot(db, repository.id, fixture.git('rev-parse', 'HEAD'));

    indexSnapshotStructurally(db, snapshotId);

    expect(canonical()).toEqual(before);
    expect(findSnapshot(db, repository.id, fixture.git('rev-parse', 'HEAD'))).toEqual(snapshot);
  });
});
