import { afterEach, describe, expect, it } from 'vitest';
import {
  BlobReader,
  CommitNotFoundError,
  InvalidCommitShaError,
  listTree,
  parseCommitSha,
  readCommit,
} from '../src/git/git.js';
import { FixtureRepo } from './git-fixture.js';

let repo: FixtureRepo | undefined;
afterEach(() => repo?.remove());

describe('parseCommitSha', () => {
  it('accepts full SHA-1 and SHA-256 ids and lowercases them', () => {
    expect(parseCommitSha('A'.repeat(40))).toBe('a'.repeat(40));
    expect(parseCommitSha('b'.repeat(64))).toBe('b'.repeat(64));
  });

  it.each(['HEAD', 'main', 'refs/heads/main', 'abc1234', '--output=/tmp/x', 'a'.repeat(39), `${'a'.repeat(40)}^`])(
    'rejects %s',
    (value) => {
      expect(() => parseCommitSha(value)).toThrow(InvalidCommitShaError);
    },
  );
});

describe('readCommit', () => {
  it('reads the requested commit even when HEAD has moved on', async () => {
    repo = new FixtureRepo();
    const first = repo.commit({ 'a.ts': 'one\n' });
    const second = repo.commit({ 'a.ts': 'two\n' });

    const commit = await readCommit(repo.path, first);

    expect(commit.sha).toBe(first);
    expect(commit.treeSha).toBe(repo.git('rev-parse', `${first}^{tree}`));
    expect(commit.treeSha).not.toBe(repo.git('rev-parse', `${second}^{tree}`));
    expect(commit.committedAt).toBe(new Date(Number(repo.git('show', '-s', '--format=%ct', first)) * 1000).toISOString());
  });

  it('rejects an unknown commit', async () => {
    repo = new FixtureRepo();
    repo.commit({ 'a.ts': 'one\n' });
    await expect(readCommit(repo.path, 'f'.repeat(40))).rejects.toThrow(CommitNotFoundError);
  });

  it('rejects objects that are not commits, including annotated tags', async () => {
    repo = new FixtureRepo();
    repo.commit({ 'a.ts': 'one\n' });
    repo.git('tag', '-a', 'v1', '-m', 'release');
    const tagSha = repo.git('rev-parse', 'v1');
    const blobSha = repo.git('rev-parse', 'HEAD:a.ts');

    await expect(readCommit(repo.path, tagSha)).rejects.toThrow(CommitNotFoundError);
    await expect(readCommit(repo.path, blobSha)).rejects.toThrow(CommitNotFoundError);
  });
});

describe('listTree and BlobReader', () => {
  it('lists nested entries with sizes and reads exact blob bytes', async () => {
    repo = new FixtureRepo();
    const sha = repo.commit({ 'src/deep/a.ts': 'export {};\r\n', 'name with spaces.md': '# Title\n' });

    const entries = await listTree(repo.path, sha);
    expect(entries.map((e) => e.path).sort()).toEqual(['name with spaces.md', 'src/deep/a.ts']);
    const deep = entries.find((e) => e.path === 'src/deep/a.ts');
    expect(deep).toMatchObject({ mode: '100644', type: 'blob', size: 12 });

    const reader = new BlobReader(repo.path);
    try {
      expect((await reader.read(deep!.objectSha)).toString('utf8')).toBe('export {};\r\n');
      await expect(reader.read('0'.repeat(40))).rejects.toThrow(/missing/);
    } finally {
      await reader.close();
    }
  });
});
