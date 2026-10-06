import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A throwaway Git repository with deterministic identity and no line-ending conversion. */
export class FixtureRepo {
  readonly path = mkdtempSync(join(tmpdir(), 'tracebound-fixture-'));

  constructor() {
    this.git('init', '--quiet', '--initial-branch=main');
    this.git('config', 'core.autocrlf', 'false');
    this.git('config', 'user.name', 'Fixture');
    this.git('config', 'user.email', 'fixture@example.invalid');
    this.git('config', 'commit.gpgsign', 'false');
  }

  git(...args: string[]): string {
    return execFileSync('git', ['-C', this.path, ...args], { encoding: 'utf8', input: '' }).trim();
  }

  write(files: Record<string, string | Uint8Array>): void {
    for (const [relativePath, content] of Object.entries(files)) {
      const absolute = join(this.path, relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
    }
  }

  /** Writes and stages `files`, removes `remove`, commits, and returns the commit SHA. */
  commit(files: Record<string, string | Uint8Array>, options: { remove?: string[]; message?: string } = {}): string {
    this.write(files);
    for (const path of options.remove ?? []) this.git('rm', '--quiet', path);
    this.git('add', '--all');
    this.git('commit', '--quiet', '--allow-empty', '-m', options.message ?? 'commit');
    return this.git('rev-parse', 'HEAD');
  }

  /** Stages a raw tree entry (e.g. a symlink or gitlink) without touching the filesystem. */
  stageEntry(mode: string, objectSha: string, path: string): void {
    this.git('update-index', '--add', '--cacheinfo', `${mode},${objectSha},${path}`);
  }

  hashObject(content: string): string {
    return execFileSync('git', ['-C', this.path, 'hash-object', '-w', '--stdin'], { encoding: 'utf8', input: content }).trim();
  }

  /** Deletes a loose object from the object store, simulating repository corruption. */
  deleteObject(sha: string): void {
    const file = join(this.path, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
    chmodSync(file, 0o666);
    unlinkSync(file);
  }

  remove(): void {
    rmSync(this.path, { recursive: true, force: true });
  }
}
