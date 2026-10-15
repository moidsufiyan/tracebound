import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireWorkLock, LOCK_FILE, LockLostError, releaseWorkLock, verifyWorkLock, type LockOwner } from '../src/evaluation/cochange/lock.js';

const LOCK_MODULE = pathToFileURL(join(import.meta.dirname, '..', 'src', 'evaluation', 'cochange', 'lock.ts')).href;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracebound-lock-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lockPath = () => join(dir, LOCK_FILE);
const record = (overrides: Partial<LockOwner> = {}): string =>
  `${JSON.stringify({ schema: 'tracebound.cochange.lock', version: 1, token: 'someone-else', purpose: 'other', pid: process.pid, hostname: hostname(), startedAt: '2026-10-15T00:00:00.000Z', ...overrides })}\n`;

describe('in one process', () => {
  it('takes the lock, refuses a second acquisition, and releases', () => {
    const first = acquireWorkLock(dir, 'test');
    if (first.status !== 'acquired') throw new Error(JSON.stringify(first));
    expect(first.lock.owner).toMatchObject({ purpose: 'test', pid: process.pid, hostname: hostname() });
    expect(JSON.parse(readFileSync(lockPath(), 'utf8'))).toEqual(first.lock.owner);

    const second = acquireWorkLock(dir, 'test');
    expect(second).toMatchObject({ status: 'held', owner: first.lock.owner, ownerProcess: 'running' });
    expect(JSON.parse(readFileSync(lockPath(), 'utf8'))).toEqual(first.lock.owner);

    releaseWorkLock(first.lock);
    expect(existsSync(lockPath())).toBe(false);
    expect(acquireWorkLock(dir, 'test').status).toBe('acquired');
  });

  it('never releases or verifies a lock that is not this invocation\'s', () => {
    const acquired = acquireWorkLock(dir, 'test');
    if (acquired.status !== 'acquired') throw new Error('not acquired');
    const impostor = { path: acquired.lock.path, owner: { ...acquired.lock.owner, token: 'forged' } };
    expect(() => releaseWorkLock(impostor)).toThrow(LockLostError);
    expect(existsSync(lockPath())).toBe(true);

    writeFileSync(lockPath(), record());
    expect(() => verifyWorkLock(acquired.lock)).toThrow(LockLostError);
    expect(() => releaseWorkLock(acquired.lock)).toThrow(LockLostError);
    expect(readFileSync(lockPath(), 'utf8')).toBe(record());

    rmSync(lockPath());
    expect(() => verifyWorkLock(acquired.lock)).toThrow(LockLostError);
  });

  it.each([
    ['garbage', 'not a lock'],
    ['a partly written record', record().slice(0, 30)],
    ['a record without its newline', record().slice(0, -1)],
    ['a record with an extra field', `${JSON.stringify({ ...JSON.parse(record()), extra: 1 })}\n`],
    ['another schema', record({ schema: 'other' as never })],
    ['an empty file', ''],
  ])('reports %s as malformed and leaves it in place', (_label, content) => {
    writeFileSync(lockPath(), content);
    expect(acquireWorkLock(dir, 'test')).toMatchObject({ status: 'malformed' });
    expect(readFileSync(lockPath(), 'utf8')).toBe(content);
  });

  it('reports a stale lock of a dead process but never takes it over', () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    writeFileSync(lockPath(), record({ pid: dead }));
    expect(acquireWorkLock(dir, 'test')).toMatchObject({ status: 'held', ownerProcess: 'not-running', owner: { pid: dead } });
    expect(readFileSync(lockPath(), 'utf8')).toBe(record({ pid: dead }));
  });

  it('cannot tell whether an owner on another host still runs', () => {
    writeFileSync(lockPath(), record({ hostname: 'elsewhere.invalid' }));
    expect(acquireWorkLock(dir, 'test')).toMatchObject({ status: 'held', ownerProcess: 'unknown' });
  });
});

/** A separate Node process that takes the lock, reports, and holds it until told to release (or for `holdMs`). */
function child(holdMs: number | null): { process: ChildProcessWithoutNullStreams; lines: string[]; next: () => Promise<string> } {
  const code = `
    const { acquireWorkLock, releaseWorkLock } = await import(${JSON.stringify(LOCK_MODULE)});
    const result = acquireWorkLock(process.argv[1], 'child');
    console.log(JSON.stringify({ status: result.status, pid: process.pid }));
    const release = () => { if (result.status === 'acquired') releaseWorkLock(result.lock); console.log(JSON.stringify({ status: 'released' })); process.exit(0); };
    if (${holdMs === null ? 'true' : 'false'}) process.stdin.once('data', release); else setTimeout(release, ${holdMs ?? 0});
  `;
  const proc = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', code, dir]);
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let buffer = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  const next = () => new Promise<string>((resolveLine) => (lines.length > 0 ? resolveLine(lines.shift()!) : waiters.push(resolveLine)));
  return { process: proc, lines, next };
}

const exited = (proc: ChildProcessWithoutNullStreams) => new Promise<number | null>((resolveExit) => (proc.exitCode !== null ? resolveExit(proc.exitCode) : proc.once('exit', resolveExit)));

describe('across processes', () => {
  it('excludes this process while another process holds the lock, and allows it after release', async () => {
    const holder = child(null);
    const first = JSON.parse(await holder.next()) as { status: string; pid: number };
    expect(first).toEqual({ status: 'acquired', pid: holder.process.pid });

    const attempt = acquireWorkLock(dir, 'parent');
    expect(attempt).toMatchObject({ status: 'held', owner: { pid: holder.process.pid, purpose: 'child' }, ownerProcess: 'running' });

    holder.process.stdin.write('release\n');
    expect(JSON.parse(await holder.next())).toEqual({ status: 'released' });
    await exited(holder.process);
    const after = acquireWorkLock(dir, 'parent');
    expect(after.status).toBe('acquired');
    if (after.status === 'acquired') releaseWorkLock(after.lock);
  }, 30_000);

  it('lets exactly one of several processes racing for the lock take it', async () => {
    const racers = Array.from({ length: 6 }, () => child(3000));
    const results = await Promise.all(racers.map(async (racer) => JSON.parse(await racer.next()) as { status: string }));
    expect(results.filter((r) => r.status === 'acquired')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'held' || r.status === 'malformed')).toHaveLength(5);
    await Promise.all(racers.map((racer) => exited(racer.process)));
    expect(existsSync(lockPath())).toBe(false);
  }, 30_000);
});
