import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findArtifactAtSnapshot, listSnapshotArtifacts } from '../src/artifacts/artifacts.js';
import { openDatabase, type Database } from '../src/db/database.js';
import { ingestSnapshot } from '../src/ingestion/ingest-snapshot.js';
import { createProject, NotFoundError, registerRepository, type Repository } from '../src/projects/projects.js';
import { compareSnapshots, SnapshotRepositoryMismatchError } from '../src/snapshots/compare-snapshots.js';
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

describe('findArtifactAtSnapshot', () => {
  it('returns the version that belongs to the requested snapshot, not another one', async () => {
    const first = fixture.commit({ 'src/a.ts': 'v1\n', 'keep.md': 'keep\n' });
    const second = fixture.commit({ 'src/a.ts': 'v2\n' });
    const s1 = await ingest(first);
    const s2 = await ingest(second);

    const atFirst = findArtifactAtSnapshot(db, s1, 'src/a.ts')!;
    const atSecond = findArtifactAtSnapshot(db, s2, 'src/a.ts')!;

    expect(atFirst).toEqual({
      artifactId: atSecond.artifactId,
      versionId: expect.any(Number),
      path: 'src/a.ts',
      kind: 'code',
      contentSha256: listSnapshotArtifacts(db, s1).find((a) => a.path === 'src/a.ts')!.contentSha256,
      gitBlobSha: fixture.git('rev-parse', `${first}:src/a.ts`),
    });
    expect(atSecond.gitBlobSha).toBe(fixture.git('rev-parse', `${second}:src/a.ts`));
    expect(atSecond.versionId).not.toBe(atFirst.versionId);
    expect(atSecond.contentSha256).not.toBe(atFirst.contentSha256);
  });

  it('returns undefined for a path the snapshot does not contain, even if other snapshots do', async () => {
    const first = fixture.commit({ 'old.ts': 'old\n' });
    const second = fixture.commit({ 'new.ts': 'new\n' }, { remove: ['old.ts'] });
    const s1 = await ingest(first);
    const s2 = await ingest(second);

    expect(findArtifactAtSnapshot(db, s2, 'old.ts')).toBeUndefined();
    expect(findArtifactAtSnapshot(db, s1, 'new.ts')).toBeUndefined();
    expect(findArtifactAtSnapshot(db, s2, 'does/not/exist.ts')).toBeUndefined();
  });

  it('matches paths exactly, without case folding or normalization', async () => {
    const sha = fixture.commit({ 'Readme.md': 'x\n' });
    const snapshotId = await ingest(sha);

    expect(findArtifactAtSnapshot(db, snapshotId, 'Readme.md')).toBeDefined();
    expect(findArtifactAtSnapshot(db, snapshotId, 'readme.md')).toBeUndefined();
    expect(findArtifactAtSnapshot(db, snapshotId, './Readme.md')).toBeUndefined();
  });

  it('throws NotFoundError for an unknown snapshot', () => {
    expect(() => findArtifactAtSnapshot(db, 999, 'a.ts')).toThrow(NotFoundError);
  });

  it('throws SnapshotNotReadyError for a failed snapshot', async () => {
    const sha = fixture.commit({ 'a.ts': 'a content\n' });
    fixture.deleteObject(fixture.git('rev-parse', `${sha}:a.ts`));
    await expect(ingestSnapshot(db, repository.id, sha)).rejects.toThrow(/missing or unreadable/);
    const failed = findSnapshot(db, repository.id, sha)!;

    expect(failed.status).toBe('failed');
    expect(() => findArtifactAtSnapshot(db, failed.id, 'a.ts')).toThrow(SnapshotNotReadyError);
  });
});

describe('compareSnapshots', () => {
  it('classifies added, deleted, modified and unchanged artifacts with auditable hashes', async () => {
    const base = fixture.commit({ 'same.ts': 'same\n', 'edit.ts': 'v1\n', 'gone.md': 'bye\n' });
    const target = fixture.commit({ 'edit.ts': 'v2\n', 'fresh.ts': 'hello\n' }, { remove: ['gone.md'] });
    const baseId = await ingest(base);
    const targetId = await ingest(target);

    const changes = compareSnapshots(db, baseId, targetId);

    expect(changes.map((c) => [c.path, c.change])).toEqual([
      ['edit.ts', 'modified'],
      ['fresh.ts', 'added'],
      ['gone.md', 'deleted'],
      ['same.ts', 'unchanged'],
    ]);
    const byPath = new Map(changes.map((c) => [c.path, c]));

    const edit = byPath.get('edit.ts')!;
    expect(edit.base!.contentSha256).not.toBe(edit.target!.contentSha256);
    expect(edit.base!.gitBlobSha).toBe(fixture.git('rev-parse', `${base}:edit.ts`));
    expect(edit.target!.gitBlobSha).toBe(fixture.git('rev-parse', `${target}:edit.ts`));
    expect(edit.base!.versionId).not.toBe(edit.target!.versionId);

    const added = byPath.get('fresh.ts')!;
    expect(added).toMatchObject({ base: null, kind: 'code' });
    expect(added.target!.gitBlobSha).toBe(fixture.git('rev-parse', `${target}:fresh.ts`));

    const deleted = byPath.get('gone.md')!;
    expect(deleted).toMatchObject({ target: null, kind: 'document' });
    expect(deleted.base!.gitBlobSha).toBe(fixture.git('rev-parse', `${base}:gone.md`));

    const same = byPath.get('same.ts')!;
    expect(same.base).toEqual({ ...same.target, versionId: same.base!.versionId });
    expect(same.base!.versionId).not.toBe(same.target!.versionId);
    expect(same.artifactId).toBe(byPath.get('same.ts')!.artifactId);
  });

  it('treats a rename as a delete of the old path and an add of the new path', async () => {
    const base = fixture.commit({ 'old-name.ts': 'content\n' });
    fixture.git('mv', 'old-name.ts', 'new-name.ts');
    fixture.git('commit', '--quiet', '-m', 'rename');
    const target = fixture.git('rev-parse', 'HEAD');

    const changes = compareSnapshots(db, await ingest(base), await ingest(target));

    expect(changes.map((c) => [c.path, c.change])).toEqual([
      ['new-name.ts', 'added'],
      ['old-name.ts', 'deleted'],
    ]);
    expect(changes[0]!.artifactId).not.toBe(changes[1]!.artifactId);
  });

  it('compares normalized content, so different raw blobs with the same text are unchanged', async () => {
    const base = fixture.commit({ 'crlf.ts': 'a\r\nb\r\n' });
    const target = fixture.commit({ 'crlf.ts': 'a\nb\n' });
    expect(fixture.git('rev-parse', `${base}:crlf.ts`)).not.toBe(fixture.git('rev-parse', `${target}:crlf.ts`));

    const [change] = compareSnapshots(db, await ingest(base), await ingest(target));

    expect(change).toMatchObject({ path: 'crlf.ts', change: 'unchanged' });
    expect(change!.base!.contentSha256).toBe(change!.target!.contentSha256);
    expect(change!.base!.gitBlobSha).toBe(fixture.git('rev-parse', `${base}:crlf.ts`));
    expect(change!.target!.gitBlobSha).toBe(fixture.git('rev-parse', `${target}:crlf.ts`));
  });

  it('returns results in Git path order regardless of insertion order or direction', async () => {
    // Artifacts are created in path order per snapshot, so ingest the later-created paths first.
    const base = fixture.commit({ 'z.ts': 'z\n', 'a/b.ts': 'b\n' });
    const target = fixture.commit({ 'B.ts': 'B\n', 'a-b.ts': 'ab\n', 'a.md': 'a\n', 'a/b.ts': 'b2\n' });
    const targetId = await ingest(target);
    const baseId = await ingest(base);

    const expectedOrder = ['B.ts', 'a-b.ts', 'a.md', 'a/b.ts', 'z.ts'];
    expect(compareSnapshots(db, baseId, targetId).map((c) => c.path)).toEqual(expectedOrder);
    expect(compareSnapshots(db, targetId, baseId).map((c) => c.path)).toEqual(expectedOrder);
  });

  it('is the inverse when base and target are swapped', async () => {
    const base = fixture.commit({ 'a.ts': 'a\n', 'b.ts': 'b1\n' });
    const target = fixture.commit({ 'b.ts': 'b2\n', 'c.ts': 'c\n' }, { remove: ['a.ts'] });
    const baseId = await ingest(base);
    const targetId = await ingest(target);

    const flipped = { added: 'deleted', deleted: 'added', modified: 'modified', unchanged: 'unchanged' };
    const forward = compareSnapshots(db, baseId, targetId).map((c) => [c.path, flipped[c.change]]);
    const backward = compareSnapshots(db, targetId, baseId).map((c) => [c.path, c.change]);
    expect(backward).toEqual(forward);
  });

  it('reports every artifact unchanged when a snapshot is compared with itself', async () => {
    const snapshotId = await ingest(fixture.commit({ 'a.ts': 'a\n', 'b.md': 'b\n' }));
    expect(compareSnapshots(db, snapshotId, snapshotId).map((c) => c.change)).toEqual(['unchanged', 'unchanged']);
  });

  it('ignores artifacts of other repositories', async () => {
    const other = new FixtureRepo();
    extraFixtures.push(other);
    const otherRepository = await register(other);
    await ingest(other.commit({ 'foreign.ts': 'x\n' }), otherRepository);

    const base = fixture.commit({ 'a.ts': 'a\n' });
    const target = fixture.commit({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
    const changes = compareSnapshots(db, await ingest(base), await ingest(target));

    expect(changes.map((c) => c.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('rejects snapshots from different repositories', async () => {
    const other = new FixtureRepo();
    extraFixtures.push(other);
    const otherRepository = await register(other);
    const mine = await ingest(fixture.commit({ 'a.ts': 'a\n' }));
    const theirs = await ingest(other.commit({ 'a.ts': 'a\n' }), otherRepository);

    expect(() => compareSnapshots(db, mine, theirs)).toThrow(SnapshotRepositoryMismatchError);
  });

  it('rejects unknown and non-ready snapshots on either side', async () => {
    const ready = await ingest(fixture.commit({ 'a.ts': 'a\n' }));
    const broken = fixture.commit({ 'b.ts': 'b content\n' });
    fixture.deleteObject(fixture.git('rev-parse', `${broken}:b.ts`));
    await expect(ingestSnapshot(db, repository.id, broken)).rejects.toThrow();
    const failedId = findSnapshot(db, repository.id, broken)!.id;

    expect(() => compareSnapshots(db, 999, ready)).toThrow(NotFoundError);
    expect(() => compareSnapshots(db, ready, 999)).toThrow(NotFoundError);
    expect(() => compareSnapshots(db, failedId, ready)).toThrow(SnapshotNotReadyError);
    expect(() => compareSnapshots(db, ready, failedId)).toThrow(SnapshotNotReadyError);
  });
});
