import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/evaluation/m9/canonical.js';
import { LOCK_FILE, acquireWorkLock, releaseWorkLock } from '../src/evaluation/cochange/lock.js';
import { WORK_FILES } from '../src/evaluation/cochange/preflight.js';
import { publishResults, writeArtifacts, type PublishResult } from '../src/evaluation/cochange/publish.js';
import { REPORT_FILE, RESULTS_FILE } from '../src/evaluation/cochange/report.js';
import { buildSynthetic, type Built, type Scenario } from './cochange-synthetic.js';

// Each test assembles and publishes results (several 10,000-replicate bootstraps, then file writes); the 5 s default is too tight when the suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

let dir: string;
let out: string;
let repo: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracebound-publish-test-'));
  out = join(dir, 'out');
  mkdirSync(out);
  repo = mkdtempSync(join(tmpdir(), 'tracebound-publish-clone-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else result[relative(root, full)] = sha256Hex(readFileSync(full));
    }
  };
  walk(root);
  return result;
}

const publish = (built: Built, deps: Parameters<typeof publishResults>[1] = {}, outputDirectory = out) =>
  publishResults({ workDirectory: built.work, manifestPath: built.manifestPath, outputDirectory, repositoryPath: repo }, { registration: built.registration, ...deps });

function published(result: PublishResult) {
  if (result.status !== 'published') throw new Error(JSON.stringify(result));
  return result;
}

describe('publishing', () => {
  it('writes results.json as the canonical results and report.md rendered from them, and nothing else', async () => {
    const built = buildSynthetic(dir);
    const workBefore = tree(built.work);
    const result = published(await publish(built));
    expect(result).toMatchObject({ outcome: 'supported', resultsStatus: 'complete' });
    expect(readdirSync(out).sort()).toEqual([REPORT_FILE, RESULTS_FILE]);
    const resultsBytes = readFileSync(join(out, RESULTS_FILE));
    expect(sha256Hex(resultsBytes)).toBe(result.resultsSha256);
    expect(JSON.parse(resultsBytes.toString('utf8'))).toMatchObject({ schema: 'tracebound.cochange.results', status: 'complete', decision: { outcome: 'supported' } });
    expect(readFileSync(join(out, REPORT_FILE), 'utf8')).toContain(`SHA-256 \`${result.resultsSha256}\``);
    expect(result.artifacts).toEqual([
      { name: RESULTS_FILE, sha256: result.resultsSha256, bytes: resultsBytes.length, action: 'written' },
      { name: REPORT_FILE, sha256: sha256Hex(readFileSync(join(out, REPORT_FILE))), bytes: readFileSync(join(out, REPORT_FILE)).length, action: 'written' },
    ]);
    // The journals, the frozen database and the manifest are read only.
    expect(tree(built.work)).toEqual(workBefore);
  });

  it('is deterministic: identical inputs give identical artifacts, and a rerun finds them unchanged', async () => {
    const built = buildSynthetic(dir);
    const first = published(await publish(built));
    const bytes = { results: readFileSync(join(out, RESULTS_FILE)), report: readFileSync(join(out, REPORT_FILE)) };
    const second = published(await publish(built));
    expect(second.artifacts.map((a) => a.action)).toEqual(['unchanged', 'unchanged']);
    expect(second.resultsSha256).toBe(first.resultsSha256);
    expect(readFileSync(join(out, RESULTS_FILE)).equals(bytes.results)).toBe(true);
    expect(readFileSync(join(out, REPORT_FILE)).equals(bytes.report)).toBe(true);

    // A second, independent publication of identically built inputs writes the same bytes.
    const other = mkdtempSync(join(tmpdir(), 'tracebound-publish-test-'));
    try {
      const again = buildSynthetic(other);
      const otherOut = join(other, 'out');
      mkdirSync(otherOut);
      published(await publish(again, {}, otherOut));
      expect(readFileSync(join(otherOut, RESULTS_FILE)).equals(bytes.results)).toBe(true);
      expect(readFileSync(join(otherOut, REPORT_FILE)).equals(bytes.report)).toBe(true);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('publishes a primary-incomplete evaluation as Inconclusive, without primary estimates', async () => {
    const scenario: Scenario = { failures: [{ i: 7, methods: ['hybrid', 'deterministic', 'semantic', 'no-description'], stage: 'retrieval' }] };
    const result = published(await publish(buildSynthetic(dir, scenario)));
    expect(result).toMatchObject({ outcome: 'inconclusive', resultsStatus: 'primary-incomplete' });
    const results = JSON.parse(readFileSync(join(out, RESULTS_FILE), 'utf8'));
    expect(results.primary).toEqual({ estimated: false, reason: 'primary-incomplete' });
    expect(results.decision).toMatchObject({ outcome: 'inconclusive', rule: 'incomplete-run' });
    const report = readFileSync(join(out, REPORT_FILE), 'utf8');
    expect(report).toContain('**Result: INCONCLUSIVE**');
    expect(report).not.toContain('## Primary results');
  });

  it('keeps sensitivity separate: an arm failure changes the sensitivity section only', async () => {
    const plain = published(await publish(buildSynthetic(dir)));
    const plainResults = JSON.parse(readFileSync(join(out, RESULTS_FILE), 'utf8'));
    rmSync(dir, { recursive: true });
    dir = mkdtempSync(join(tmpdir(), 'tracebound-publish-test-'));
    out = join(dir, 'out');
    mkdirSync(out);
    const withFailure = published(await publish(buildSynthetic(dir, { failures: [{ i: 4, methods: ['no-description'], stage: 'retrieval' }] })));
    const failedResults = JSON.parse(readFileSync(join(out, RESULTS_FILE), 'utf8'));
    expect(failedResults.primary).toEqual(plainResults.primary);
    expect(failedResults.decision).toEqual(plainResults.decision);
    expect(failedResults.sensitivity.commonPopulation).toHaveLength(29);
    expect(withFailure.resultsSha256).not.toBe(plain.resultsSha256);
  });

  it('leaks no path, raw message or machine detail into either artifact', async () => {
    const built = buildSynthetic(dir, { failures: [{ i: 3, methods: ['hybrid', 'deterministic', 'semantic', 'no-description'], stage: 'retrieval' }], unprepared: [5] });
    published(await publish(built));
    for (const file of [RESULTS_FILE, REPORT_FILE]) {
      const text = readFileSync(join(out, file), 'utf8');
      expect(text, file).not.toMatch(/path broke|C:\\|\/Users\/|AppData|tree unreadable/);
      expect(text, file).not.toContain(dir);
      expect(text, file).not.toContain('work');
    }
  });
});

describe('refusals', () => {
  it.each([
    ['a missing work directory', (built: Built) => publishResults({ workDirectory: join(dir, 'none'), manifestPath: built.manifestPath, outputDirectory: out, repositoryPath: repo }, { registration: built.registration })],
    ['a missing output directory', (built: Built) => publish(built, {}, join(dir, 'none'))],
    ['an output directory that is a file', (built: Built) => (writeFileSync(join(dir, 'file'), 'x'), publish(built, {}, join(dir, 'file')))],
    ['an output directory inside the work directory', (built: Built) => (mkdirSync(join(built.work, 'out')), publish(built, {}, join(built.work, 'out')))],
    ['an output directory that is the dataset repository', (built: Built) => publish(built, {}, repo)],
    ['an output directory inside the dataset repository', (built: Built) => (mkdirSync(join(repo, 'docs')), publish(built, {}, join(repo, 'docs')))],
  ])('refuses %s and writes nothing', async (_label, attempt) => {
    const built = buildSynthetic(dir);
    const before = tree(dir);
    const result = await attempt(built);
    expect(result.status).toBe('refused');
    expect(Object.keys(tree(dir)).filter((name) => name.startsWith('out'))).toEqual([]);
    expect(Object.keys(before).every((name) => name in tree(dir))).toBe(true);
  });

  it('refuses an evaluation that assembly refuses, naming its reason', async () => {
    const built = buildSynthetic(dir, {}, { records: 12 });
    expect(await publish(built)).toMatchObject({ status: 'refused', reason: 'evaluation-incomplete' });
    expect(readdirSync(out)).toEqual([]);
  });

  it('refuses a frozen database other than the one the evaluation read', async () => {
    const built = buildSynthetic(dir);
    writeFileSync(join(built.work, WORK_FILES.frozenDatabase), 'another database');
    expect(await publish(built)).toMatchObject({ status: 'refused', reason: 'frozen-database-mismatch' });
    expect(readdirSync(out)).toEqual([]);
  });

  it('refuses when the manifest is not the registered one', async () => {
    const built = buildSynthetic(dir);
    expect(await publish(built, { registration: { ...built.registration, manifestSha256: 'd'.repeat(64) } })).toMatchObject({ status: 'refused', reason: 'manifest-mismatch' });
    expect(readdirSync(out)).toEqual([]);
  });
});

describe('existing artifacts', () => {
  it('never overwrites a conflicting file, and writes nothing when either file conflicts', async () => {
    const built = buildSynthetic(dir);
    writeFileSync(join(out, REPORT_FILE), 'an earlier report');
    expect(await publish(built)).toMatchObject({ status: 'refused', reason: 'artifact-conflict' });
    expect(tree(out)).toEqual({ [REPORT_FILE]: sha256Hex('an earlier report') });

    rmSync(join(out, REPORT_FILE));
    writeFileSync(join(out, RESULTS_FILE), '{"earlier":true}');
    expect(await publish(built)).toMatchObject({ status: 'refused', reason: 'artifact-conflict' });
    expect(tree(out)).toEqual({ [RESULTS_FILE]: sha256Hex('{"earlier":true}') });
  });

  it('refuses a conflicting file even when it is a directory', async () => {
    const built = buildSynthetic(dir);
    mkdirSync(join(out, RESULTS_FILE));
    expect(await publish(built)).toMatchObject({ status: 'refused', reason: 'artifact-conflict' });
  });

  it('accepts an identical existing file after verifying its bytes, and completes the missing one', async () => {
    const built = buildSynthetic(dir);
    published(await publish(built));
    const report = readFileSync(join(out, REPORT_FILE));
    rmSync(join(out, REPORT_FILE));
    const result = published(await publish(built));
    expect(result.artifacts.map((a) => [a.name, a.action])).toEqual([[RESULTS_FILE, 'unchanged'], [REPORT_FILE, 'written']]);
    expect(readFileSync(join(out, REPORT_FILE)).equals(report)).toBe(true);
  });
});

describe('atomic writing', () => {
  it('cleans up its temporary file and leaves no final file when interrupted before linking', async () => {
    const built = buildSynthetic(dir);
    await expect(publish(built, { beforeLink: (name) => name === REPORT_FILE && (() => { throw new Error('simulated crash'); })() })).rejects.toThrow('simulated crash');
    expect(readdirSync(out)).toEqual([RESULTS_FILE]);
    expect(tree(built.work)[LOCK_FILE]).toBeUndefined();
    // A rerun finds the first file identical and writes the missing one.
    const result = published(await publish(built));
    expect(result.artifacts.map((a) => a.action)).toEqual(['unchanged', 'written']);
    expect(readdirSync(out).sort()).toEqual([REPORT_FILE, RESULTS_FILE]);
  });

  it('never leaves a temporary file behind, whatever happens', async () => {
    const built = buildSynthetic(dir);
    await expect(publish(built, { beforeLink: () => { throw new Error('crash'); } })).rejects.toThrow('crash');
    expect(readdirSync(out)).toEqual([]);
    writeFileSync(join(out, RESULTS_FILE), 'conflict');
    await publish(built);
    expect(readdirSync(out).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('notices a conflicting file that appears after the examination, and does not replace it', async () => {
    const built = buildSynthetic(dir);
    const result = await publish(built, { beforeLink: (name) => name === RESULTS_FILE && writeFileSync(join(out, RESULTS_FILE), 'appeared meanwhile') });
    expect(result).toMatchObject({ status: 'refused', reason: 'artifact-conflict' });
    expect(readFileSync(join(out, RESULTS_FILE), 'utf8')).toBe('appeared meanwhile');
    expect(readdirSync(out).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('the lock', () => {
  it('takes the lock once, holds it while writing, and releases it', async () => {
    const built = buildSynthetic(dir);
    const heldDuringWrite: boolean[] = [];
    published(await publish(built, { beforeLink: () => heldDuringWrite.push(Object.keys(tree(built.work)).includes(LOCK_FILE)) }));
    expect(heldDuringWrite).toEqual([true, true]);
    expect(Object.keys(tree(built.work))).not.toContain(LOCK_FILE);
  });

  it('refuses while another invocation holds the lock, touching nothing', async () => {
    const built = buildSynthetic(dir);
    const held = acquireWorkLock(built.work, 'someone else');
    if (held.status !== 'acquired') throw new Error('not acquired');
    const before = tree(dir);
    expect(await publish(built)).toMatchObject({ status: 'locked', lock: { status: 'held' } });
    expect(tree(dir)).toEqual(before);
    releaseWorkLock(held.lock);
    expect((await publish(built)).status).toBe('published');
  });

  it('writes nothing when the lock is lost before the first file', async () => {
    const built = buildSynthetic(dir);
    const held = acquireWorkLock(built.work, 'owner');
    if (held.status !== 'acquired') throw new Error('not acquired');
    rmSync(join(built.work, LOCK_FILE));
    const result = writeArtifacts(out, [{ name: RESULTS_FILE, bytes: Buffer.from('x') }], held.lock);
    expect(result).toMatchObject({ status: 'refused', reason: 'lock-lost' });
    expect(readdirSync(out)).toEqual([]);
  });

  it('stops after a file and removes nothing else when the lock is lost during the write', async () => {
    const built = buildSynthetic(dir);
    const foreign = `${JSON.stringify({ schema: 'tracebound.cochange.lock', version: 1, token: 'other', purpose: 'other', pid: 1, hostname: 'elsewhere.invalid', startedAt: '2026-10-15T00:00:00.000Z' })}\n`;
    const result = await publish(built, { beforeLink: (name) => name === REPORT_FILE && writeFileSync(join(built.work, LOCK_FILE), foreign) });
    expect(result).toMatchObject({ status: 'refused', reason: 'lock-lost' });
    expect(readFileSync(join(built.work, LOCK_FILE), 'utf8')).toBe(foreign);
    expect(readdirSync(out).sort()).toEqual([RESULTS_FILE]);
  });
});
