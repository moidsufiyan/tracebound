import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSnapshotArtifacts, readContent } from '../src/artifacts/artifacts.js';
import { openDatabase, type Database } from '../src/db/database.js';
import { CommitNotFoundError, InvalidCommitShaError } from '../src/git/git.js';
import { ingestSnapshot, listExcludedEntries } from '../src/ingestion/ingest-snapshot.js';
import { MAX_FILE_BYTES } from '../src/ingestion/file-policy.js';
import { createProject, registerRepository, type Repository } from '../src/projects/projects.js';
import { findSnapshot } from '../src/snapshots/snapshots.js';
import { FixtureRepo } from './git-fixture.js';

let db: Database;
let fixture: FixtureRepo;
let repository: Repository;

async function register(target: Database, path: string): Promise<Repository> {
  const project = createProject(target, `project-${Math.random()}`);
  return registerRepository(target, { projectId: project.id, name: 'repo', sourcePath: path });
}

function count(table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(async () => {
  db = openDatabase(':memory:');
  fixture = new FixtureRepo();
  repository = await register(db, fixture.path);
});

afterEach(() => {
  db.close();
  fixture.remove();
});

describe('ingestSnapshot', () => {
  it('captures every supported file of the commit as a ready snapshot', async () => {
    const sha = fixture.commit({
      'src/index.ts': 'export const a = 1;\n',
      'README.md': '# Readme\r\n',
      'package.json': '{}\n',
    });

    const { snapshot, created } = await ingestSnapshot(db, repository.id, sha);

    expect(created).toBe(true);
    expect(snapshot).toMatchObject({ repositoryId: repository.id, commitSha: sha, status: 'ready', failureReason: null });
    expect(snapshot.treeSha).toBe(fixture.git('rev-parse', `${sha}^{tree}`));

    const artifacts = listSnapshotArtifacts(db, snapshot.id);
    expect(artifacts.map((a) => [a.path, a.kind])).toEqual([
      ['README.md', 'document'],
      ['package.json', 'config'],
      ['src/index.ts', 'code'],
    ]);
    const readme = artifacts[0]!;
    expect(readContent(db, readme.contentSha256)).toBe('# Readme\n');
    expect(readme.gitBlobSha).toBe(fixture.git('rev-parse', `${sha}:README.md`));
  });

  it('ingests the requested historical commit, not HEAD or the working tree, and leaves the source untouched', async () => {
    const old = fixture.commit({ 'a.ts': 'old\n', 'removed.ts': 'gone later\n' });
    fixture.commit({ 'a.ts': 'new\n', 'added.ts': 'later\n' }, { remove: ['removed.ts'] });
    fixture.write({ 'a.ts': 'uncommitted\n', 'untracked.ts': 'untracked\n' });
    const headBefore = fixture.git('rev-parse', 'HEAD');
    const statusBefore = fixture.git('status', '--porcelain');

    const { snapshot } = await ingestSnapshot(db, repository.id, old);

    const artifacts = listSnapshotArtifacts(db, snapshot.id);
    expect(artifacts.map((a) => a.path)).toEqual(['a.ts', 'removed.ts']);
    expect(readContent(db, artifacts[0]!.contentSha256)).toBe('old\n');
    expect(fixture.git('rev-parse', 'HEAD')).toBe(headBefore);
    expect(fixture.git('status', '--porcelain')).toBe(statusBefore);
  });

  it('rejects refs and unknown commits without recording a snapshot', async () => {
    fixture.commit({ 'a.ts': 'a\n' });

    await expect(ingestSnapshot(db, repository.id, 'HEAD')).rejects.toThrow(InvalidCommitShaError);
    await expect(ingestSnapshot(db, repository.id, 'main')).rejects.toThrow(InvalidCommitShaError);
    await expect(ingestSnapshot(db, repository.id, 'e'.repeat(40))).rejects.toThrow(CommitNotFoundError);
    expect(count('repository_snapshot')).toBe(0);
  });

  it('is idempotent for an already ingested commit', async () => {
    const sha = fixture.commit({ 'a.ts': 'a\n', 'b.md': 'b\n' });

    const first = await ingestSnapshot(db, repository.id, sha);
    const second = await ingestSnapshot(db, repository.id, sha.toUpperCase());

    expect(second.created).toBe(false);
    expect(second.snapshot).toEqual(first.snapshot);
    expect(count('repository_snapshot')).toBe(1);
    expect(count('artifact_version')).toBe(2);
  });

  it('resolves concurrent ingestion of the same commit to a single snapshot', async () => {
    const sha = fixture.commit({ 'a.ts': 'a\n' });

    const results = await Promise.all([ingestSnapshot(db, repository.id, sha), ingestSnapshot(db, repository.id, sha)]);

    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(results[0]!.snapshot.id).toBe(results[1]!.snapshot.id);
    expect(count('artifact_version')).toBe(1);
  });

  it('produces identical artifact sets for the same commit in independent databases', async () => {
    const sha = fixture.commit({ 'z.ts': 'z\n', 'a/b.ts': 'b\n', 'a.md': 'a\n', 'B.ts': 'B\n' });
    const otherDb = openDatabase(':memory:');
    try {
      const otherRepository = await register(otherDb, fixture.path);
      const mine = await ingestSnapshot(db, repository.id, sha);
      const theirs = await ingestSnapshot(otherDb, otherRepository.id, sha);

      const shape = (target: Database, id: number) =>
        listSnapshotArtifacts(target, id).map(({ path, kind, contentSha256 }) => ({ path, kind, contentSha256 }));
      expect(shape(otherDb, theirs.snapshot.id)).toEqual(shape(db, mine.snapshot.id));
      expect(shape(db, mine.snapshot.id).map((a) => a.path)).toEqual(['B.ts', 'a.md', 'a/b.ts', 'z.ts']);
    } finally {
      otherDb.close();
    }
  });

  it('records excluded entries with an explicit reason', async () => {
    fixture.write({
      'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'node_modules/dep/index.js': 'module.exports = 1;\n',
      'big.ts': 'x'.repeat(MAX_FILE_BYTES + 1),
      'has-nul.ts': Buffer.from([0x61, 0x00]),
      'latin1.md': Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      'kept.ts': 'kept\n',
    });
    fixture.git('add', '--all');
    fixture.stageEntry('120000', fixture.hashObject('kept.ts'), 'link.ts');
    fixture.stageEntry('160000', fixture.git('hash-object', '-t', 'commit', '--stdin', '--literally'), 'vendor/sub');
    fixture.git('commit', '--quiet', '-m', 'mixed');
    const sha = fixture.git('rev-parse', 'HEAD');

    const { snapshot } = await ingestSnapshot(db, repository.id, sha);

    expect(listSnapshotArtifacts(db, snapshot.id).map((a) => a.path)).toEqual(['kept.ts']);
    expect(listExcludedEntries(db, snapshot.id)).toEqual([
      { path: 'big.ts', reason: 'oversized' },
      { path: 'has-nul.ts', reason: 'binary' },
      { path: 'latin1.md', reason: 'not_utf8' },
      { path: 'link.ts', reason: 'symlink' },
      { path: 'logo.png', reason: 'unsupported_type' },
      { path: 'node_modules/dep/index.js', reason: 'generated' },
      { path: 'vendor/sub', reason: 'submodule' },
    ]);
  });

  it('records a failed snapshot with no versions when the object store is incomplete, and recovers on retry', async () => {
    const good = fixture.commit({ 'a.ts': 'a\n' });
    const broken = fixture.commit({ 'a.ts': 'a\n', 'b.ts': 'b content\n' });
    await ingestSnapshot(db, repository.id, good);
    const blob = fixture.git('rev-parse', `${broken}:b.ts`);
    fixture.deleteObject(blob);

    await expect(ingestSnapshot(db, repository.id, broken)).rejects.toThrow(/missing or unreadable/);

    const failed = findSnapshot(db, repository.id, broken);
    expect(failed).toMatchObject({ status: 'failed', failureReason: expect.stringMatching(/b\.ts/) });
    expect(listSnapshotArtifacts(db, failed!.id)).toEqual([]);
    expect(listExcludedEntries(db, failed!.id)).toEqual([]);
    expect(count('artifact_version')).toBe(1); // only the earlier, ready snapshot's version

    expect(fixture.hashObject('b content\n')).toBe(blob);
    const retried = await ingestSnapshot(db, repository.id, broken);
    expect(retried.created).toBe(true);
    expect(retried.snapshot).toMatchObject({ status: 'ready', failureReason: null });
    expect(listSnapshotArtifacts(db, retried.snapshot.id).map((a) => a.path)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('Artifact and ArtifactVersion across snapshots', () => {
  it('keeps artifact identity by path while versions track content per snapshot', async () => {
    const first = fixture.commit({ 'same.ts': 'same\n', 'changed.ts': 'v1\n', 'deleted.md': 'bye\n' });
    const second = fixture.commit({ 'changed.ts': 'v2\n', 'new.ts': 'same\n' }, { remove: ['deleted.md'] });

    const s1 = (await ingestSnapshot(db, repository.id, first)).snapshot;
    const s2 = (await ingestSnapshot(db, repository.id, second)).snapshot;
    const v1 = new Map(listSnapshotArtifacts(db, s1.id).map((a) => [a.path, a]));
    const v2 = new Map(listSnapshotArtifacts(db, s2.id).map((a) => [a.path, a]));

    // Unchanged file: same artifact, same content, distinct version rows.
    expect(v2.get('same.ts')!.artifactId).toBe(v1.get('same.ts')!.artifactId);
    expect(v2.get('same.ts')!.contentSha256).toBe(v1.get('same.ts')!.contentSha256);
    expect(v2.get('same.ts')!.versionId).not.toBe(v1.get('same.ts')!.versionId);

    // Modified file: same artifact, new content.
    expect(v2.get('changed.ts')!.artifactId).toBe(v1.get('changed.ts')!.artifactId);
    expect(v2.get('changed.ts')!.contentSha256).not.toBe(v1.get('changed.ts')!.contentSha256);

    // Deleted file: absent from the later snapshot, still intact in the earlier one.
    expect(v2.has('deleted.md')).toBe(false);
    expect(readContent(db, v1.get('deleted.md')!.contentSha256)).toBe('bye\n');

    // Identical content at another path: a different artifact sharing one content row.
    expect(v2.get('new.ts')!.artifactId).not.toBe(v2.get('same.ts')!.artifactId);
    expect(v2.get('new.ts')!.contentSha256).toBe(v2.get('same.ts')!.contentSha256);

    expect(count('artifact')).toBe(4);
    expect(count('content')).toBe(4); // same, v1, v2, bye
  });

  it('re-ingesting an older commit later still reflects that commit exactly', async () => {
    const first = fixture.commit({ 'a.ts': 'v1\n' });
    const second = fixture.commit({ 'a.ts': 'v2\n' });

    const later = (await ingestSnapshot(db, repository.id, second)).snapshot;
    const earlier = (await ingestSnapshot(db, repository.id, first)).snapshot;

    expect(readContent(db, listSnapshotArtifacts(db, earlier.id)[0]!.contentSha256)).toBe('v1\n');
    expect(readContent(db, listSnapshotArtifacts(db, later.id)[0]!.contentSha256)).toBe('v2\n');
  });
});
