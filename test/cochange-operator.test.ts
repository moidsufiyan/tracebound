import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from '../src/evaluation/m9/canonical.js';
import { acquireWorkLock, LOCK_FILE, releaseWorkLock } from '../src/evaluation/cochange/lock.js';
import { EXIT_CODES, runOperator, USAGE, type OperatorDependencies } from '../src/evaluation/cochange/operator.js';
import { WORK_FILES, type PreflightDependencies, type Registration } from '../src/evaluation/cochange/preflight.js';
import { REPORT_FILE, RESULTS_FILE } from '../src/evaluation/cochange/report.js';
import { DESIGN_CASE_COMMITS, PROTOCOL, SELECTION_RULES, type CochangeManifest } from '../src/evaluation/cochange/selector.js';
import { FakeEmbeddingProvider } from './fake-embedding-provider.js';
import { FixtureRepo } from './git-fixture.js';

// The lifecycle test prepares and evaluates 30 real snapshots (several runs); the 5 s default is far too tight.
vi.setConfig({ testTimeout: 300_000 });

const DIGEST = '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f';
const MODEL_ID = 'ollama:nomic-embed-text:v1.5@0a109f422b47';
const OLLAMA = 'http://ollama.test:11434';
const SOURCE = 'export const a = 1;\n';
const compiled = (text: string) => `// compiled\n${text}`;

let got: FixtureRepo;
let commits: string[];
let scratch: string;
const cleanups: (() => void)[] = [];

beforeAll(() => {
  got = new FixtureRepo();
  const files = (i: number) => ({
    'src/a.ts': `import { b } from './b.js';\nexport const a = b + ${i};\n`,
    'src/b.ts': `export const b = ${i};\n`,
    'test/a.test.ts': `import { a } from '../src/a.js';\nexport const check = a === ${i};\n`,
    'docs/guide.md': `# Guide ${i}\n`,
  });
  commits = [got.commit(files(0), { message: 'root' })];
  for (let i = 1; i <= 31; i += 1) commits.push(got.commit(files(i), { message: `change ${i}` }));
  scratch = mkdtempSync(join(tmpdir(), 'tracebound-operator-test-'));
}, 120_000);

afterAll(() => {
  got.remove();
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function manifestValue(): CochangeManifest {
  return {
    schema: 'tracebound.cochange.manifest',
    schemaVersion: '1.0.0',
    protocol: PROTOCOL,
    repository: { name: 'owner/repo', head: commits[31]!, since: null },
    rules: SELECTION_RULES,
    exclusions: { designCaseCommits: [...DESIGN_CASE_COMMITS].sort() },
    counts: { reachable: 32, eligible: 30, selected: 30, rejected: { root: 1, merge: 0, design_case: 0, too_many_changes: 0, no_changes: 0, no_source_input: 1, no_target: 0 } },
    commits: commits.slice(1, 31).map((sha, i) => ({
      sha,
      base: commits[i]!,
      subject: `change ${i + 1}`,
      eligibleIndex: i,
      changes: [
        { status: 'modified', path: 'src/a.ts', previousPath: null, similarity: null, basePath: 'src/a.ts', baseClass: 'source' },
        { status: 'modified', path: 'test/a.test.ts', previousPath: null, similarity: null, basePath: 'test/a.test.ts', baseClass: 'test' },
      ],
      inputs: ['src/a.ts'],
      targets: [{ path: 'test/a.test.ts', kind: 'test', status: 'modified' }],
    })),
  };
}

const fakeCompile: NonNullable<PreflightDependencies['compile']> = async (root, outDir) => {
  writeFileSync(join(outDir, 'a.js'), compiled(readFileSync(join(root, 'src', 'a.ts'), 'utf8')));
};

/** A stand-in Ollama server: /api/tags reports `digest`, /api/embed answers with a fake model's vectors. */
class FakeOllama {
  readonly requests: string[] = [];
  embedCalls = 0;
  digest = DIGEST;
  reachable = true;
  #failAt: number | null = null;
  readonly #model = new FakeEmbeddingProvider(['import', 'export', 'const', 'guide', 'check', 'change'], { modelId: MODEL_ID });

  /** The next `succeeding` embed calls succeed, the one after answers 503, later ones succeed again. */
  outageAfter(succeeding: number): void {
    this.#failAt = this.embedCalls + succeeding + 1;
  }

  readonly fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    this.requests.push(address);
    if (!this.reachable) throw new TypeError('fetch failed');
    if (address === `${OLLAMA}/api/tags`) {
      return new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:v1.5', digest: this.digest, details: { embedding_length: this.#model.dimensions } }] }));
    }
    if (address === `${OLLAMA}/api/embed`) {
      this.embedCalls += 1;
      if (this.embedCalls === this.#failAt) return new Response('unavailable', { status: 503 });
      const { input } = JSON.parse(String(init!.body)) as { input: string[] };
      return new Response(JSON.stringify({ embeddings: (await this.#model.embed(input)).map((v) => [...v]) }));
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

interface Setup {
  tb: FixtureRepo;
  work: string;
  results: string;
  registration: Registration;
  ollama: FakeOllama;
}

let counter = 0;
function setup(): Setup {
  const bytes = Buffer.from(canonicalJson(manifestValue()), 'utf8');
  const tb = new FixtureRepo();
  cleanups.push(() => tb.remove());
  tb.commit({
    '.gitignore': 'node_modules/\ndist/\n',
    'package.json': '{"name":"fixture"}\n',
    'package-lock.json': `${JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/typescript': { version: '7.0.2' } } })}\n`,
    'tsconfig.json': '{}\n',
    'tsconfig.build.json': '{}\n',
    'src/a.ts': SOURCE,
    'docs/evaluation/cochange/manifest.json': bytes,
  });
  tb.write({ 'node_modules/typescript/package.json': '{"version":"7.0.2"}\n', 'dist/a.js': compiled(SOURCE) });
  counter += 1;
  return {
    tb,
    work: join(scratch, `work-${counter}`),
    results: join(tb.path, 'docs', 'evaluation', 'cochange'),
    registration: { manifestSha256: sha256Hex(bytes), repositoryName: 'owner/repo', head: commits[31]!, since: null, embeddingModel: 'nomic-embed-text:v1.5' },
    ollama: new FakeOllama(),
  };
}

const args = (s: Setup, command: 'prepare' | 'evaluate' | 'publish') =>
  command === 'publish' ? [command, '--repo', got.path, '--work', s.work, '--out', s.results] : [command, '--repo', got.path, '--work', s.work, '--ollama', OLLAMA];

async function operate(s: Setup, argv: string[], deps: OperatorDependencies = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOperator(argv, { traceboundRoot: s.tb.path, cwd: scratch, out: (l) => out.push(l), err: (l) => err.push(l) }, {
    compile: fakeCompile,
    registration: s.registration,
    fetch: s.ollama.fetch,
    ...deps,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const journalRecords = (s: Setup, file: string) => readFileSync(join(s.work, file), 'utf8').trimEnd().split('\n').length - 1;

describe('arguments and configuration', () => {
  it('prints the usage for --help and exits 0', async () => {
    const s = setup();
    const result = await operate(s, ['--help']);
    expect(result).toMatchObject({ code: EXIT_CODES.done, out: USAGE });
    expect(s.ollama.requests).toEqual([]);
  });

  it.each([
    ['no command', []],
    ['an unknown command', ['run-all']],
    ['a missing option', ['prepare', '--repo', '.', '--work', 'w']],
    ['an option of another command', ['prepare', '--repo', '.', '--work', 'w', '--ollama', OLLAMA, '--out', 'x']],
    ['a repeated option', ['publish', '--repo', '.', '--work', 'w', '--work', 'v', '--out', 'x']],
    ['an option without a value', ['evaluate', '--repo', '.', '--work', '--ollama', OLLAMA]],
    ['a positional argument', ['evaluate', 'extra', '--repo', '.', '--work', 'w', '--ollama', OLLAMA]],
  ])('refuses %s with exit 2, contacting nothing', async (_label, argv) => {
    const s = setup();
    const result = await operate(s, argv);
    expect(result.code).toBe(EXIT_CODES.usage);
    expect(result.err).toContain('--help');
    expect(s.ollama.requests).toEqual([]);
  });

  it('refuses unsafe or invalid paths and endpoints before creating anything', async () => {
    const s = setup();
    const inside = (root: string) => join(root, 'work');
    const cases: [string, string[]][] = [
      ['a work directory inside the dataset clone', ['prepare', '--repo', got.path, '--work', inside(got.path), '--ollama', OLLAMA]],
      ['a work directory inside the Tracebound checkout', ['prepare', '--repo', got.path, '--work', inside(s.tb.path), '--ollama', OLLAMA]],
      ['a work directory containing the dataset clone', ['prepare', '--repo', got.path, '--work', tmpdir(), '--ollama', OLLAMA]],
      ['a work directory on a network path', ['prepare', '--repo', got.path, '--work', '\\\\server\\share\\work', '--ollama', OLLAMA]],
      ['a missing dataset clone', ['prepare', '--repo', join(scratch, 'no-clone'), '--work', s.work, '--ollama', OLLAMA]],
      ['a work directory that is a file', ['evaluate', '--repo', got.path, '--work', join(s.tb.path, 'package.json'), '--ollama', OLLAMA]],
      ['an endpoint that is not an http URL', ['prepare', '--repo', got.path, '--work', s.work, '--ollama', 'ollama.test:11434']],
    ];
    for (const [label, argv] of cases) {
      const result = await operate(s, argv);
      expect(result.code, label).toBe(EXIT_CODES.usage);
    }
    expect(existsSync(s.work)).toBe(false);
    expect(existsSync(inside(got.path))).toBe(false);
    expect(existsSync(inside(s.tb.path))).toBe(false);
    expect(s.ollama.requests).toEqual([]);
  });
});

describe('the embedding pin', () => {
  it('fails closed without a pin: exit 2, Ollama never contacted, nothing created', async () => {
    const s = setup();
    for (const command of ['prepare', 'evaluate'] as const) {
      const result = await operate(s, args(s, command), { pin: null });
      expect(result.code).toBe(EXIT_CODES.usage);
      expect(result.err).toContain('No embedding pin is configured');
    }
    expect(s.ollama.requests).toEqual([]);
    expect(existsSync(s.work)).toBe(false);
  });

  it('refuses another installed build, even one with the same model id, before any work', async () => {
    const s = setup();
    s.ollama.digest = `${DIGEST.slice(0, 12)}${'0'.repeat(52)}`;
    for (const command of ['prepare', 'evaluate'] as const) {
      const result = await operate(s, args(s, command));
      expect(result.code).toBe(EXIT_CODES.refused);
      expect(result.err).toContain(`not the pinned ${MODEL_ID} (weights ${DIGEST})`);
    }
    expect(s.ollama.embedCalls).toBe(0);
    expect(existsSync(s.work)).toBe(false);
  });

  it('reports an unreachable provider as a refusal with nothing started', async () => {
    const s = setup();
    s.ollama.reachable = false;
    const result = await operate(s, args(s, 'prepare'));
    expect(result.code).toBe(EXIT_CODES.refused);
    expect(result.err).toContain('Cannot reach Ollama');
    expect(existsSync(s.work)).toBe(false);
  });
});

describe('the phase lifecycle', () => {
  it('runs prepare, evaluate and publish in order, resumes after interruptions and refuses out-of-order steps', async () => {
    const s = setup();
    const results = () => readdirSync(s.results).sort();

    // Nothing can run before preparation.
    expect((await operate(s, args(s, 'evaluate'))).code).toBe(EXIT_CODES.refused);
    expect((await operate(s, args(s, 'publish'))).code).toBe(EXIT_CODES.refused);
    expect(existsSync(s.work)).toBe(false);

    // Preparation stops at a provider outage, with the base that met it recorded as failed.
    s.ollama.outageAfter(3);
    const stopped = await operate(s, args(s, 'prepare'));
    expect(stopped.code).toBe(EXIT_CODES.stopped);
    expect(stopped.err).toContain('run prepare again');
    const recordedFirst = journalRecords(s, WORK_FILES.preparationJournal);
    expect(recordedFirst).toBeGreaterThan(0);
    expect(recordedFirst).toBeLessThan(30);
    expect(existsSync(join(s.work, WORK_FILES.frozenDatabase))).toBe(false);
    expect((await operate(s, args(s, 'evaluate'))).err).toContain('preparation-incomplete');

    // Resuming records only the remaining bases; the recorded failure is kept, not retried.
    const resumed = await operate(s, args(s, 'prepare'));
    expect(resumed.code).toBe(EXIT_CODES.done);
    expect(resumed.out).toContain(`30 bases, 29 succeeded, 1 failed; ${30 - recordedFirst} recorded by this run`);
    expect(resumed.out).toContain('Inconclusive');
    expect(existsSync(join(s.work, WORK_FILES.freezeIdentity))).toBe(true);

    // A finished preparation is never run again.
    const again = await operate(s, args(s, 'prepare'));
    expect(again.code).toBe(EXIT_CODES.refused);
    expect(again.err).toContain('already finished');

    // Publication needs a complete evaluation journal.
    const early = await operate(s, args(s, 'publish'));
    expect(early.code).toBe(EXIT_CODES.refused);
    expect(early.err).toContain('evaluation-journal-missing');

    // Evaluation stops at an outage too, and publication still refuses the incomplete journal.
    s.ollama.outageAfter(4);
    expect((await operate(s, args(s, 'evaluate'))).code).toBe(EXIT_CODES.stopped);
    const evaluatedFirst = journalRecords(s, WORK_FILES.evaluationJournal);
    expect(evaluatedFirst).toBeLessThan(30);
    const incomplete = await operate(s, args(s, 'publish'));
    expect(incomplete.code).toBe(EXIT_CODES.refused);
    expect(incomplete.err).toContain('evaluation-incomplete');
    expect(results()).toEqual(['manifest.json']);

    // Resumed evaluation completes; a rerun records nothing.
    const evaluated = await operate(s, args(s, 'evaluate'));
    expect(evaluated.code).toBe(EXIT_CODES.done);
    expect(evaluated.out).toContain(`30 commits recorded, ${30 - evaluatedFirst} by this run`);
    expect(evaluated.out).toContain('Inconclusive');
    expect((await operate(s, args(s, 'evaluate'))).out).toContain('30 commits recorded, 0 by this run');

    // A complete but Inconclusive evaluation is published.
    const published = await operate(s, args(s, 'publish'));
    expect(published.code).toBe(EXIT_CODES.done);
    expect(published.out).toContain('outcome inconclusive, results primary-incomplete');
    expect(results()).toEqual(['manifest.json', REPORT_FILE, RESULTS_FILE]);
    const report = readFileSync(join(s.results, REPORT_FILE));

    // Publishing again finds identical files; a conflicting file is refused and kept.
    expect((await operate(s, args(s, 'publish'))).out).toContain(`${REPORT_FILE}: unchanged`);
    writeFileSync(join(s.results, REPORT_FILE), 'edited by hand\n');
    const conflict = await operate(s, args(s, 'publish'));
    expect(conflict.code).toBe(EXIT_CODES.refused);
    expect(conflict.err).toContain('artifact-conflict');
    expect(readFileSync(join(s.results, REPORT_FILE), 'utf8')).toBe('edited by hand\n');

    // Partial publication: with the report missing, a rerun keeps results.json and writes the report.
    rmSync(join(s.results, REPORT_FILE));
    const completed = await operate(s, args(s, 'publish'));
    expect(completed.out).toContain(`${RESULTS_FILE}: unchanged`);
    expect(completed.out).toContain(`${REPORT_FILE}: written`);
    expect(readFileSync(join(s.results, REPORT_FILE)).equals(report)).toBe(true);

    // A later source commit is another evaluation identity: publication refuses it.
    s.tb.commit({ 'package.json': '{"name":"fixture","version":"2"}\n' });
    const moved = await operate(s, args(s, 'publish'));
    expect(moved.code).toBe(EXIT_CODES.refused);
    expect(moved.err).toMatch(/the evaluation ran at [0-9a-f]{40}/);
    expect(moved.err).toContain('new work directory');

    // And so does evaluation: the journals were written for the earlier identity.
    const reevaluated = await operate(s, args(s, 'evaluate'));
    expect(reevaluated.code).toBe(EXIT_CODES.refused);
    expect(reevaluated.err).toContain('header-mismatch');
  });

  it('refuses publication from another build or Node version than the evaluation ran with', async () => {
    const s = setup();
    expect((await operate(s, args(s, 'prepare'))).code).toBe(EXIT_CODES.done);
    expect((await operate(s, args(s, 'evaluate'))).code).toBe(EXIT_CODES.done);
    const node = await operate(s, args(s, 'publish'), { nodeVersion: 'v24.0.0' });
    expect(node.code).toBe(EXIT_CODES.refused);
    expect(node.err).toContain('Node v24.0.0 is running');
    const build = await operate(s, args(s, 'publish'), { compile: async (root, outDir) => writeFileSync(join(outDir, 'a.js'), `// other compiler\n${readFileSync(join(root, 'src', 'a.ts'), 'utf8')}`) });
    expect(build.code).toBe(EXIT_CODES.refused);
    expect(build.err).toContain('build-stale');
    expect(readdirSync(s.results)).toEqual(['manifest.json']);
    expect((await operate(s, args(s, 'publish'))).code).toBe(EXIT_CODES.done);
  });

  it('reports a held or stale lock with exit 4 and leaves it in place', async () => {
    const s = setup();
    mkdirSync(s.work);
    const held = acquireWorkLock(s.work, 'another run');
    if (held.status !== 'acquired') throw new Error('not acquired');
    const lockBytes = readFileSync(join(s.work, LOCK_FILE));
    for (const command of ['prepare', 'evaluate', 'publish'] as const) {
      const result = await operate(s, args(s, command));
      expect(result.code, command).toBe(EXIT_CODES.locked);
      expect(result.err, command).toContain('"another run"');
      expect(result.err, command).toContain('delete run.lock by hand');
    }
    expect(readFileSync(join(s.work, LOCK_FILE)).equals(lockBytes)).toBe(true);
    expect(readdirSync(s.work)).toEqual([LOCK_FILE]);
    releaseWorkLock(held.lock);
  });
});
