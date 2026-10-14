import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyPath,
  DESIGN_CASE_COMMITS,
  samplePositions,
  selectCochangeCommits,
  serializeManifest,
  ShallowRepositoryError,
  UnsupportedSelectionRangeError,
  type CochangeManifest,
  type SelectionResult,
} from '../src/evaluation/cochange/selector.js';
import { CommitNotFoundError, diffCommits, InvalidCommitShaError, listCommitHistory } from '../src/git/git.js';

// The co-change selector over disposable repositories built with one `git fast-import` each, so
// committer times are exact and dozens of commits cost one process.

interface Spec {
  mark: string;
  subject: string;
  time: number;
  /** Mark of the first parent; omitted for a root commit. */
  from?: string;
  /** Mark of a second parent (a merge). */
  merge?: string;
  branch?: string;
  body?: string;
  files?: Record<string, string>;
  remove?: string[];
  rename?: [string, string][];
}

const repos: string[] = [];
afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

function data(text: string): string {
  return `data ${Buffer.byteLength(text, 'utf8')}\n${text}\n`;
}

/** A repository whose commits are `specs`, in order; returns its path and the SHA of each mark. */
function buildRepo(specs: Spec[]): { path: string; sha: (mark: string) => string } {
  const path = mkdtempSync(join(tmpdir(), 'tracebound-cochange-'));
  repos.push(path);
  const git = (args: string[], input?: string) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', input: input ?? '' }).trim();
  git(['init', '--quiet', '--initial-branch=main']);
  let stream = '';
  specs.forEach((spec, i) => {
    stream += `commit refs/heads/${spec.branch ?? 'main'}\nmark :${i + 1}\ncommitter Fixture <fixture@example.invalid> ${spec.time} +0000\n`;
    stream += data(spec.body ? `${spec.subject}\n\n${spec.body}\n` : `${spec.subject}\n`);
    if (spec.from) stream += `from :${specs.findIndex((s) => s.mark === spec.from) + 1}\n`;
    if (spec.merge) stream += `merge :${specs.findIndex((s) => s.mark === spec.merge) + 1}\n`;
    for (const [from, to] of spec.rename ?? []) stream += `R ${from} ${to}\n`;
    for (const file of spec.remove ?? []) stream += `D ${file}\n`;
    for (const [file, content] of Object.entries(spec.files ?? {})) stream += `M 100644 inline ${file}\n${data(content)}`;
    stream += '\n';
  });
  const marks = join(path, '.git', 'marks');
  git(['fast-import', '--quiet', `--export-marks=${marks}`], stream);
  const shaByMark = new Map(
    readFileSync(marks, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(' ') as [string, string])
      .map(([mark, sha]) => [specs[Number(mark.slice(1)) - 1]!.mark, sha]),
  );
  return { path, sha: (mark) => shaByMark.get(mark)! };
}

const BASE_FILES: Record<string, string> = {
  'src/a.ts': 'export const a = 1;\n',
  'src/a.test.ts': "import { a } from './a';\n",
  'src/b.ts': 'export const b = 1;\n',
  'src/c.ts': 'export const c = 1;\n',
  'src/d.ts': 'export const d = 1;\n',
  'src/d.test.ts': Array.from({ length: 20 }, (_, i) => `// line ${i} of the d test\n`).join(''),
  'src/e.ts': 'export const e = 1;\n',
  'docs/old.md': '# Old\n',
  'docs/guide.md': '# Guide\n',
  'CHANGELOG.md': '# Changelog\n',
  'package.json': '{}\n',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/many${i}.ts`, `export const m${i} = 0;\n`])),
};

/** A filler commit: modifies a source file and its test, so it is eligible. */
const filler = (n: number, from: string, time: number): Spec => ({
  mark: `f${n}`,
  subject: `feat: filler ${n}`,
  time,
  from,
  files: { [`src/fill${n}.ts`]: `export const v = ${n};\n`, [`src/fill${n}.test.ts`]: `// test ${n}\n` },
});

/** The main fixture: a root, 30 eligible fillers (each also creating its files), then one commit per case. */
function mainSpecs(): Spec[] {
  const specs: Spec[] = [{ mark: 'root', subject: 'chore: root', time: 1_000, files: BASE_FILES }];
  // Fillers 0..29 create their files; fillers 30..59 then modify them, so they are eligible.
  for (let n = 0; n < 30; n++) {
    specs.push({ mark: `create${n}`, subject: `chore: create ${n}`, time: 2_000 + n, from: specs.at(-1)!.mark, files: { [`src/fill${n}.ts`]: 'export const v = -1;\n', [`src/fill${n}.test.ts`]: '// initial\n' } });
  }
  for (let n = 0; n < 30; n++) specs.push(filler(n, specs.at(-1)!.mark, 3_000 + n));
  const add = (spec: Omit<Spec, 'from'>) => specs.push({ ...spec, from: specs.at(-1)!.mark });
  add({ mark: 'modify', subject: 'fix: modify a with its test', time: 4_000, files: { 'src/a.ts': 'export const a = 2;\n', 'src/a.test.ts': "import { a } from './a';\n// more\n" } });
  add({ mark: 'addedTarget', subject: 'feat: b gains a new test', time: 4_001, files: { 'src/b.ts': 'export const b = 2;\n', 'src/b.test.ts': '// new\n' } });
  add({ mark: 'deletedTarget', subject: 'refactor: c drops an old doc', time: 4_002, files: { 'src/c.ts': 'export const c = 2;\n' }, remove: ['docs/old.md'] });
  add({ mark: 'renamedTarget', subject: 'refactor: rename the d test', time: 4_003, files: { 'src/d.ts': 'export const d = 2;\n' }, rename: [['src/d.test.ts', 'src/d-renamed.test.ts']] });
  add({ mark: 'changelogOnly', subject: 'chore: e and changelog', time: 4_004, files: { 'src/e.ts': 'export const e = 2;\n', 'CHANGELOG.md': '# Changelog\n- e\n' } });
  add({ mark: 'testOnly', subject: 'test: a only', time: 4_005, files: { 'src/a.test.ts': '// only the test\n' } });
  add({ mark: 'configOnly', subject: 'chore: config', time: 4_006, files: { 'package.json': '{"x":1}\n', 'docs/guide.md': '# Guide v2\n' } });
  add({ mark: 'empty', subject: 'chore: empty', time: 4_007 });
  add({
    mark: 'eleven',
    subject: 'chore: eleven files',
    time: 4_008,
    files: { ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/many${i}.ts`, `export const m${i} = 1;\n`])), 'docs/guide.md': '# Guide v3\n' },
  });
  add({
    mark: 'tenWithRename',
    subject: 'chore: ten records, one a rename',
    time: 4_009,
    files: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`src/many${i}.ts`, `export const m${i} = 2;\n`])),
    rename: [['docs/guide.md', 'docs/handbook.md']],
  });
  add({ mark: 'quoted', subject: 'fix: handle "quotes" and ünïcode — in a', body: 'A body line.\n\nMore body.', time: 4_010, files: { 'src/a.ts': 'export const a = 3;\n', 'src/a.test.ts': '// quoted\n' } });
  // Two commits with the same time (SHA tie-break), and one older than its parent (time, not topology).
  add({ mark: 'tieA', subject: 'fix: tie A', time: 4_020, files: { 'src/e.ts': 'export const e = 3;\n', 'docs/handbook.md': '# Handbook v1\n' } });
  add({ mark: 'tieB', subject: 'fix: tie B', time: 4_020, files: { 'src/e.ts': 'export const e = 4;\n', 'docs/handbook.md': '# Handbook v2\n' } });
  add({ mark: 'early', subject: 'fix: committed with an early clock', time: 1_500, files: { 'src/c.ts': 'export const c = 3;\n', 'docs/handbook.md': '# Handbook v3\n' } });
  // A merge of a side branch.
  specs.push({ mark: 'side', subject: 'feat: side work', time: 4_030, from: 'early', branch: 'side', files: { 'src/b.ts': 'export const b = 9;\n', 'src/a.test.ts': '// side\n' } });
  specs.push({ mark: 'merge', subject: 'merge side', time: 4_031, from: 'early', merge: 'side', files: { 'src/b.ts': 'export const b = 9;\n', 'src/a.test.ts': '// side\n' } });
  return specs;
}

let main: { path: string; sha: (mark: string) => string };
let result: SelectionResult;
let manifest: CochangeManifest;

beforeAll(async () => {
  main = buildRepo(mainSpecs());
  result = await selectCochangeCommits({ repoPath: main.path, repositoryName: 'fixture/main', head: main.sha('merge'), designCaseCommits: [] });
  if (result.status !== 'selected') throw new Error(`fixture not selected: ${JSON.stringify(result)}`);
  manifest = result.manifest;
}, 120_000);

const commit = (mark: string) => manifest.commits.find((c) => c.sha === main.sha(mark));

describe('classification', () => {
  it('classifies paths by the fixed rules', () => {
    expect(classifyPath('src/a.ts', 'code')).toBe('source');
    expect(classifyPath('src/a.test.ts', 'code')).toBe('test');
    expect(classifyPath('src/a.spec.tsx', 'code')).toBe('test');
    expect(classifyPath('test/helpers/a.ts', 'code')).toBe('test');
    expect(classifyPath('src/__tests__/a.ts', 'code')).toBe('test');
    expect(classifyPath('src/testing/a.ts', 'code')).toBe('source');
    expect(classifyPath('docs/a.md', 'document')).toBe('doc');
    expect(classifyPath('CHANGELOG.md', 'document')).toBe('ignored');
    expect(classifyPath('packages/x/changes.txt', 'document')).toBe('ignored');
    expect(classifyPath('.changeset/brave-cats.md', 'document')).toBe('ignored');
    expect(classifyPath('package.json', 'config')).toBe('ignored');
  });
});

describe('eligibility', () => {
  it('keeps single-parent commits with a source input and a test or doc target in the base', () => {
    expect(commit('modify')).toMatchObject({ base: main.sha('f29'), subject: 'fix: modify a with its test', inputs: ['src/a.ts'], targets: [{ path: 'src/a.test.ts', kind: 'test', status: 'modified' }] });
    for (let n = 0; n < 30; n++) expect(commit(`f${n}`)?.inputs).toEqual([`src/fill${n}.ts`]);
  });

  it('excludes root and merge commits, and counts every rejection reason', () => {
    expect(commit('root')).toBeUndefined();
    expect(commit('merge')).toBeUndefined();
    expect(commit('side')).toMatchObject({ inputs: ['src/b.ts'] }); // the side commit itself has one parent
    expect(manifest.counts.rejected).toEqual({ root: 1, merge: 1, design_case: 0, too_many_changes: 1, no_changes: 1, no_source_input: 32, no_target: 2 });
    expect(manifest.counts.reachable).toBe(mainSpecs().length);
  });

  it('never uses an added file as a target, but keeps a deleted one that exists in the base', () => {
    expect(commit('addedTarget')).toBeUndefined(); // src/b.test.ts is new, so b has no target
    expect(commit('deletedTarget')).toMatchObject({ inputs: ['src/c.ts'], targets: [{ path: 'docs/old.md', kind: 'doc', status: 'deleted' }] });
  });

  it('judges a rename by its base-side path', () => {
    const renamed = commit('renamedTarget')!;
    expect(renamed.targets).toEqual([{ path: 'src/d.test.ts', kind: 'test', status: 'renamed' }]);
    expect(renamed.changes.find((c) => c.status === 'renamed')).toMatchObject({ path: 'src/d-renamed.test.ts', previousPath: 'src/d.test.ts', basePath: 'src/d.test.ts', baseClass: 'test', similarity: 100 });
  });

  it('ignores release bookkeeping and configuration, and needs a source input', () => {
    expect(commit('changelogOnly')).toBeUndefined(); // CHANGELOG.md is not a target
    expect(commit('testOnly')).toBeUndefined(); // no source input
    expect(commit('configOnly')).toBeUndefined(); // package.json is not a source
    expect(commit('empty')).toBeUndefined();
  });

  it('allows at most 10 change records, counting a rename once', () => {
    expect(commit('eleven')).toBeUndefined();
    const ten = commit('tenWithRename')!;
    expect(ten.changes).toHaveLength(10);
    expect(ten.targets).toEqual([{ path: 'docs/guide.md', kind: 'doc', status: 'renamed' }]);
    expect(ten.inputs).toHaveLength(9);
  });

  it('keeps inputs and targets apart, inputs being sources and targets tests or docs', () => {
    for (const c of manifest.commits) {
      const targets = new Set(c.targets.map((t) => t.path));
      expect(c.inputs.some((p) => targets.has(p))).toBe(false);
      for (const p of c.inputs) expect(c.changes.find((ch) => ch.basePath === p)?.baseClass).toBe('source');
    }
  });

  it('preserves the commit subject exactly as git log %s gives it', () => {
    expect(commit('quoted')?.subject).toBe('fix: handle "quotes" and ünïcode — in a');
  });
});

describe('ordering and sampling', () => {
  it('orders the selected commits by committer time, then SHA, not by topology', () => {
    const times = new Map(mainSpecs().map((s) => [s.mark, s.time]));
    const marks = manifest.commits.map((c) => mainSpecs().find((s) => main.sha(s.mark) === c.sha)!.mark);
    expect(marks[0]).toBe('early'); // its parent is newer, but its committer time is the oldest
    const ordered = [...marks].sort((a, b) => times.get(a)! - times.get(b)! || (main.sha(a) < main.sha(b) ? -1 : 1));
    expect(marks).toEqual(ordered);
    const tie = [main.sha('tieA'), main.sha('tieB')].sort();
    expect(manifest.commits.map((c) => c.sha).filter((sha) => tie.includes(sha))).toEqual(tie);
    expect(manifest.commits.map((c) => c.eligibleIndex)).toEqual(manifest.commits.map((_, i) => i));
  });

  it('uses every eligible commit when there are 30 to 50', () => {
    expect(manifest.counts.eligible).toBeGreaterThanOrEqual(30);
    expect(manifest.counts.eligible).toBeLessThanOrEqual(50);
    expect(manifest.counts.selected).toBe(manifest.counts.eligible);
    expect(manifest.commits).toHaveLength(manifest.counts.eligible);
  });

  it('spaces 50 positions evenly from the oldest when there are more than 50', () => {
    expect(samplePositions(30)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(samplePositions(50)).toHaveLength(50);
    const p = samplePositions(51);
    expect(p).toHaveLength(50);
    expect(new Set(p).size).toBe(50);
    expect(p).toEqual(Array.from({ length: 50 }, (_, i) => Math.floor((i * 51) / 50)));
    expect(samplePositions(200)).toEqual(Array.from({ length: 50 }, (_, i) => i * 4));
  });

  it('selects 50 of 55 eligible commits at the specified positions', async () => {
    const specs: Spec[] = [{ mark: 'root', subject: 'root', time: 1, files: Object.fromEntries(Array.from({ length: 55 }, (_, n) => [`src/s${n}.ts`, '0\n']).concat(Array.from({ length: 55 }, (_, n) => [`src/s${n}.test.ts`, '0\n']))) }];
    for (let n = 0; n < 55; n++) specs.push({ mark: `c${n}`, subject: `c${n}`, time: 10 + n, from: specs.at(-1)!.mark, files: { [`src/s${n}.ts`]: '1\n', [`src/s${n}.test.ts`]: '1\n' } });
    const repo = buildRepo(specs);
    const big = await selectCochangeCommits({ repoPath: repo.path, repositoryName: 'fixture/big', head: repo.sha('c54'), designCaseCommits: [] });
    expect(big.status).toBe('selected');
    if (big.status !== 'selected') return;
    expect(big.manifest.counts).toMatchObject({ eligible: 55, selected: 50 });
    expect(big.manifest.commits.map((c) => c.eligibleIndex)).toEqual(samplePositions(55));
    expect(big.manifest.commits.map((c) => c.sha)).toEqual(samplePositions(55).map((i) => repo.sha(`c${i}`)));
  }, 120_000);
});

describe('sample size, independence and bounds', () => {
  it('reports fewer than the minimum instead of relaxing the rules, including an empty result', async () => {
    const specs: Spec[] = [{ mark: 'root', subject: 'root', time: 1, files: BASE_FILES }];
    for (let n = 0; n < 29; n++) specs.push({ ...filler(n, specs.at(-1)!.mark, 10 + n), mark: `x${n}` }); // creates fill files: not eligible
    for (let n = 0; n < 29; n++) specs.push({ ...filler(n, specs.at(-1)!.mark, 100 + n), mark: `y${n}`, files: { [`src/fill${n}.ts`]: 'changed\n', [`src/fill${n}.test.ts`]: 'changed\n' } });
    const repo = buildRepo(specs);
    const few = await selectCochangeCommits({ repoPath: repo.path, repositoryName: 'fixture/few', head: repo.sha('y28'), designCaseCommits: [] });
    expect(few).toMatchObject({ status: 'insufficient', eligible: 29, minimum: 30, counts: { eligible: 29, selected: 0 } });

    const empty = await selectCochangeCommits({ repoPath: repo.path, repositoryName: 'fixture/few', head: repo.sha('root'), designCaseCommits: [] });
    expect(empty).toMatchObject({ status: 'insufficient', eligible: 0, minimum: 30, counts: { reachable: 1, rejected: { root: 1 } } });
  }, 120_000);

  it('excludes design-case commits and refuses a repository that contains one', async () => {
    const designCase = main.sha('modify');
    const dependent = await selectCochangeCommits({ repoPath: main.path, repositoryName: 'fixture/main', head: main.sha('merge'), designCaseCommits: [designCase.toUpperCase()] });
    expect(dependent).toMatchObject({ status: 'not_independent', designCaseCommitsReachable: [designCase], counts: { rejected: { design_case: 1 } } });
    if (dependent.status !== 'not_independent') return;
    expect(dependent.counts.eligible).toBe(manifest.counts.eligible - 1);
    expect(manifest.exclusions.designCaseCommits).toEqual([]);
  }, 120_000);

  it('bounds the history below by a pinned ancestor, and refuses a bound that is not one', async () => {
    const bounded = await selectCochangeCommits({ repoPath: main.path, repositoryName: 'fixture/main', head: main.sha('merge'), since: main.sha('f9'), designCaseCommits: [] });
    expect(bounded.status).toBe('insufficient');
    if (bounded.status !== 'insufficient') return;
    expect(bounded.counts.reachable).toBe(manifest.counts.reachable - (1 + 30 + 10)); // root, creators and f0..f9 are below the bound
    await expect(selectCochangeCommits({ repoPath: main.path, repositoryName: 'r', head: main.sha('f9'), since: main.sha('merge'), designCaseCommits: [] })).rejects.toThrow(UnsupportedSelectionRangeError);
    await expect(selectCochangeCommits({ repoPath: main.path, repositoryName: 'r', head: main.sha('f9'), since: main.sha('f9'), designCaseCommits: [] })).rejects.toThrow(UnsupportedSelectionRangeError);
  }, 120_000);

  it('rejects refs, abbreviations and option-like input before running Git, and unknown commits', async () => {
    const out = join(main.path, 'written-by-git.txt');
    const attempts = [{ head: 'HEAD' }, { head: 'main' }, { head: main.sha('merge').slice(0, 12) }, { head: `--output=${out}` }, { head: main.sha('merge'), since: `--output=${out}` }, { head: main.sha('merge'), since: 'HEAD~3' }];
    for (const attempt of attempts) {
      await expect(selectCochangeCommits({ repoPath: main.path, repositoryName: 'r', designCaseCommits: [], ...attempt })).rejects.toThrow(InvalidCommitShaError);
    }
    await expect(selectCochangeCommits({ repoPath: main.path, repositoryName: 'r', head: main.sha('merge'), designCaseCommits: ['not-a-sha'] })).rejects.toThrow(InvalidCommitShaError);
    expect(existsSync(out)).toBe(false);
    await expect(selectCochangeCommits({ repoPath: main.path, repositoryName: 'r', head: 'f'.repeat(40), designCaseCommits: [] })).rejects.toThrow(CommitNotFoundError);
  });
});

describe('history boundaries and Git argument handling', () => {
  /** A root with 36 sources and tests, a design-case commit D, then 35 eligible commits. */
  function boundedRepo() {
    const files = Object.fromEntries(Array.from({ length: 36 }, (_, i) => [[`src/s${i}.ts`, '0\n'], [`src/s${i}.test.ts`, '0\n']]).flat() as [string, string][]);
    const specs: Spec[] = [{ mark: 'root', subject: 'root', time: 1, files }, { mark: 'design', subject: 'design case', time: 2, from: 'root', files: { 'src/s0.ts': 'D\n', 'src/s0.test.ts': 'D\n' } }];
    for (let i = 1; i < 36; i++) specs.push({ mark: `c${i}`, subject: `c${i}`, time: 10 + i, from: specs.at(-1)!.mark, files: { [`src/s${i}.ts`]: '1\n', [`src/s${i}.test.ts`]: '1\n' } });
    return buildRepo(specs);
  }

  it('refuses a design-case ancestor of the head even when `since` excludes it from selection', async () => {
    const repo = boundedRepo();
    const design = repo.sha('design');
    const bounded = await selectCochangeCommits({ repoPath: repo.path, repositoryName: 'r', head: repo.sha('c35'), since: design, designCaseCommits: [design] });
    expect(bounded).toMatchObject({ status: 'not_independent', designCaseCommitsReachable: [design] });
  }, 120_000);

  it('ignores design-case SHAs the repository does not contain as commits', async () => {
    const blob = execFileSync('git', ['-C', main.path, 'hash-object', '-w', '--stdin'], { input: 'not a commit\n', encoding: 'utf8' }).trim();
    const again = await selectCochangeCommits({ repoPath: main.path, repositoryName: 'fixture/main', head: main.sha('merge'), designCaseCommits: ['e'.repeat(40), blob] });
    expect(again.status).toBe('selected');
    if (again.status !== 'selected') return;
    expect(again.manifest.commits).toEqual(manifest.commits);
    expect(again.manifest.exclusions.designCaseCommits).toEqual([blob, 'e'.repeat(40)].sort());
  }, 120_000);

  it('refuses a shallow clone instead of reading its truncated history as independence', async () => {
    const shallow = mkdtempSync(join(tmpdir(), 'tracebound-cochange-shallow-'));
    repos.push(shallow);
    rmSync(shallow, { recursive: true, force: true });
    execFileSync('git', ['clone', '--quiet', '--depth', '3', '--branch', 'main', pathToFileURL(main.path).href, shallow], { encoding: 'utf8', input: '' });
    await expect(selectCochangeCommits({ repoPath: shallow, repositoryName: 'fixture/shallow', head: main.sha('merge'), designCaseCommits: [] })).rejects.toThrow(ShallowRepositoryError);
  }, 120_000);

  it('is not confused by working-tree files named like the commits it reads', async () => {
    const repo = buildRepo([
      { mark: 'root', subject: 'root', time: 1, files: { 'src/a.ts': '0\n', 'src/a.test.ts': '0\n' } },
      { mark: 'next', subject: 'next', time: 2, from: 'root', files: { 'src/a.ts': '1\n', 'src/a.test.ts': '1\n' } },
    ]);
    writeFileSync(join(repo.path, repo.sha('root')), 'same name as the base commit\n');
    writeFileSync(join(repo.path, repo.sha('next')), 'same name as the head commit\n');
    expect((await listCommitHistory(repo.path, repo.sha('next'), repo.sha('root'))).map((c) => c.sha)).toEqual([repo.sha('next')]);
    expect(await diffCommits(repo.path, repo.sha('root'), repo.sha('next'))).toEqual([
      { status: 'modified', path: 'src/a.test.ts', previousPath: null, similarity: null },
      { status: 'modified', path: 'src/a.ts', previousPath: null, similarity: null },
    ]);
    const result = await selectCochangeCommits({ repoPath: repo.path, repositoryName: 'r', head: repo.sha('next'), designCaseCommits: [] });
    expect(result).toMatchObject({ status: 'insufficient', eligible: 1 });
  }, 120_000);

  it('records change records in head-path order, then base-path order', () => {
    for (const c of manifest.commits) {
      const keys = c.changes.map((ch) => [ch.path, ch.previousPath ?? ''] as const);
      const sorted = [...keys].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
      expect(keys).toEqual(sorted);
    }
    // The rename (docs/guide.md -> docs/handbook.md) sorts by its head-side path among the nine sources.
    expect(commit('tenWithRename')!.changes.map((ch) => ch.path)[0]).toBe('docs/handbook.md');
  });
});

describe('the manifest', () => {
  it('serializes to the same bytes on a second, independent run', async () => {
    const again = await selectCochangeCommits({ repoPath: main.path, repositoryName: 'fixture/main', head: main.sha('merge'), designCaseCommits: [] });
    expect(again.status).toBe('selected');
    if (again.status !== 'selected') return;
    expect(serializeManifest(again.manifest)).toBe(serializeManifest(manifest));
  }, 120_000);

  it('records the identity, rules and exclusions, and nothing machine-specific or time-dependent', () => {
    const text = serializeManifest(manifest);
    expect(manifest).toMatchObject({ schema: 'tracebound.cochange.manifest', protocol: { path: 'docs/evaluation/cochange/protocol.md', version: '1.0.0' }, repository: { name: 'fixture/main', head: main.sha('merge'), since: null } });
    expect(manifest.rules.maxChangeRecords).toBe(10);
    expect(text).not.toContain(main.path.replaceAll('\\', '\\\\'));
    expect(text).not.toContain(tmpdir().replaceAll('\\', '\\\\'));
    expect(text).not.toMatch(/committedAt|"time"|generatedAt/);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(manifest)));
  });

  it('lists exactly the nine design-case commits of docs/evaluation/cases by default', () => {
    const casesDir = join(import.meta.dirname, '..', 'docs', 'evaluation', 'cases');
    const commits = readdirSync(casesDir)
      .filter((f) => /^case-\d+\.yaml$/.test(f))
      .map((f) => (load(readFileSync(join(casesDir, f), 'utf8')) as { source_change: { commit: string } }).source_change.commit);
    expect([...DESIGN_CASE_COMMITS].sort()).toEqual([...commits].sort());
    expect(DESIGN_CASE_COMMITS).toHaveLength(9);
  });
});
