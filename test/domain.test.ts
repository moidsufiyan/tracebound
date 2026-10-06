import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../src/db/database.js';
import { NotAGitRepositoryError } from '../src/git/git.js';
import { createProject, NotFoundError, registerRepository } from '../src/projects/projects.js';
import { FixtureRepo } from './git-fixture.js';

let db: Database;
let fixture: FixtureRepo;

beforeEach(() => {
  db = openDatabase(':memory:');
  fixture = new FixtureRepo();
});

afterEach(() => {
  db.close();
  fixture.remove();
});

describe('projects and repositories', () => {
  it('registers several repositories under one project with absolute source paths', async () => {
    const project = createProject(db, '  Tracebound  ');
    const second = new FixtureRepo();
    try {
      const a = await registerRepository(db, { projectId: project.id, name: 'api', sourcePath: fixture.path });
      const b = await registerRepository(db, { projectId: project.id, name: 'web', sourcePath: second.path });
      expect(project.name).toBe('Tracebound');
      expect([a.projectId, b.projectId]).toEqual([project.id, project.id]);
      expect(a.sourcePath).toBe(fixture.path);
    } finally {
      second.remove();
    }
  });

  it('rejects blank and duplicate project names', () => {
    createProject(db, 'one');
    expect(() => createProject(db, 'one')).toThrow(/UNIQUE/);
    expect(() => createProject(db, '   ')).toThrow(/CHECK/);
  });

  it('rejects a directory that is not a Git repository', async () => {
    const project = createProject(db, 'p');
    const plain = mkdtempSync(join(tmpdir(), 'tracebound-plain-'));
    try {
      await expect(registerRepository(db, { projectId: project.id, name: 'r', sourcePath: plain })).rejects.toThrow(
        NotAGitRepositoryError,
      );
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('rejects an unknown project', async () => {
    await expect(registerRepository(db, { projectId: 999, name: 'r', sourcePath: fixture.path })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('schema invariants', () => {
  function seed() {
    db.exec(`
      INSERT INTO project (id, name, created_at) VALUES (1, 'p', 't');
      INSERT INTO repository (id, project_id, name, source_path, created_at) VALUES (1, 1, 'r1', '/r1', 't'), (2, 1, 'r2', '/r2', 't');
      INSERT INTO repository_snapshot (id, repository_id, commit_sha, tree_sha, committed_at, status, recorded_at)
        VALUES (10, 1, '${'a'.repeat(40)}', '${'b'.repeat(40)}', 't', 'ready', 't');
      INSERT INTO content (sha256, text, byte_length) VALUES ('${'c'.repeat(64)}', 'x', 1);
      INSERT INTO artifact (id, repository_id, path, kind) VALUES (100, 1, 'a.ts', 'code'), (200, 2, 'a.ts', 'code');
    `);
  }

  it('allows only one snapshot per repository and commit', () => {
    seed();
    expect(() =>
      db.exec(`INSERT INTO repository_snapshot (repository_id, commit_sha, tree_sha, committed_at, status, recorded_at)
               VALUES (1, '${'a'.repeat(40)}', '${'b'.repeat(40)}', 't', 'ready', 't')`),
    ).toThrow(/UNIQUE/);
  });

  it('requires a failure reason exactly when a snapshot failed', () => {
    seed();
    const insert = (status: string, reason: string | null) =>
      db
        .prepare(
          `INSERT INTO repository_snapshot (repository_id, commit_sha, tree_sha, committed_at, status, failure_reason, recorded_at)
           VALUES (1, ?, ?, 't', ?, ?, 't')`,
        )
        .run('d'.repeat(40), 'b'.repeat(40), status, reason);
    expect(() => insert('failed', null)).toThrow(/CHECK/);
    expect(() => insert('ready', 'oops')).toThrow(/CHECK/);
    expect(() => insert('ingesting', null)).toThrow(/CHECK/);
  });

  it('allows one version per artifact per snapshot', () => {
    seed();
    const insert = () =>
      db.exec(`INSERT INTO artifact_version (repository_id, artifact_id, snapshot_id, content_sha256, git_blob_sha)
               VALUES (1, 100, 10, '${'c'.repeat(64)}', '${'e'.repeat(40)}')`);
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });

  it('rejects a version whose artifact belongs to another repository than its snapshot', () => {
    seed();
    expect(() =>
      db.exec(`INSERT INTO artifact_version (repository_id, artifact_id, snapshot_id, content_sha256, git_blob_sha)
               VALUES (2, 200, 10, '${'c'.repeat(64)}', '${'e'.repeat(40)}')`),
    ).toThrow(/FOREIGN KEY/);
  });

  it('rejects a version that references unknown content', () => {
    seed();
    expect(() =>
      db.exec(`INSERT INTO artifact_version (repository_id, artifact_id, snapshot_id, content_sha256, git_blob_sha)
               VALUES (1, 100, 10, '${'f'.repeat(64)}', '${'e'.repeat(40)}')`),
    ).toThrow(/FOREIGN KEY/);
  });
});
