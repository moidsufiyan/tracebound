import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson, digestOf, sha256Hex } from '../src/evaluation/m9/canonical.js';
import { createJournal, validateHeader, type JournalHeader, type PreparationRecord } from '../src/evaluation/cochange/journal.js';
import { buildFreezeIdentity, serializeFreezeIdentity } from '../src/evaluation/cochange/freeze-identity.js';
import { runPreflight, WORK_FILES, type PreflightConfig, type PreflightDependencies, type PreflightResult, type Registration } from '../src/evaluation/cochange/preflight.js';
import { DESIGN_CASE_COMMITS, PROTOCOL, SELECTION_RULES, type CochangeManifest } from '../src/evaluation/cochange/selector.js';
import { FixtureRepo } from './git-fixture.js';

// Every preflight spawns a few dozen Git processes; the 5 s default is too tight when the suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

const MODEL_ID = 'ollama:nomic-embed-text:v1.5@0a109f422b47';
const SOURCE = 'export const a = 1;\n';
const compiled = (text: string) => `// compiled\n${text}`;

let got: FixtureRepo;
let commits: string[];
let scratch: string;
const cleanups: (() => void)[] = [];

beforeAll(() => {
  got = new FixtureRepo();
  got.git('config', 'uploadpack.allowFilter', 'true');
  commits = [got.commit({ 'src/a.ts': '0\n', 'test/a.test.ts': '0\n' }, { message: 'root' })];
  for (let i = 1; i <= 31; i += 1) commits.push(got.commit({ 'src/a.ts': `${i}\n`, 'test/a.test.ts': `${i}\n` }, { message: `change ${i}` }));
  scratch = mkdtempSync(join(tmpdir(), 'tracebound-preflight-test-'));
}, 120_000);

afterAll(() => {
  got.remove();
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** A manifest the selector could have produced for the fixture: 30 eligible commits, all selected. */
function manifestValue(): CochangeManifest {
  return {
    schema: 'tracebound.cochange.manifest',
    schemaVersion: '1.0.0',
    protocol: PROTOCOL,
    repository: { name: 'owner/repo', head: commits[31]!, since: null },
    rules: SELECTION_RULES,
    exclusions: { designCaseCommits: [...DESIGN_CASE_COMMITS].sort() },
    counts: {
      reachable: 32,
      eligible: 30,
      selected: 30,
      rejected: { root: 1, merge: 0, design_case: 0, too_many_changes: 0, no_changes: 0, no_source_input: 1, no_target: 0 },
    },
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

const bytesOf = (manifest: unknown) => Buffer.from(canonicalJson(manifest), 'utf8');
const registrationFor = (bytes: Buffer, overrides: Partial<Registration> = {}): Registration => ({
  manifestSha256: sha256Hex(bytes),
  repositoryName: 'owner/repo',
  head: commits[31]!,
  since: null,
  embeddingModel: 'nomic-embed-text:v1.5',
  ...overrides,
});

/** A Tracebound-like checkout: committed source, configuration and manifest; ignored node_modules and dist. */
function makeTracebound(manifest: Buffer): FixtureRepo {
  const tb = new FixtureRepo();
  cleanups.push(() => tb.remove());
  tb.commit({
    '.gitignore': 'node_modules/\ndist/\nrelease/\n*.local.ts\n',
    'package.json': '{"name":"fixture"}\n',
    'package-lock.json': `${JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/typescript': { version: '7.0.2' } } })}\n`,
    'tsconfig.json': '{}\n',
    'tsconfig.build.json': '{}\n',
    'src/a.ts': SOURCE,
    'scripts/run.mjs': '\n',
    'docs/evaluation/cochange/manifest.json': manifest,
    'README.md': 'fixture\n',
  });
  tb.write({ 'node_modules/typescript/package.json': '{"version":"7.0.2"}\n', 'dist/a.js': compiled(SOURCE) });
  return tb;
}

/** Stands in for tsc: each src/**.ts becomes <outDir>/**.js. */
const fakeCompile: NonNullable<PreflightDependencies['compile']> = async (root, outDir) => {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        const target = join(outDir, relative(join(root, 'src'), full)).replace(/\.ts$/, '.js');
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, compiled(readFileSync(full, 'utf8')));
      }
    }
  };
  walk(join(root, 'src'));
};

interface Setup {
  tb: FixtureRepo;
  bytes: Buffer;
  config: PreflightConfig;
  deps: PreflightDependencies;
  work: string;
}

let counter = 0;
function setup(options: { manifest?: CochangeManifest; registration?: Partial<Registration>; config?: Partial<PreflightConfig> } = {}): Setup {
  const bytes = bytesOf(options.manifest ?? manifestValue());
  const tb = makeTracebound(bytes);
  counter += 1;
  const work = join(scratch, `work-${counter}`);
  return {
    tb,
    bytes,
    work,
    config: { phase: 'preparation', traceboundRoot: tb.path, repositoryPath: got.path, workDirectory: work, ...options.config },
    deps: { compile: fakeCompile, registration: registrationFor(bytes, options.registration) },
  };
}

const run = (s: Setup, config: Partial<PreflightConfig> = {}, deps: Partial<PreflightDependencies> = {}) => runPreflight({ ...s.config, ...config }, { ...s.deps, ...deps });
const codes = (result: PreflightResult) => ('problems' in result ? result.problems.map((p) => p.code) : []);

/** Every file under `dir` (including .git) with its bytes, to show that nothing changed. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(dir, full)] = sha256Hex(readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

function ready(result: PreflightResult) {
  if (result.status !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(result)}`);
  return result;
}

async function preparationHeader(s: Setup): Promise<{ header: JournalHeader; keys: string[] }> {
  const result = ready(await run(s, { embeddingModelId: MODEL_ID }));
  return { header: result.header!, keys: result.keys };
}

describe('a clean setup', () => {
  it('is ready, with a deterministic identity and a precisely defined build hash', async () => {
    const s = setup();
    const first = ready(await run(s));
    const second = ready(await run(s));
    expect(first.identityDigest).toBe(second.identityDigest);
    expect(first.identityDigest).toBe(digestOf(first.identity));
    expect(first.identity).toMatchObject({
      phase: 'preparation',
      protocolVersion: '1.0.0',
      manifestSha256: sha256Hex(s.bytes),
      repository: { name: 'owner/repo', head: commits[31] },
      tracebound: { commit: s.tb.git('rev-parse', 'HEAD'), sourceClean: true, typescriptVersion: '7.0.2' },
      embedding: { model: 'nomic-embed-text:v1.5', modelId: null, verifiedAgainstProvider: false },
      frozenDatabaseSha256: null,
    });
    expect(first.identity.tracebound.buildSha256).toBe(
      digestOf({ compiler: { name: 'typescript', version: '7.0.2' }, outputs: [{ path: 'dist/a.js', sha256: sha256Hex(compiled(SOURCE)) }] }),
    );
    expect(first.header).toBeNull();
    expect(first.keys).toEqual(commits.slice(0, 30));
    expect(first.work).toMatchObject({ exists: false, preparationJournal: { state: 'absent' }, frozenDatabase: { state: 'absent' } });
  });

  it('gives a journal header once the embedding model id is configured', async () => {
    const s = setup();
    const result = ready(await run(s, { embeddingModelId: MODEL_ID }));
    expect(validateHeader(result.header)).toEqual(result.header);
    expect(result.header).toMatchObject({ phase: 'preparation', embeddingModelId: MODEL_ID, manifestSha256: sha256Hex(s.bytes) });
  });

  it('changes nothing: not the checkout, the clone, the manifest or the work directory', async () => {
    const s = setup();
    mkdirSync(s.work);
    const { header, keys } = await preparationHeader(s);
    const journal = createJournal(join(s.work, WORK_FILES.preparationJournal), { header, keys });
    journal.append({ kind: 'record', phase: 'preparation', base: keys[0]!, status: 'succeeded', failures: [], evidence: {} });
    writeFileSync(join(s.work, WORK_FILES.workingDatabase), 'db');
    const before = [tree(s.tb.path), tree(got.path), tree(s.work)];
    expect((await run(s, { embeddingModelId: MODEL_ID })).status).toBe('ready');
    expect([tree(s.tb.path), tree(got.path), tree(s.work)]).toEqual(before);
  });

  it('never creates the work directory', async () => {
    const s = setup();
    ready(await run(s));
    expect(() => statSync(s.work)).toThrow();
  });
});

describe('the frozen manifest', () => {
  it('refuses a manifest that is not the registered one', async () => {
    const s = setup({ registration: { manifestSha256: 'd179d992f28b201b558e9c5c97db3e9b0ac39f18544b2463d73f317b865eb361' } });
    expect(await run(s)).toMatchObject({ status: 'invalid', problems: [{ code: 'manifest-hash-mismatch' }] });
  });

  it('refuses a manifest that is not canonical JSON, even with the matching hash', async () => {
    const s = setup();
    const pretty = Buffer.from(JSON.stringify(manifestValue(), null, 2));
    const path = join(scratch, `pretty-${counter}.json`);
    writeFileSync(path, pretty);
    expect(await run(s, { manifestPath: path }, { registration: registrationFor(pretty) })).toMatchObject({ status: 'invalid', problems: [{ code: 'manifest-not-canonical' }] });
  });

  it('refuses a missing manifest', async () => {
    const s = setup();
    expect(await run(s, { manifestPath: join(scratch, 'none.json') })).toMatchObject({ status: 'invalid', problems: [{ code: 'manifest-unreadable' }] });
  });

  const mutations: [string, (m: CochangeManifest) => void][] = [
    ['another schema version', (m) => Object.assign(m, { schemaVersion: '2.0.0' })],
    ['another protocol version', (m) => Object.assign(m, { protocol: { ...m.protocol, version: '1.1.0' } })],
    ['changed selection rules', (m) => Object.assign(m, { rules: { ...m.rules, maxChangeRecords: 20 } })],
    ['another repository', (m) => Object.assign(m, { repository: { ...m.repository, name: 'other/repo' } })],
    ['an unknown field', (m) => Object.assign(m, { extra: true })],
    ['a duplicate commit', (m) => (m.commits[1] = { ...m.commits[0]!, eligibleIndex: 1 })],
    ['an abbreviated sha', (m) => (m.commits[0]!.sha = m.commits[0]!.sha.slice(0, 12))],
    ['a wrong eligible index', (m) => (m.commits[3]!.eligibleIndex = 4)],
    ['counts that do not add up', (m) => (m.counts.reachable = 40)],
    ['too few eligible commits', (m) => Object.assign(m, { counts: { ...m.counts, eligible: 29, reachable: 31 } })],
    ['inputs that do not follow from the changes', (m) => (m.commits[0]!.inputs = ['src/b.ts'])],
    ['a target that is also an input', (m) => (m.commits[0]!.targets = [...m.commits[0]!.targets, { path: 'src/a.ts', kind: 'test', status: 'modified' }])],
    ['an added file used as a target', (m) => (m.commits[0]!.changes[1] = { ...m.commits[0]!.changes[1]!, status: 'added' })],
    ['eleven change records', (m) => (m.commits[0]!.changes = Array.from({ length: 11 }, (_, i) => ({ status: 'modified', path: `f${i}.ts`, previousPath: null, similarity: null, basePath: `f${i}.ts`, baseClass: 'ignored' })))],
    ['changes out of path order', (m) => m.commits[0]!.changes.reverse()],
    ['a non-portable path', (m) => (m.commits[0]!.changes[0] = { ...m.commits[0]!.changes[0]!, path: '../a.ts' })],
  ];
  it.each(mutations)('refuses a manifest with %s', async (_label, mutate) => {
    const manifest = structuredClone(manifestValue());
    mutate(manifest);
    const s = setup({ manifest });
    const result = await run(s);
    expect(result.status).toBe('invalid');
    expect(codes(result)[0]).toMatch(/^manifest-/);
  });
});

describe('the dataset repository', () => {
  it('refuses a shallow clone', async () => {
    const shallow = join(scratch, `shallow-${counter}`);
    execFileSync('git', ['clone', '--quiet', '--depth', '3', pathToFileURL(got.path).href, shallow]);
    const s = setup();
    expect(await run(s, { repositoryPath: shallow })).toMatchObject({ status: 'invalid', problems: [{ code: 'repository-shallow' }] });
  });

  it('refuses a partial clone', async () => {
    const partial = join(scratch, `partial-${counter}`);
    execFileSync('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', pathToFileURL(got.path).href, partial]);
    const s = setup();
    expect(await run(s, { repositoryPath: partial })).toMatchObject({ status: 'invalid', problems: [{ code: 'repository-partial' }] });
  });

  it('refuses a path that is not a repository', async () => {
    const s = setup();
    const empty = mkdtempSync(join(scratch, 'empty-'));
    expect(await run(s, { repositoryPath: empty })).toMatchObject({ status: 'invalid', problems: [{ code: 'repository-invalid' }] });
  });

  it('refuses a clone without the pinned head', async () => {
    const manifest = manifestValue();
    manifest.repository.head = 'f'.repeat(40);
    const s = setup({ manifest, registration: { head: 'f'.repeat(40) } });
    expect(await run(s)).toMatchObject({ status: 'invalid', problems: [{ code: 'commit-missing' }] });
  });

  it('refuses a selected commit the clone does not have', async () => {
    const manifest = manifestValue();
    manifest.commits[5]!.sha = 'e'.repeat(40);
    const s = setup({ manifest });
    expect(await run(s)).toMatchObject({ status: 'invalid', problems: [{ code: 'commit-missing' }] });
  });

  it('refuses a commit whose parent is not the recorded base', async () => {
    const manifest = manifestValue();
    manifest.commits[5]!.base = commits[2]!;
    const s = setup({ manifest });
    expect(await run(s)).toMatchObject({ status: 'invalid', problems: [{ code: 'commit-inconsistent' }] });
  });

  it('refuses a commit whose subject differs from the manifest', async () => {
    const manifest = manifestValue();
    manifest.commits[5]!.subject = 'rewritten';
    const s = setup({ manifest });
    expect(await run(s)).toMatchObject({ status: 'invalid', problems: [{ code: 'commit-inconsistent' }] });
  });

  it('refuses a clone with a missing base commit object', async () => {
    const damaged = join(scratch, `damaged-${counter}`);
    cpSync(got.path, damaged, { recursive: true });
    const sha = commits[4]!;
    rmSync(join(damaged, '.git', 'objects', sha.slice(0, 2), sha.slice(2)), { force: true });
    const s = setup();
    const result = await run(s, { repositoryPath: damaged });
    expect(result.status).toBe('invalid');
    expect(codes(result)[0]).toMatch(/^(repository-invalid|commit-missing)$/);
  });
});

describe('the Tracebound source and build', () => {
  it.each([
    ['a modified source file', (tb: FixtureRepo) => tb.write({ 'src/a.ts': 'export const a = 2;\n' })],
    ['an untracked source file', (tb: FixtureRepo) => tb.write({ 'src/b.ts': 'export const b = 1;\n' })],
    ['an ignored file inside src', (tb: FixtureRepo) => tb.write({ 'src/c.local.ts': 'export const c = 1;\n' })],
    ['an untracked script', (tb: FixtureRepo) => tb.write({ 'scripts/new.mjs': '\n' })],
    ['modified build configuration', (tb: FixtureRepo) => tb.write({ 'tsconfig.build.json': '{"compilerOptions":{}}\n' })],
    ['a modified lockfile', (tb: FixtureRepo) => tb.write({ 'package-lock.json': '{}\n' })],
    ['a staged change', (tb: FixtureRepo) => (tb.write({ 'src/a.ts': 'export const a = 3;\n' }), tb.git('add', 'src/a.ts'))],
    ['a modified protocol document', (tb: FixtureRepo) => tb.write({ 'docs/evaluation/cochange/protocol.md': '# changed\n' })],
  ])('refuses %s', async (_label, dirty) => {
    const s = setup();
    dirty(s.tb);
    const result = await run(s);
    expect(result.status).toBe('refused');
    expect(codes(result)).toContain('source-dirty');
  });

  it('ignores changes outside the evaluation source', async () => {
    const s = setup();
    s.tb.write({ 'README.md': 'edited\n', 'notes.txt': 'untracked\n' });
    expect((await run(s)).status).toBe('ready');
  });

  it('refuses a missing build', async () => {
    const s = setup();
    rmSync(join(s.tb.path, 'dist'), { recursive: true });
    expect(codes(await run(s))).toEqual(['build-missing']);
  });

  it('refuses a build that is not the build of the source', async () => {
    const s = setup();
    writeFileSync(join(s.tb.path, 'dist', 'a.js'), compiled('export const a = 0;\n'));
    expect(codes(await run(s))).toEqual(['build-stale']);
  });

  it('refuses a build with leftover output from deleted source', async () => {
    const s = setup();
    writeFileSync(join(s.tb.path, 'dist', 'old.js'), 'stale\n');
    expect(codes(await run(s))).toEqual(['build-stale']);
  });

  it('refuses when the source cannot be compiled to check the build', async () => {
    const s = setup();
    const failing = async () => {
      throw new Error('tsc exited with 2');
    };
    expect(codes(await run(s, {}, { compile: failing }))).toEqual(['build-unverifiable']);
  });

  it('refuses an installed compiler other than the locked one', async () => {
    const s = setup();
    s.tb.write({ 'node_modules/typescript/package.json': '{"version":"7.0.1"}\n' });
    expect(codes(await run(s))).toEqual(['compiler-unverifiable']);
    rmSync(join(s.tb.path, 'node_modules'), { recursive: true });
    expect(codes(await run(s))).toEqual(['compiler-unverifiable']);
  });

  it('refuses a root that is not the top of a checkout', async () => {
    const s = setup();
    expect(codes(await run(s, { traceboundRoot: join(s.tb.path, 'src'), manifestPath: join(s.tb.path, 'docs', 'evaluation', 'cochange', 'manifest.json') }))).toEqual(['source-not-a-checkout']);
  });

  it('refuses an unsupported Node version', async () => {
    const s = setup();
    expect(codes(await run(s, {}, { nodeVersion: 'v22.12.0' }))).toEqual(['node-unsupported']);
  });
});

describe('the work directory', () => {
  it.each([
    ['inside the Tracebound checkout', (s: Setup) => join(s.tb.path, 'work')],
    ['inside its release/ tree', (s: Setup) => join(s.tb.path, 'release', 'cochange')],
    ['the checkout itself', (s: Setup) => s.tb.path],
    ['inside the dataset repository', () => join(got.path, 'work')],
  ])('refuses a work directory %s', async (_label, where) => {
    const s = setup();
    expect(codes(await run(s, { workDirectory: where(s) }))).toEqual(['work-directory-unsafe']);
  });

  it('refuses a work directory that reaches the checkout through a link', async () => {
    const s = setup();
    mkdirSync(join(s.tb.path, 'release'), { recursive: true });
    const link = join(scratch, `link-${counter}`);
    symlinkSync(join(s.tb.path, 'release'), link, 'junction');
    expect(codes(await run(s, { workDirectory: join(link, 'work') }))).toEqual(['work-directory-unsafe']);
    expect(codes(await run(s, { workDirectory: link }))).toEqual(['work-directory-unsafe']);
  });

  it('refuses a work directory that is a file', async () => {
    const s = setup();
    writeFileSync(s.work, 'not a directory');
    expect(codes(await run(s))).toEqual(['work-directory-unsafe']);
  });

  it('accepts the run lock as a known entry and leaves it alone', async () => {
    const s = setup();
    mkdirSync(s.work);
    writeFileSync(join(s.work, WORK_FILES.lock), 'held by another invocation\n');
    const before = tree(s.work);
    expect((await run(s)).status).toBe('ready');
    expect(tree(s.work)).toEqual(before);
  });

  it('refuses unexpected entries', async () => {
    const s = setup();
    mkdirSync(s.work);
    writeFileSync(join(s.work, 'results.json'), '{}');
    expect(codes(await run(s))).toEqual(['work-directory-unexpected-entry']);
  });
});

describe('journals and databases in the preparation phase', () => {
  it('resumes a matching journal at its next key', async () => {
    const s = setup();
    mkdirSync(s.work);
    const { header, keys } = await preparationHeader(s);
    const journal = createJournal(join(s.work, WORK_FILES.preparationJournal), { header, keys });
    journal.append({ kind: 'record', phase: 'preparation', base: keys[0]!, status: 'failed', failures: [{ stage: 'ingestion', errorName: 'E', message: 'x' }], evidence: {} });
    writeFileSync(join(s.work, WORK_FILES.workingDatabase), 'db');
    const result = ready(await run(s, { embeddingModelId: MODEL_ID }));
    expect(result.work.preparationJournal).toEqual({ state: 'valid', recorded: 1, next: keys[1], previousRecovery: false });
    expect(result.work.workingDatabase).toBe('present');
  });

  it('refuses a journal written for another identity', async () => {
    const s = setup();
    mkdirSync(s.work);
    const { header, keys } = await preparationHeader(s);
    createJournal(join(s.work, WORK_FILES.preparationJournal), { header: { ...header, embeddingModelId: 'ollama:nomic-embed-text:v1.5@ffffffffffff' }, keys });
    const result = await run(s, { embeddingModelId: MODEL_ID });
    expect(codes(result)).toEqual(['journal-invalid']);
    expect(JSON.stringify(result)).toContain('header-mismatch');
  });

  it('refuses an invalid journal and an orphaned recovery artifact', async () => {
    const s = setup();
    mkdirSync(s.work);
    writeFileSync(join(s.work, WORK_FILES.preparationJournal), 'garbage\n');
    expect(codes(await run(s, { embeddingModelId: MODEL_ID }))).toEqual(['journal-invalid']);
    rmSync(join(s.work, WORK_FILES.preparationJournal));
    writeFileSync(join(s.work, `${WORK_FILES.preparationJournal}.torn`), 'torn');
    expect(codes(await run(s, { embeddingModelId: MODEL_ID }))).toEqual(['journal-invalid']);
  });

  it('reports an interrupted journal without recovering it', async () => {
    const s = setup();
    mkdirSync(s.work);
    const { header, keys } = await preparationHeader(s);
    const path = join(s.work, WORK_FILES.preparationJournal);
    createJournal(path, { header, keys });
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"kind":"rec`);
    const before = tree(s.work);
    const result = await run(s, { embeddingModelId: MODEL_ID });
    expect(result).toMatchObject({ status: 'interrupted', journal: 'preparation', work: { preparationJournal: { state: 'interrupted', recorded: 0, next: keys[0], artifact: 'absent' } } });
    expect(tree(s.work)).toEqual(before);
  });

  it('refuses to judge an existing journal without the embedding model id', async () => {
    const s = setup();
    mkdirSync(s.work);
    const { header, keys } = await preparationHeader(s);
    createJournal(join(s.work, WORK_FILES.preparationJournal), { header, keys });
    expect(codes(await run(s))).toEqual(['journal-identity-unverifiable']);
  });

  it('refuses an existing frozen database, a database without a journal, and a started evaluation', async () => {
    const s = setup();
    mkdirSync(s.work);
    writeFileSync(join(s.work, WORK_FILES.frozenDatabase), 'frozen');
    expect(codes(await run(s))).toEqual(['frozen-database-exists']);
    rmSync(join(s.work, WORK_FILES.frozenDatabase));
    writeFileSync(join(s.work, WORK_FILES.workingDatabase), 'db');
    expect(codes(await run(s))).toEqual(['database-without-journal']);
    rmSync(join(s.work, WORK_FILES.workingDatabase));
    writeFileSync(join(s.work, WORK_FILES.evaluationJournal), 'x');
    expect(codes(await run(s))).toEqual(['evaluation-already-started']);
  });
});

describe('the evaluation phase', () => {
  const frozenBytes = Buffer.from('frozen database bytes');

  /** The freeze identity a finished preparation would have published, for fake database bytes (the structure is not read here). */
  function identityFor(header: JournalHeader, journalPath: string, overrides: { sha256?: string; bytes?: number; journalSha256?: string; embeddingModelId?: string; buildSha256?: string } = {}) {
    const journalBytes = readFileSync(journalPath);
    return buildFreezeIdentity({
      protocolVersion: header.protocolVersion,
      manifestSha256: header.manifestSha256,
      repository: header.repository,
      tracebound: overrides.buildSha256 === undefined ? header.tracebound : { ...header.tracebound, buildSha256: overrides.buildSha256 },
      nodeVersion: header.nodeVersion,
      embeddingModelId: overrides.embeddingModelId ?? header.embeddingModelId,
      preparation: { journalSha256: overrides.journalSha256 ?? sha256Hex(journalBytes), bases: journalBytes.toString('utf8').trim().split('\n').length - 1, succeeded: journalBytes.toString('utf8').trim().split('\n').length - 1, failed: 0 },
      database: {
        file: WORK_FILES.frozenDatabase,
        sha256: overrides.sha256 ?? sha256Hex(frozenBytes),
        bytes: overrides.bytes ?? frozenBytes.length,
        userVersion: 1,
        journalMode: 'delete',
        integrityCheck: 'ok',
        pageSize: 4096,
        pageCount: 1,
        tables: [{ name: 't', rows: 1, sha256: 'a'.repeat(64) }],
      },
    });
  }

  /** A complete preparation journal, a frozen database and its identity; returns the database's SHA-256. */
  async function prepared(s: Setup, options: { complete?: boolean; identity?: boolean } = {}): Promise<{ sha256: string; header: JournalHeader }> {
    mkdirSync(s.work);
    const { header, keys } = await preparationHeader(s);
    const journalPath = join(s.work, WORK_FILES.preparationJournal);
    const journal = createJournal(journalPath, { header, keys });
    for (const base of options.complete === false ? keys.slice(0, 3) : keys) {
      const record: PreparationRecord = { kind: 'record', phase: 'preparation', base, status: 'succeeded', failures: [], evidence: {} };
      journal.append(record);
    }
    writeFileSync(join(s.work, WORK_FILES.frozenDatabase), frozenBytes);
    if (options.identity !== false) writeFileSync(join(s.work, WORK_FILES.freezeIdentity), serializeFreezeIdentity(identityFor(header, journalPath)));
    return { sha256: sha256Hex(frozenBytes), header };
  }
  const evaluation = (s: Setup, extra: Partial<PreflightConfig> = {}) => run(s, { phase: 'evaluation', embeddingModelId: MODEL_ID, ...extra });

  it('needs no hash from the caller: it loads the freeze identity and builds the header from it', async () => {
    const s = setup();
    const { sha256 } = await prepared(s);
    const result = ready(await evaluation(s));
    expect(result.header).toMatchObject({ phase: 'evaluation', frozenDatabaseSha256: sha256 });
    expect(result.identity.frozenDatabaseSha256).toBe(sha256);
    expect(result.keys).toEqual(commits.slice(1, 31));
    expect(result.work).toMatchObject({ freezeIdentity: 'verified', evaluationJournal: { state: 'absent' }, frozenDatabase: { state: 'present', sha256, matchesRecorded: true } });
  });

  it('accepts a caller-supplied hash only when it is the identity\'s, and rejects a malformed one or one in the wrong phase', async () => {
    const s = setup();
    const { sha256 } = await prepared(s);
    expect((await evaluation(s, { frozenDatabaseSha256: sha256 })).status).toBe('ready');
    expect(codes(await evaluation(s, { frozenDatabaseSha256: 'b'.repeat(64) }))).toEqual(['frozen-database-mismatch']);
    expect(await evaluation(s, { frozenDatabaseSha256: 'abc' })).toMatchObject({ status: 'invalid', problems: [{ code: 'config-invalid' }] });
    expect(await run(s, { frozenDatabaseSha256: sha256 })).toMatchObject({ status: 'invalid', problems: [{ code: 'config-invalid' }] });
  });

  it('refuses a missing frozen database, with or without an identity', async () => {
    const s = setup();
    await prepared(s);
    rmSync(join(s.work, WORK_FILES.frozenDatabase));
    expect(codes(await evaluation(s))).toEqual(['frozen-database-missing']);
    rmSync(join(s.work, WORK_FILES.freezeIdentity));
    expect(codes(await evaluation(s))).toEqual(['frozen-database-missing']);
  });

  it('refuses a frozen database without a freeze identity, never trusting it by its name', async () => {
    const s = setup();
    const { sha256 } = await prepared(s, { identity: false });
    const result = await evaluation(s);
    expect(codes(result)).toEqual(['freeze-identity-missing']);
    expect(JSON.stringify(result)).toContain('remove it by hand and run the preparation again');
    // A hash from the caller does not stand in for the identity.
    expect(codes(await evaluation(s, { frozenDatabaseSha256: sha256 }))).toEqual(['freeze-identity-missing']);
    expect(Object.keys(tree(s.work))).not.toContain(WORK_FILES.freezeIdentity);
  });

  it.each([
    ['garbage', 'not json'],
    ['JSON that is not canonical', `${JSON.stringify({ a: 1 }, null, 2)}`],
    ['the wrong schema', canonicalJson({ schema: 'other' })],
    ['an extra field', (identity: object) => canonicalJson({ ...identity, extra: 1 })],
    ['a path in the database file name', (identity: any) => canonicalJson({ ...identity, database: { ...identity.database, file: 'C:/work/frozen.sqlite' } })],
    ['a database that is not in delete mode', (identity: any) => canonicalJson({ ...identity, database: { ...identity.database, journalMode: 'wal' } })],
    ['counts that do not add up', (identity: any) => canonicalJson({ ...identity, preparation: { ...identity.preparation, failed: 1 } })],
  ])('refuses a freeze identity with %s', async (_label, content) => {
    const s = setup();
    const { header } = await prepared(s);
    const current = JSON.parse(readFileSync(join(s.work, WORK_FILES.freezeIdentity), 'utf8'));
    writeFileSync(join(s.work, WORK_FILES.freezeIdentity), typeof content === 'function' ? content(current) : content);
    expect(codes(await evaluation(s))).toEqual(['freeze-identity-malformed']);
    expect(header).toBeDefined();
  });

  it.each([
    ['another build', { buildSha256: 'f'.repeat(64) }],
    ['another embedding model', { embeddingModelId: 'ollama:nomic-embed-text:v1.5@ffffffffffff' }],
    ['another preparation journal', { journalSha256: 'e'.repeat(64) }],
  ])('refuses a freeze identity made for %s', async (_label, override) => {
    const s = setup();
    const { header } = await prepared(s);
    writeFileSync(join(s.work, WORK_FILES.freezeIdentity), serializeFreezeIdentity(identityFor(header, join(s.work, WORK_FILES.preparationJournal), override)));
    expect(codes(await evaluation(s))).toEqual(['freeze-identity-mismatch']);
  });

  it('refuses a freeze identity made for the preparation journal as it was, once that journal is not the same bytes', async () => {
    const s = setup();
    await prepared(s);
    const path = join(s.work, WORK_FILES.preparationJournal);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, `${lines.slice(0, -1).join('\n')}\n`);
    const result = await evaluation(s);
    expect(codes(result)).toEqual(['preparation-incomplete', 'freeze-identity-mismatch']);
  });

  it('refuses a frozen database that changed after its identity was published', async () => {
    const s = setup();
    await prepared(s);
    writeFileSync(join(s.work, WORK_FILES.frozenDatabase), 'frozen database bytes!');
    expect(codes(await evaluation(s))).toEqual(['frozen-database-mismatch']);
    writeFileSync(join(s.work, WORK_FILES.frozenDatabase), 'frozen database byte');
    expect(codes(await evaluation(s))).toEqual(['frozen-database-mismatch']);
  });

  it('refuses a freeze identity it cannot check without the embedding model id', async () => {
    const s = setup();
    await prepared(s);
    expect(codes(await run(s, { phase: 'evaluation' }))).toContain('freeze-identity-mismatch');
  });

  it('refuses an incomplete preparation', async () => {
    const s = setup();
    await prepared(s, { complete: false });
    expect(codes(await evaluation(s))).toEqual(['preparation-incomplete']);
  });

  it('reports an interrupted evaluation journal without recovering it', async () => {
    const s = setup();
    await prepared(s);
    const first = ready(await evaluation(s));
    const path = join(s.work, WORK_FILES.evaluationJournal);
    createJournal(path, { header: first.header!, keys: first.keys });
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"kind"`);
    const before = tree(s.work);
    expect(await evaluation(s)).toMatchObject({ status: 'interrupted', journal: 'evaluation' });
    expect(tree(s.work)).toEqual(before);
  });

  it('accepts the freeze identity as a known entry, and refuses one without its database in the preparation phase', async () => {
    const s = setup();
    mkdirSync(s.work);
    const { header, keys } = await preparationHeader(s);
    const journalPath = join(s.work, WORK_FILES.preparationJournal);
    const journal = createJournal(journalPath, { header, keys });
    journal.append({ kind: 'record', phase: 'preparation', base: keys[0]!, status: 'succeeded', failures: [], evidence: {} });
    writeFileSync(join(s.work, WORK_FILES.freezeIdentity), serializeFreezeIdentity(identityFor(header, journalPath)));
    expect(codes(await run(s, { embeddingModelId: MODEL_ID }))).toEqual(['freeze-identity-orphan']);
    writeFileSync(join(s.work, WORK_FILES.frozenDatabase), frozenBytes);
    expect(codes(await run(s, { embeddingModelId: MODEL_ID }))).toEqual(['frozen-database-exists']);
  });

  it('leaves the freeze identity and every other file alone', async () => {
    const s = setup();
    await prepared(s);
    const before = tree(s.work);
    expect((await evaluation(s)).status).toBe('ready');
    expect(tree(s.work)).toEqual(before);
  });
});
