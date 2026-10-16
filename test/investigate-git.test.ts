import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInvestigateCli } from '../src/cli/investigate.js';
import { openDatabase } from '../src/db/database.js';
import { CommitNotFoundError, diffCommits, InvalidCommitShaError, isAncestor } from '../src/git/git.js';
import { changedPathsOf, EmptyChangeSetError, resolveCommitRange, UnsupportedCommitRangeError } from '../src/investigation/change-set.js';
import { investigateChange, type InvestigationReport } from '../src/investigation/investigate.js';
import { EmbeddingProviderUnavailableError } from '../src/semantic/provider.js';
import { FakeEmbeddingProvider } from './fake-embedding-provider.js';
import { FixtureRepo } from './git-fixture.js';

// Running Git CLI commands and diffs spawns many Git processes; the 5 s default is too tight when the suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

// Git-native change input: the changed paths come from the diff of two commits, and the change is
// investigated in the base snapshot.

const VOCABULARY = ['billing', 'ledger', 'refund', 'invoice', 'money', 'journal', 'fees'];
const BASE_FILES: Record<string, string> = {
  'src/billing.ts': `import { post } from './ledger';\nimport type { Money } from "./money";\nexport const billing = post;\n`,
  'src/ledger.ts': `// The ledger posts refund and billing entries.\nexport const post = 1;\nexport const reverse = -1;\n`,
  'src/money.ts': `export type Money = number;\n`,
  'src/invoice.ts': `import {\n  billing,\n} from './billing';\nexport const invoice = billing;\n`,
  'src/billing.test.ts': `import { billing } from './billing.js';\nexport const check = billing;\n`,
  'docs/refunds.md': `A refund is posted to the billing ledger.\n`,
  'docs/other.md': `Nothing to do with it.\n`,
};

let fixture: FixtureRepo;
let dir: string;
let base: string;

beforeEach(() => {
  fixture = new FixtureRepo();
  dir = mkdtempSync(join(tmpdir(), 'tracebound-git-cli-'));
  base = fixture.commit(BASE_FILES, { message: 'base' });
});

afterEach(() => {
  fixture.remove();
  rmSync(dir, { recursive: true, force: true });
});

const modify = () => fixture.commit({ 'src/billing.ts': `${BASE_FILES['src/billing.ts']}export const refundBilling = post;\n` }, { message: 'modify' });
const addAndDelete = () => fixture.commit({ 'src/fees.ts': `export const fees = 2;\n` }, { remove: ['docs/other.md'], message: 'add and delete' });
const rename = () => {
  fixture.git('mv', 'src/ledger.ts', 'src/journal.ts');
  return fixture.commit({}, { message: 'rename' });
};

describe('diffCommits and resolveCommitRange', () => {
  it('reports a modification', async () => {
    const head = modify();
    expect(await diffCommits(fixture.path, base, head)).toEqual([{ status: 'modified', path: 'src/billing.ts', previousPath: null, similarity: null }]);
  });

  it('reports additions and deletions', async () => {
    const head = addAndDelete();
    expect(await diffCommits(fixture.path, base, head)).toEqual([
      { status: 'deleted', path: 'docs/other.md', previousPath: null, similarity: null },
      { status: 'added', path: 'src/fees.ts', previousPath: null, similarity: null },
    ]);
  });

  it('detects a rename and derives the old path (in the base) before the new one', async () => {
    const head = rename();
    const range = await resolveCommitRange(fixture.path, base, head);
    expect(range.changes).toEqual([{ status: 'renamed', path: 'src/journal.ts', previousPath: 'src/ledger.ts', similarity: 100 }]);
    expect(changedPathsOf(range)).toEqual(['src/ledger.ts', 'src/journal.ts']);
  });

  it('compares the whole range when the head is several commits ahead', async () => {
    modify();
    const head = addAndDelete();
    const range = await resolveCommitRange(fixture.path, base.toUpperCase(), head);
    expect(range.base).toBe(base);
    expect(changedPathsOf(range)).toEqual(['docs/other.md', 'src/billing.ts', 'src/fees.ts']);
  });

  it('rejects refs, abbreviations and unknown commits instead of resolving them', async () => {
    const head = modify();
    await expect(resolveCommitRange(fixture.path, 'HEAD~1', head)).rejects.toThrow(InvalidCommitShaError);
    await expect(resolveCommitRange(fixture.path, base, 'HEAD')).rejects.toThrow(InvalidCommitShaError);
    await expect(resolveCommitRange(fixture.path, base.slice(0, 12), head)).rejects.toThrow(InvalidCommitShaError);
    await expect(resolveCommitRange(fixture.path, base, '--output=x')).rejects.toThrow(InvalidCommitShaError);
    await expect(resolveCommitRange(fixture.path, base, 'f'.repeat(40))).rejects.toThrow(CommitNotFoundError);
    // A blob id is a valid object id but not a commit.
    await expect(resolveCommitRange(fixture.path, base, fixture.hashObject('not a commit\n'))).rejects.toThrow(CommitNotFoundError);
  });

  it('supports only a base that the head descends from', async () => {
    const head = modify();
    await expect(resolveCommitRange(fixture.path, base, base)).rejects.toThrow(UnsupportedCommitRangeError);
    await expect(resolveCommitRange(fixture.path, head, base)).rejects.toThrow(/is not an ancestor of the head commit/);
    fixture.git('checkout', '--quiet', '--orphan', 'unrelated');
    const unrelated = fixture.commit({ 'x.ts': 'export const x = 1;\n' }, { message: 'unrelated root' });
    await expect(resolveCommitRange(fixture.path, base, unrelated)).rejects.toThrow(UnsupportedCommitRangeError);
  });

  it('rejects an empty change set', async () => {
    const empty = fixture.commit({}, { message: 'no file changes' });
    await expect(resolveCommitRange(fixture.path, base, empty)).rejects.toThrow(EmptyChangeSetError);
  });
});

describe('isAncestor and diffCommits validate their commit arguments', () => {
  const invalid = (head: string): [string, string][] => [
    ['HEAD', head],
    [base, 'HEAD'],
    ['HEAD~1', head],
    [base, 'HEAD~1'],
    [base.slice(0, 12), head],
    [base, head.slice(0, 7)],
  ];

  it('rejects revision references and abbreviated ids with InvalidCommitShaError, in both arguments', async () => {
    const head = modify();
    for (const [from, to] of invalid(head)) {
      await expect(isAncestor(fixture.path, from, to)).rejects.toThrow(InvalidCommitShaError);
      await expect(diffCommits(fixture.path, from, to)).rejects.toThrow(InvalidCommitShaError);
    }
  });

  it('rejects option-like input before it reaches Git, so nothing is written', async () => {
    const head = modify();
    const target = join(dir, 'written-by-git.txt');
    const option = `--output=${target}`;
    await expect(diffCommits(fixture.path, base, option)).rejects.toThrow(InvalidCommitShaError);
    await expect(diffCommits(fixture.path, option, head)).rejects.toThrow(InvalidCommitShaError);
    await expect(isAncestor(fixture.path, option, head)).rejects.toThrow(InvalidCommitShaError);
    expect(existsSync(target)).toBe(false);
  });

  it('accepts uppercase full ids, equivalent to lowercase', async () => {
    const head = modify();
    expect(await isAncestor(fixture.path, base.toUpperCase(), head.toUpperCase())).toBe(true);
    expect(await isAncestor(fixture.path, head, base)).toBe(false);
    expect(await diffCommits(fixture.path, base.toUpperCase(), head.toUpperCase())).toEqual(await diffCommits(fixture.path, base, head));
  });
});

describe('npm run investigate with --base and --head', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { createEmbedder: async () => new FakeEmbeddingProvider(VOCABULARY), stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) } };
  };
  const rangeArgs = (head: string, ...extra: string[]) => ['--db', join(dir, 'tb.sqlite'), '--repo', fixture.path, '--base', base, '--head', head, '--description', 'fix refund billing', ...extra];
  const runJson = async (head: string): Promise<{ code: number; report: InvestigationReport; err: string }> => {
    const run = capture();
    const code = await runInvestigateCli(rangeArgs(head, '--format', 'json'), run.deps);
    return { code, report: code === 0 ? (JSON.parse(run.out.join('')) as InvestigationReport) : (undefined as unknown as InvestigationReport), err: run.err.join('') };
  };

  it('investigates a modification in the base snapshot with the derived changed paths, reasoning disabled', async () => {
    const head = modify();
    const { code, report, err } = await runJson(head);
    expect(code).toBe(0);
    expect(err).toMatch(new RegExp(`Derived 1 file change from ${base}\\.\\.${head}[\\s\\S]*Ingested snapshot 1 of ${base}`));
    expect(report.snapshot.commitSha).toBe(base);
    expect(report.commitRange).toEqual({ base, head, changes: [{ status: 'modified', path: 'src/billing.ts', previousPath: null, similarity: null }] });
    expect(report.change.changedPaths).toEqual(['src/billing.ts']);
    expect(report.changedFiles).toEqual([expect.objectContaining({ path: 'src/billing.ts', change: 'modified', inSnapshot: true })]);
    expect(report.reasoning).toEqual({ status: 'not_requested' });
    expect(report.candidates.length).toBeGreaterThan(0);
    expect(report.candidates.some((c) => c.path === 'src/billing.ts')).toBe(false);
    expect(report.limitations.some((l) => l.includes(`between commits ${base} (base) and ${head} (head)`))).toBe(true);

    // Same evidence, ids included, as the library run on the same base snapshot and changed paths.
    const db = openDatabase(join(dir, 'tb.sqlite'));
    try {
      const direct = await investigateChange(db, report.snapshot.id, new FakeEmbeddingProvider(VOCABULARY), { description: 'fix refund billing', changedPaths: ['src/billing.ts'] });
      expect(report.candidates.map((c) => c.evidence)).toEqual(direct.candidates.map((c) => c.evidence));
      expect(report.candidates.map((c) => c.summary)).toEqual(direct.candidates.map((c) => c.summary));
    } finally {
      db.close();
    }
  });

  it('keeps an added file that is missing from the base snapshot and says why; a deleted file is in the base', async () => {
    const head = addAndDelete();
    const { code, report } = await runJson(head);
    expect(code).toBe(0);
    expect(report.changedFiles.map((f) => [f.path, f.change, f.inSnapshot])).toEqual([
      ['docs/other.md', 'deleted', true],
      ['src/fees.ts', 'added', false],
    ]);
    expect(report.limitations).toContain(`The changed path src/fees.ts is not in snapshot ${report.snapshot.id} (added by the change, so it does not exist before it), so no import relationship to it can be found.`);
  });

  it('reports a rename as the old path in the base and the new path missing from it', async () => {
    const head = rename();
    const { code, report } = await runJson(head);
    expect(code).toBe(0);
    expect(report.change.changedPaths).toEqual(['src/ledger.ts', 'src/journal.ts']);
    expect(report.changedFiles.map((f) => [f.path, f.change, f.inSnapshot])).toEqual([
      ['src/ledger.ts', 'renamed to src/journal.ts (100% similar)', true],
      ['src/journal.ts', 'renamed from src/ledger.ts (100% similar)', false],
    ]);
    expect(report.limitations.some((l) => l.includes('src/journal.ts is not in snapshot') && l.includes('the new name of a file renamed from src/ledger.ts'))).toBe(true);
  });

  it('renders the change status and the commit range in Markdown', async () => {
    const head = addAndDelete();
    const run = capture();
    expect(await runInvestigateCli(rangeArgs(head), run.deps)).toBe(0);
    const md = run.out.join('');
    expect(md).toContain(`The change is the difference from base \`${base}\` to head \`${head}\` (2 file changes). It is investigated in the base snapshot`);
    expect(md).toMatch(/\| Path \| Change \| In snapshot \| Own fused rank \| Note \|/);
    expect(md).toMatch(/\| `src\/fees\.ts` \| added \| \*\*no\*\* \|/);
  });

  it('fails explicitly, before ingesting anything, for an invalid, unknown, reversed or empty range', async () => {
    const head = modify();
    const empty = fixture.commit({}, { message: 'empty' });
    const cases: [string[], RegExp][] = [
      [['--base', 'HEAD~1', '--head', head], /InvalidCommitShaError/],
      [['--base', base, '--head', 'a'.repeat(40)], /CommitNotFoundError/],
      [['--base', head, '--head', base], /UnsupportedCommitRangeError: .*is not an ancestor/],
      [['--base', base, '--head', base], /UnsupportedCommitRangeError: The base and head commits are the same/],
      [['--base', head, '--head', empty], /EmptyChangeSetError/],
    ];
    for (const [range, pattern] of cases) {
      const run = capture();
      const code = await runInvestigateCli(['--db', join(dir, 'tb.sqlite'), '--repo', fixture.path, ...range, '--description', 'x'], run.deps);
      expect(code).toBe(1);
      expect(run.err.join('')).toMatch(pattern);
      expect(run.out).toEqual([]);
    }
    const db = openDatabase(join(dir, 'tb.sqlite'));
    try {
      expect((db.prepare('SELECT count(*) AS n FROM repository_snapshot').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('refuses conflicting arguments with a usage error', async () => {
    const head = modify();
    const db = ['--db', join(dir, 'tb.sqlite'), '--description', 'x'];
    const cases: [string[], RegExp][] = [
      [[...db, '--repo', fixture.path, '--base', base], /--base and --head go together/],
      [[...db, '--repo', fixture.path, '--head', head], /--base and --head go together/],
      [[...db, '--base', base, '--head', head], /--repo is required with --base and --head/],
      [[...db, '--repo', fixture.path, '--base', base, '--head', head, '--commit', base], /Give exactly one of/],
      [[...db, '--snapshot', '1', '--base', base, '--head', head], /Give exactly one of/],
      [[...db, '--repo', fixture.path, '--base', base, '--head', head, '--changed', 'src/billing.ts'], /--changed cannot be used with --base and --head/],
      [[...db, '--snapshot', '1', '--repo', fixture.path], /--repo cannot be used with --snapshot/],
      [[...db, '--repo', fixture.path], /Give exactly one of/],
      [[...db, '--commit', base], /--repo is required with --commit/],
    ];
    for (const [args, pattern] of cases) {
      const run = capture();
      expect(await runInvestigateCli(args, run.deps)).toBe(2);
      expect(run.err.join('')).toMatch(pattern);
    }
  });

  it('keeps the --repo/--commit and --snapshot workflows with explicit --changed working', async () => {
    const run = capture();
    expect(await runInvestigateCli(['--db', join(dir, 'tb.sqlite'), '--repo', fixture.path, '--commit', base, '--description', 'fix refund billing', '--changed', 'src/billing.ts', '--format', 'json'], run.deps)).toBe(0);
    const report = JSON.parse(run.out.join('')) as InvestigationReport;
    expect(report.commitRange).toBeNull();
    expect(report.changedFiles).toEqual([expect.objectContaining({ path: 'src/billing.ts', change: null, inSnapshot: true })]);

    const again = capture();
    expect(await runInvestigateCli(['--db', join(dir, 'tb.sqlite'), '--snapshot', String(report.snapshot.id), '--description', 'fix refund billing', '--changed', 'src/billing.ts', '--format', 'json'], again.deps)).toBe(0);
    expect((JSON.parse(again.out.join('')) as InvestigationReport).candidates.map((c) => c.evidence)).toEqual(report.candidates.map((c) => c.evidence));
  });
});

describe('npm run investigate report files and hints', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { createEmbedder: async () => new FakeEmbeddingProvider(VOCABULARY), stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) } };
  };
  const rangeArgs = (head: string, ...extra: string[]) => ['--db', join(dir, 'tb.sqlite'), '--repo', fixture.path, '--base', base, '--head', head, '--description', 'fix refund billing', ...extra];

  it('writes the Markdown and the JSON report of one run', async () => {
    const head = modify();
    const md = join(dir, 'report.md');
    const json = join(dir, 'report.json');
    const run = capture();
    expect(await runInvestigateCli(rangeArgs(head, '--out', md, '--json-out', json), run.deps)).toBe(0);
    expect(run.out).toEqual([]);
    expect(run.err.join('')).toContain(`JSON report written to ${json}`);
    const markdown = readFileSync(md, 'utf8');
    const report = JSON.parse(readFileSync(json, 'utf8')) as InvestigationReport;
    expect(markdown).toMatch(/^# Change investigation/);
    expect(report.candidates.length).toBeGreaterThan(0);
    for (const c of report.candidates) for (const e of c.evidence) expect(markdown).toContain(`\`${e.id}\``);

    // The same report as --format json on the same snapshot.
    const again = capture();
    expect(await runInvestigateCli(rangeArgs(head, '--format', 'json'), again.deps)).toBe(0);
    expect(again.out.join('')).toBe(readFileSync(json, 'utf8'));
  });

  it('refuses unusable report paths before opening the database', async () => {
    const head = modify();
    const cases: [string[], RegExp][] = [
      [['--out', join(dir, 'r.json'), '--json-out', join(dir, 'r.json')], /--out and --json-out must name different files/],
      [['--out', join(dir, 'missing', 'r.md')], /--out: the directory .*missing does not exist/],
      [['--json-out', join(dir, 'missing', 'r.json')], /--json-out: the directory .*missing does not exist/],
    ];
    for (const [extra, pattern] of cases) {
      const run = capture();
      expect(await runInvestigateCli(rangeArgs(head, ...extra), run.deps)).toBe(2);
      expect(run.err.join('')).toMatch(pattern);
    }
    expect(existsSync(join(dir, 'tb.sqlite'))).toBe(false);
  });

  it('adds a hint for a ref given as a commit and for an unreachable embedding server', async () => {
    const head = modify();
    const ref = capture();
    expect(await runInvestigateCli(['--db', join(dir, 'tb.sqlite'), '--repo', fixture.path, '--base', 'HEAD~1', '--head', head, '--description', 'x'], ref.deps)).toBe(1);
    expect(ref.err.join('')).toMatch(/error: InvalidCommitShaError[\s\S]*\nhint: name commits by their full id: `git -C <repo> rev-parse <ref>`/);

    const down = capture();
    const unreachable = async () => {
      throw new EmbeddingProviderUnavailableError('Cannot reach Ollama at http://127.0.0.1:11434/api/tags');
    };
    expect(await runInvestigateCli(rangeArgs(head), { ...down.deps, createEmbedder: unreachable })).toBe(1);
    expect(down.err.join('')).toMatch(/error: EmbeddingProviderUnavailableError[\s\S]*\nhint: .*`ollama pull nomic-embed-text:v1\.5`/);

    const other = capture();
    expect(await runInvestigateCli(['--db', join(dir, 'tb.sqlite'), '--snapshot', '99', '--description', 'x'], other.deps)).toBe(1);
    expect(other.err.join('')).not.toContain('hint:');
  });
});

describe('investigateChange with a commit range', () => {
  it('refuses a snapshot that is not the base commit, or changed paths not derived from the range', async () => {
    const head = modify();
    const range = await resolveCommitRange(fixture.path, base, head);
    const run = { out: [] as string[], err: [] as string[] };
    expect(
      await runInvestigateCli(['--db', join(dir, 'tb.sqlite'), '--repo', fixture.path, '--commit', head, '--description', 'x'], {
        createEmbedder: async () => new FakeEmbeddingProvider(VOCABULARY),
        stdout: (t) => run.out.push(t),
        stderr: (t) => run.err.push(t),
      }),
    ).toBe(0);
    const db = openDatabase(join(dir, 'tb.sqlite'));
    try {
      const embedder = new FakeEmbeddingProvider(VOCABULARY);
      // Snapshot 1 is the head commit's, not the base's.
      await expect(investigateChange(db, 1, embedder, { description: 'x', changedPaths: changedPathsOf(range) }, { commitRange: range })).rejects.toThrow(/not of the base commit/);
    } finally {
      db.close();
    }
    const baseRun = capture2();
    expect(await runInvestigateCli(['--db', join(dir, 'tb.sqlite'), '--repo', fixture.path, '--commit', base, '--description', 'x'], baseRun.deps)).toBe(0);
    const db2 = openDatabase(join(dir, 'tb.sqlite'));
    try {
      await expect(investigateChange(db2, 2, new FakeEmbeddingProvider(VOCABULARY), { description: 'x', changedPaths: ['src/money.ts'] }, { commitRange: range })).rejects.toThrow(/exactly the paths derived/);
    } finally {
      db2.close();
    }
  });
});

function capture2() {
  return { deps: { createEmbedder: async () => new FakeEmbeddingProvider(VOCABULARY), stdout: () => undefined, stderr: () => undefined } };
}
