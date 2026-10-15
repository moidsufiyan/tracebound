import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/database.js';
import { indexSnapshotSemantically } from '../src/semantic/semantic-index.js';
import { ingestSnapshot } from '../src/ingestion/ingest-snapshot.js';
import { formatSemanticQuery } from '../src/semantic/chunking.js';
import { searchHybridDetailed } from '../src/retrieval/hybrid-search.js';
import { EmbeddingProviderUnavailableError, type EmbeddingProvider } from '../src/semantic/provider.js';
import { canonicalJson, sha256Hex } from '../src/evaluation/m9/canonical.js';
import { checkDatabase, fileIdentity, tableDigests } from '../src/evaluation/m9/freeze-database.js';
import { parseFreezeIdentity, serializeFreezeIdentity, type FreezeIdentity } from '../src/evaluation/cochange/freeze-identity.js';
import { assembleResults } from '../src/evaluation/cochange/assemble.js';
import { runEvaluation, type EvaluationDependencies, type EvaluationRequest, type EvaluationResult } from '../src/evaluation/cochange/evaluate.js';
import type { EvaluationRecord, PreparationRecord } from '../src/evaluation/cochange/journal.js';
import { LOCK_FILE } from '../src/evaluation/cochange/lock.js';
import { WORK_FILES, type PreflightDependencies, type Registration } from '../src/evaluation/cochange/preflight.js';
import { runPreparation } from '../src/evaluation/cochange/prepare.js';
import { DESIGN_CASE_COMMITS, PROTOCOL, SELECTION_RULES, type CochangeManifest } from '../src/evaluation/cochange/selector.js';
import { FakeEmbeddingProvider } from './fake-embedding-provider.js';
import { FixtureRepo } from './git-fixture.js';

// Each test runs preflight, Git and SQLite work on prepared fixtures; the 5 s default is too tight when the suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

const MODEL_ID = 'ollama:nomic-embed-text:v1.5@0a109f422b47';
const SOURCE = 'export const a = 1;\n';
const compiled = (text: string) => `// compiled\n${text}`;
const VOCABULARY = ['import', 'export', 'const', 'guide', 'check', 'change'];

let got: FixtureRepo;
let tb: FixtureRepo;
let commits: string[];
let scratch: string;
let registration: Registration;
/** A prepared work directory (all bases succeeded) and its frozen database's SHA-256. */
let template: { work: string; frozen: string };
/** A prepared work directory whose fourth base failed semantic indexing. */
let failedTemplate: { work: string; frozen: string };
/** A prepared work directory whose fourth base failed ingestion, so it has no snapshot. */
let unsnapshottedTemplate: { work: string; frozen: string };

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
      subject: `change ${i + 1} to the guide check`,
      eligibleIndex: i,
      changes: [
        { status: 'modified', path: 'docs/guide.md', previousPath: null, similarity: null, basePath: 'docs/guide.md', baseClass: 'doc' },
        { status: 'modified', path: 'src/a.ts', previousPath: null, similarity: null, basePath: 'src/a.ts', baseClass: 'source' },
        { status: 'modified', path: 'test/a.test.ts', previousPath: null, similarity: null, basePath: 'test/a.test.ts', baseClass: 'test' },
        { status: 'modified', path: 'test/bin.test.ts', previousPath: null, similarity: null, basePath: 'test/bin.test.ts', baseClass: 'test' },
      ],
      inputs: ['src/a.ts'],
      targets: [
        { path: 'docs/guide.md', kind: 'doc', status: 'modified' },
        { path: 'test/a.test.ts', kind: 'test', status: 'modified' },
        { path: 'test/bin.test.ts', kind: 'test', status: 'modified' },
      ],
    })),
  };
}

const fakeCompile: NonNullable<PreflightDependencies['compile']> = async (root, outDir) => {
  writeFileSync(join(outDir, 'a.js'), compiled(readFileSync(join(root, 'src', 'a.ts'), 'utf8')));
};
const newProvider = () => new FakeEmbeddingProvider(VOCABULARY, { modelId: MODEL_ID });

beforeAll(async () => {
  got = new FixtureRepo();
  const files = (i: number) => ({
    'src/a.ts': `import { b } from './b.js';\nexport const a = b + ${i};\n`,
    'src/b.ts': `export const b = ${i};\n`,
    'test/a.test.ts': `import { a } from '../src/a.js';\nexport const check = a === ${i};\n`,
    // Binary content: ingestion excludes it, so it is a target missing from every snapshot.
    'test/bin.test.ts': Buffer.from([0, 1, 2, i]),
    'docs/guide.md': `# Guide ${i}\nchange the guide\n`,
  });
  commits = [got.commit(files(0), { message: 'root' })];
  for (let i = 1; i <= 31; i += 1) commits.push(got.commit(files(i), { message: `change ${i} to the guide check` }));

  const bytes = Buffer.from(canonicalJson(manifestValue()), 'utf8');
  tb = new FixtureRepo();
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
  registration = { manifestSha256: sha256Hex(bytes), repositoryName: 'owner/repo', head: commits[31]!, since: null, embeddingModel: 'nomic-embed-text:v1.5' };
  scratch = mkdtempSync(join(tmpdir(), 'tracebound-evaluate-test-'));

  const prepare = async (work: string, failBase: string | null, stage: 'ingest' | 'semantic' = 'semantic') => {
    const result = await runPreparation(
      { traceboundRoot: tb.path, repositoryPath: got.path, workDirectory: work, embeddingModelId: MODEL_ID, provider: newProvider() },
      {
        compile: fakeCompile,
        registration,
        ...(failBase && stage === 'ingest'
          ? {
              stages: {
                ingest: async (db: Database, repositoryId: number, base: string) => {
                  if (base === failBase) throw new Error('the tree could not be read');
                  return ingestSnapshot(db, repositoryId, base);
                },
              },
            }
          : {}),
        ...(failBase && stage === 'semantic'
          ? {
              stages: {
                indexSemantically: async (db: Database, id: number, provider: EmbeddingProvider) => {
                  const base = (db.prepare('SELECT commit_sha FROM repository_snapshot WHERE id = ?').get(id) as { commit_sha: string }).commit_sha;
                  if (base === failBase) throw new Error('semantic indexing broke');
                  return indexSnapshotSemantically(db, id, provider);
                },
              },
            }
          : {}),
      },
    );
    if (result.status !== 'prepared') throw new Error(`fixture preparation failed: ${JSON.stringify(result)}`);
    return { work, frozen: result.frozen.sha256 };
  };
  template = await prepare(join(scratch, 'template'), null);
  failedTemplate = await prepare(join(scratch, 'template-failed'), commits[3]!);
  unsnapshottedTemplate = await prepare(join(scratch, 'template-unsnapshotted'), commits[3]!, 'ingest');
}, 300_000);

afterAll(() => {
  got.remove();
  tb.remove();
  rmSync(scratch, { recursive: true, force: true });
});

let counter = 0;
/** A fresh copy of a prepared work directory. */
function workCopy(from = template): string {
  counter += 1;
  const work = join(scratch, `work-${counter}`);
  cpSync(from.work, work, { recursive: true });
  return work;
}

function request(work: string, overrides: Partial<EvaluationRequest> = {}): EvaluationRequest {
  return { traceboundRoot: tb.path, repositoryPath: got.path, workDirectory: work, embeddingModelId: MODEL_ID, frozenDatabaseSha256: template.frozen, provider: newProvider(), ...overrides };
}
const deps = (extra: Partial<EvaluationDependencies> = {}): EvaluationDependencies => ({ compile: fakeCompile, registration, ...extra });
const evaluate = (work: string, overrides: Partial<EvaluationRequest> = {}, extra: Partial<EvaluationDependencies> = {}) => runEvaluation(request(work, overrides), deps(extra));

const journalOf = (work: string) => join(work, WORK_FILES.evaluationJournal);
function records(work: string): EvaluationRecord[] {
  return readFileSync(journalOf(work), 'utf8').trim().split('\n').slice(1).map((line) => JSON.parse(line) as EvaluationRecord);
}
function preparationRecords(work: string): PreparationRecord[] {
  return readFileSync(join(work, WORK_FILES.preparationJournal), 'utf8').trim().split('\n').slice(1).map((line) => JSON.parse(line) as PreparationRecord);
}
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
const selected = () => commits.slice(1, 31);
/** Rewrites the freeze identity of a work directory copy with `change` applied, as canonical JSON. */
function rewriteIdentity(work: string, change: (identity: FreezeIdentity) => unknown): void {
  const path = join(work, WORK_FILES.freezeIdentity);
  const parsed = parseFreezeIdentity(readFileSync(path));
  if (parsed.status !== 'ok') throw new Error('the identity to rewrite is not valid');
  writeFileSync(path, canonicalJson(change(parsed.identity)));
}
const crashBefore = (n: number) => {
  let seen = 0;
  return () => {
    if (seen++ === n) throw new Error('simulated crash');
  };
};

/** A provider that can be switched to an outage, or to fail one particular call. */
class SwitchableProvider implements EmbeddingProvider {
  readonly modelId = MODEL_ID;
  readonly inner = newProvider();
  readonly dimensions = this.inner.dimensions;
  readonly maxInputChars = this.inner.maxInputChars;
  down = false;
  calls = 0;
  failCall: number | null = null;
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls += 1;
    if (this.down || this.calls === this.failCall) throw new EmbeddingProviderUnavailableError('Cannot reach Ollama at http://127.0.0.1:11434/api/embed', { cause: new TypeError('fetch failed') });
    return this.inner.embed(texts);
  }
}

/** The production search, failing for the given snapshot when `when` says so. */
function searchFailing(when: (snapshotId: number, description: string) => Error | null): typeof searchHybridDetailed {
  return async (db, snapshotId, provider, query) => {
    const error = when(snapshotId, query.description);
    if (error) throw error;
    return searchHybridDetailed(db, snapshotId, provider, query);
  };
}

function executed(result: EvaluationResult) {
  if (result.status !== 'executed-complete' && result.status !== 'executed-primary-incomplete') throw new Error(JSON.stringify(result));
  return result;
}

describe('a complete evaluation', () => {
  it('evaluates every commit in manifest order with every registered method and records where each result came from', async () => {
    const work = workCopy();
    const before = tree(work);
    const provider = newProvider();
    const result = executed(await evaluate(work, { provider }));
    expect(result).toMatchObject({ status: 'executed-complete', commits: 30, recordedThisRun: 30, primaryFailedCommits: [], siblingFailedCommits: [], sensitivityFailedCommits: [] });
    expect(result.journalSha256).toBe(sha256Hex(readFileSync(journalOf(work))));
    expect(records(work).map((r) => [r.commit, r.status])).toEqual(selected().map((sha) => [sha, 'succeeded']));

    const prepared = preparationRecords(work);
    const first = records(work)[0]!;
    const e = first.evidence as Record<string, any>;
    expect(e).toMatchObject({
      base: commits[0],
      snapshotId: prepared[0]!.evidence['snapshotId'],
      preparation: { status: 'succeeded' },
      query: { description: 'change 1 to the guide check', inputPaths: ['src/a.ts'] },
      targets: [{ path: 'docs/guide.md', kind: 'doc' }, { path: 'test/a.test.ts', kind: 'test' }, { path: 'test/bin.test.ts', kind: 'test' }],
      missingTargets: [{ path: 'test/bin.test.ts', reason: 'binary' }],
      linkedTargetPaths: ['test/a.test.ts'],
      retrieval: { rrfK: 60, modelId: MODEL_ID },
    });
    expect(e.rankings.siblingPaths).toEqual(['test/a.test.ts']);
    for (const key of ['hybridPaths', 'deterministicPaths', 'semanticPaths', 'noDescriptionPaths']) {
      expect(e.rankings[key].length, key).toBeGreaterThan(0);
      expect(e.rankings[key], key).not.toContain('src/a.ts');
    }
    // The ordinary and no-description queries, in that order, are the ones the provider embedded.
    expect(e.queryEmbeddings.ordinary.map((q: { textSha256: string }) => q.textSha256)).toEqual([sha256Hex(formatSemanticQuery('change 1 to the guide check', ['src/a.ts']))]);
    expect(e.queryEmbeddings.noDescription.map((q: { textSha256: string }) => q.textSha256)).toEqual([sha256Hex(formatSemanticQuery('', ['src/a.ts']))]);
    expect(provider.embedded.slice(0, 2)).toEqual([formatSemanticQuery('change 1 to the guide check', ['src/a.ts']), formatSemanticQuery('', ['src/a.ts'])]);

    // The recorded hybrid ranking is the production ranking of the frozen snapshot, inputs removed.
    const db = new DatabaseSync(join(work, WORK_FILES.frozenDatabase), { readOnly: true });
    const run = await searchHybridDetailed(db as Database, e.snapshotId, newProvider(), { description: 'change 1 to the guide check', changedPaths: ['src/a.ts'] });
    db.close();
    expect(e.rankings.hybridPaths).toEqual(run.fused.map((c) => c.path).filter((p) => p !== 'src/a.ts'));
    expect(e.rankings.deterministicPaths).toEqual(run.deterministic.map((c) => c.path).filter((p) => p !== 'src/a.ts'));

    const after = tree(work);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), WORK_FILES.evaluationJournal].sort());
    for (const [file, hash] of Object.entries(before)) expect(after[file], file).toBe(hash);
    expect(existsSync(join(work, LOCK_FILE))).toBe(false);
  }, 120_000);

  it('is deterministic: two runs on copies of the same preparation write the same bytes', async () => {
    const a = workCopy();
    const b = workCopy();
    const first = executed(await evaluate(a));
    const second = executed(await evaluate(b));
    expect(first.journalSha256).toBe(second.journalSha256);
    expect(readFileSync(journalOf(a)).equals(readFileSync(journalOf(b)))).toBe(true);
  }, 120_000);
});

describe('resuming', () => {
  it('never evaluates a recorded commit again and keeps the recorded bytes', async () => {
    const work = workCopy();
    await expect(evaluate(work, {}, { beforeAppend: crashBefore(5) })).rejects.toThrow('simulated crash');
    expect(records(work)).toHaveLength(5);
    const recorded = readFileSync(journalOf(work), 'utf8');
    const provider = newProvider();
    const result = executed(await evaluate(work, { provider }));
    expect(result).toMatchObject({ status: 'executed-complete', recordedThisRun: 25 });
    expect(provider.calls).toBe(25 * 2);
    expect(provider.embedded[0]).toBe(formatSemanticQuery('change 6 to the guide check', ['src/a.ts']));
    expect(readFileSync(journalOf(work), 'utf8').startsWith(recorded)).toBe(true);
  }, 120_000);

  it('recovers a torn tail under the lock and resumes at that commit', async () => {
    const work = workCopy();
    await expect(evaluate(work, {}, { beforeAppend: crashBefore(3) })).rejects.toThrow('simulated crash');
    writeFileSync(journalOf(work), `${readFileSync(journalOf(work), 'utf8')}{"kind":"rec`);
    const provider = newProvider();
    const result = executed(await evaluate(work, { provider }));
    expect(result).toMatchObject({ status: 'executed-complete', recordedThisRun: 27, recoveredTornTail: true });
    expect(readFileSync(`${journalOf(work)}.torn`, 'utf8')).toBe('{"kind":"rec');
    expect(provider.embedded[0]).toBe(formatSemanticQuery('change 4 to the guide check', ['src/a.ts']));
  }, 120_000);
});

describe('method failures', () => {
  it('records a failed ordinary search for the three primary methods: the run is executed but primary-incomplete', async () => {
    const work = workCopy();
    const target = (preparationRecords(work)[6]!.evidence['snapshotId'] as number);
    const search = searchFailing((id, description) => (id === target && description !== '' ? new RangeError('search broke') : null));
    const result = executed(await evaluate(work, {}, { search }));
    expect(result).toMatchObject({ status: 'executed-primary-incomplete', primaryFailedCommits: [selected()[6]], sensitivityFailedCommits: [], siblingFailedCommits: [] });
    const record = records(work)[6]!;
    expect(record).toMatchObject({ status: 'failed', failures: ['hybrid', 'deterministic', 'semantic'].map((method) => ({ method, stage: 'retrieval', errorName: 'RangeError', message: 'search broke' })) });
    expect(Object.keys((record.evidence as any).rankings).sort()).toEqual(['noDescriptionPaths', 'siblingPaths']);
  }, 120_000);

  it('keeps a no-description failure to the sensitivity analysis', async () => {
    const work = workCopy();
    const target = (preparationRecords(work)[2]!.evidence['snapshotId'] as number);
    const search = searchFailing((id, description) => (id === target && description === '' ? new Error('arm broke') : null));
    const result = executed(await evaluate(work, {}, { search }));
    expect(result).toMatchObject({ status: 'executed-complete', primaryFailedCommits: [], sensitivityFailedCommits: [selected()[2]] });
    expect(records(work)[2]).toMatchObject({ status: 'failed', failures: [{ method: 'no-description', stage: 'retrieval', message: 'arm broke' }] });
  }, 120_000);

  it('records a base that failed preparation as failed without searching it', async () => {
    const work = workCopy(failedTemplate);
    const failedSnapshot = preparationRecords(work)[3]!.evidence['snapshotId'] as number;
    const searched: number[] = [];
    const search = searchFailing((id) => (searched.push(id), null));
    const result = executed(await evaluate(work, { frozenDatabaseSha256: failedTemplate.frozen }, { search }));
    expect(result).toMatchObject({ status: 'executed-primary-incomplete', primaryFailedCommits: [selected()[3]], sensitivityFailedCommits: [selected()[3]], siblingFailedCommits: [] });
    expect(searched).not.toContain(failedSnapshot);
    const record = records(work)[3]!;
    expect(record.failures.map((f) => [f.method, f.stage, f.errorName])).toEqual(['hybrid', 'deterministic', 'semantic', 'no-description'].map((m) => [m, 'preparation', 'PreparationFailed']));
    expect((record.evidence as any).preparation).toEqual({ status: 'failed', stage: 'semantic-index' });
    expect((record.evidence as any).rankings.siblingPaths).toEqual(['test/a.test.ts']);
  }, 120_000);
});

describe('a base without a snapshot', () => {
  it('records every method of its commit as failed at preparation, the sibling heuristic included', async () => {
    const work = workCopy(unsnapshottedTemplate);
    const searched: number[] = [];
    const result = executed(await evaluate(work, { frozenDatabaseSha256: unsnapshottedTemplate.frozen }, { search: searchFailing((id) => (searched.push(id), null)) }));
    expect(result).toMatchObject({ status: 'executed-primary-incomplete', primaryFailedCommits: [selected()[3]], siblingFailedCommits: [selected()[3]], sensitivityFailedCommits: [selected()[3]] });
    const record = records(work)[3]!;
    expect(record.failures.map((f) => [f.method, f.stage])).toEqual(['hybrid', 'deterministic', 'semantic', 'sibling', 'no-description'].map((m) => [m, 'preparation']));
    expect(record.evidence).toMatchObject({ snapshotId: null, preparation: { status: 'failed', stage: 'ingestion' }, rankings: {} });
    expect(record.evidence).not.toHaveProperty('missingTargets');
    expect(searched).toHaveLength(29 * 2);
  }, 120_000);
});

describe('an embedding-provider outage', () => {
  it('records the commit it hit, stops before the next one, and resumes there once the provider is back', async () => {
    const work = workCopy();
    const provider = new SwitchableProvider();
    const search = searchFailing((id) => {
      if (id === (preparationRecords(work)[4]!.evidence['snapshotId'] as number)) provider.down = true;
      return null;
    });
    const stopped = await evaluate(work, { provider }, { search });
    expect(stopped).toMatchObject({ status: 'stopped', reason: 'provider-unavailable', recordedThisRun: 5 });
    expect(records(work)).toHaveLength(5);
    const hit = records(work)[4]!;
    expect(hit.failures.map((f) => [f.method, f.errorName])).toEqual(['hybrid', 'deterministic', 'semantic', 'no-description'].map((m) => [m, 'EmbeddingProviderUnavailableError']));
    expect((hit.evidence as any).providerUnavailable).toBe(true);
    expect((hit.evidence as any).rankings.siblingPaths).toEqual(['test/a.test.ts']);
    expect(existsSync(join(work, LOCK_FILE))).toBe(false);
    const recorded = readFileSync(journalOf(work), 'utf8');

    provider.down = false;
    const resumed = executed(await evaluate(work, { provider }));
    expect(resumed).toMatchObject({ status: 'executed-primary-incomplete', recordedThisRun: 25, primaryFailedCommits: [selected()[4]] });
    expect(readFileSync(journalOf(work), 'utf8').startsWith(recorded)).toBe(true);
  }, 120_000);

  it('stops on an outage of the no-description query alone, and the primary results stay complete', async () => {
    const work = workCopy();
    const provider = new SwitchableProvider();
    provider.failCall = 2 * 2 + 2; // the no-description query of the third commit
    const stopped = await evaluate(work, { provider });
    expect(stopped).toMatchObject({ status: 'stopped', reason: 'provider-unavailable', recordedThisRun: 3 });
    expect(records(work)[2]).toMatchObject({ failures: [{ method: 'no-description', errorName: 'EmbeddingProviderUnavailableError' }] });
    const resumed = executed(await evaluate(work, { provider }));
    expect(resumed).toMatchObject({ status: 'executed-complete', primaryFailedCommits: [], sensitivityFailedCommits: [selected()[2]] });
  }, 120_000);
});

describe('the lock', () => {
  it('refuses while another invocation holds it, touching nothing', async () => {
    const work = workCopy();
    const foreign = `${JSON.stringify({ schema: 'tracebound.cochange.lock', version: 1, token: 'x', purpose: 'other', pid: 1, hostname: 'elsewhere.invalid', startedAt: '2026-10-15T00:00:00.000Z' })}\n`;
    writeFileSync(join(work, LOCK_FILE), foreign);
    const before = tree(work);
    expect(await evaluate(work)).toMatchObject({ status: 'locked', lock: { status: 'held' } });
    expect(tree(work)).toEqual(before);
  });

  it('stops without a record for the commit in progress when the lock is lost', async () => {
    const work = workCopy();
    const target = preparationRecords(work)[3]!.evidence['snapshotId'] as number;
    const foreign = `${JSON.stringify({ schema: 'tracebound.cochange.lock', version: 1, token: 'other', purpose: 'other', pid: 1, hostname: 'elsewhere.invalid', startedAt: '2026-10-15T00:00:00.000Z' })}\n`;
    const search = searchFailing((id) => {
      if (id === target) writeFileSync(join(work, LOCK_FILE), foreign);
      return null;
    });
    expect(await evaluate(work, {}, { search })).toMatchObject({ status: 'stopped', reason: 'lock-lost', recordedThisRun: 3 });
    expect(records(work)).toHaveLength(3);
    expect(readFileSync(join(work, LOCK_FILE), 'utf8')).toBe(foreign);
  }, 120_000);
});

describe('prerequisites', () => {
  it('refuses a provider that is not the registered model, a missing work directory, and an unprepared work directory', async () => {
    const work = workCopy();
    const other = new FakeEmbeddingProvider(VOCABULARY, { modelId: 'ollama:nomic-embed-text:v1.5@ffffffffffff' });
    expect(await evaluate(work, { provider: other })).toMatchObject({ status: 'refused', reason: 'model-mismatch' });
    expect(existsSync(journalOf(work))).toBe(false);
    expect(await evaluate(join(scratch, 'none'))).toMatchObject({ status: 'refused', reason: 'work-directory-missing' });
    expect(existsSync(join(scratch, 'none'))).toBe(false);
  });

  it('refuses a frozen database with another hash, a missing one, or one with a sidecar', async () => {
    const work = workCopy();
    expect(await evaluate(work, { frozenDatabaseSha256: 'a'.repeat(64) })).toMatchObject({ status: 'refused', reason: 'preflight', preflight: { problems: [{ code: 'frozen-database-mismatch' }] } });
    writeFileSync(join(work, `${WORK_FILES.frozenDatabase}-wal`), '');
    expect(await evaluate(work)).toMatchObject({ status: 'refused', reason: 'preflight' });
    rmSync(join(work, `${WORK_FILES.frozenDatabase}-wal`));
    rmSync(join(work, WORK_FILES.frozenDatabase));
    expect(await evaluate(work)).toMatchObject({ status: 'refused', reason: 'preflight', preflight: { problems: [{ code: 'frozen-database-missing' }] } });
    expect(existsSync(journalOf(work))).toBe(false);
  });

  it('refuses a frozen database that changed after its identity was published, even when the caller supplies its new hash', async () => {
    const work = workCopy();
    const db = new DatabaseSync(join(work, WORK_FILES.frozenDatabase));
    db.exec('DELETE FROM semantic_chunk WHERE snapshot_id = 2; DELETE FROM semantic_indexed_snapshot WHERE snapshot_id = 2');
    db.close();
    const sha = sha256Hex(readFileSync(join(work, WORK_FILES.frozenDatabase)));
    expect(await evaluate(work, { frozenDatabaseSha256: sha })).toMatchObject({ status: 'refused', reason: 'preflight', preflight: { problems: [{ code: 'frozen-database-mismatch' }] } });
    expect(await evaluate(work)).toMatchObject({ status: 'refused', reason: 'preflight', preflight: { problems: [{ code: 'frozen-database-mismatch' }] } });
    expect(existsSync(journalOf(work))).toBe(false);
  });

  it('refuses a self-consistent identity for a database that does not hold what preparation recorded', async () => {
    const work = workCopy();
    const db = new DatabaseSync(join(work, WORK_FILES.frozenDatabase));
    db.exec('DELETE FROM semantic_chunk WHERE snapshot_id = 2; DELETE FROM semantic_indexed_snapshot WHERE snapshot_id = 2');
    db.close();
    // Someone with write access can re-publish an identity that matches the doctored file; the records still catch it.
    const file = await fileIdentity(join(work, WORK_FILES.frozenDatabase));
    const check = checkDatabase(join(work, WORK_FILES.frozenDatabase));
    rewriteIdentity(work, (identity) => ({
      ...identity,
      database: { ...identity.database, sha256: file.sha256, bytes: file.bytes, pageSize: check.pageSize, pageCount: check.pageCount, tables: tableDigests(join(work, WORK_FILES.frozenDatabase)) },
    }));
    // The caller's old hash is not the identity's, and is never preferred to it.
    expect(await evaluate(work)).toMatchObject({ status: 'refused', reason: 'preflight', preflight: { problems: [{ code: 'frozen-database-mismatch' }] } });
    const { frozenDatabaseSha256: _omitted, ...withoutHash } = request(work);
    expect(await runEvaluation(withoutHash, deps())).toMatchObject({ status: 'refused', reason: 'frozen-database-inconsistent' });
    expect(existsSync(journalOf(work))).toBe(false);
  });

  it('refuses an identity whose recorded table contents are not the database\'s, although its file hash fits', async () => {
    const work = workCopy();
    rewriteIdentity(work, (identity) => ({ ...identity, database: { ...identity.database, tables: identity.database.tables.map((t, i) => (i === 0 ? { ...t, sha256: 'f'.repeat(64) } : t)) } }));
    expect(await evaluate(work)).toMatchObject({ status: 'refused', reason: 'freeze-identity-invalid' });
    rewriteIdentity(work, (identity) => ({ ...identity, database: { ...identity.database, pageCount: identity.database.pageCount + 1 } }));
    expect(await evaluate(work)).toMatchObject({ status: 'refused', reason: 'freeze-identity-invalid' });
    expect(existsSync(journalOf(work))).toBe(false);
  });

  it('refuses a frozen database without an identity, and writes nothing', async () => {
    const work = workCopy();
    rmSync(join(work, WORK_FILES.freezeIdentity));
    const before = tree(work);
    expect(await evaluate(work)).toMatchObject({ status: 'refused', reason: 'preflight', preflight: { problems: [{ code: 'freeze-identity-missing' }] } });
    expect(await evaluate(work, { frozenDatabaseSha256: template.frozen })).toMatchObject({ status: 'refused', reason: 'preflight', preflight: { problems: [{ code: 'freeze-identity-missing' }] } });
    expect(tree(work)).toEqual(before);
  });

  it('refuses an identity made for another run', async () => {
    const work = workCopy();
    rewriteIdentity(work, (identity) => ({ ...identity, tracebound: { ...identity.tracebound, buildSha256: 'f'.repeat(64) } }));
    expect(await evaluate(work)).toMatchObject({ status: 'refused', reason: 'preflight', preflight: { problems: [{ code: 'freeze-identity-mismatch' }] } });
    writeFileSync(join(work, WORK_FILES.freezeIdentity), 'garbage');
    expect(await evaluate(work)).toMatchObject({ status: 'refused', reason: 'preflight', preflight: { problems: [{ code: 'freeze-identity-malformed' }] } });
  });

  it('runs without a caller-supplied hash, using the identity the preparation published', async () => {
    const work = workCopy();
    const { frozenDatabaseSha256: _omitted, ...withoutHash } = request(work);
    const result = executed(await runEvaluation(withoutHash, deps()));
    expect(result).toMatchObject({ status: 'executed-complete', frozenDatabaseSha256: template.frozen });
    expect(JSON.parse(readFileSync(journalOf(work), 'utf8').split('\n')[0]!)).toMatchObject({ phase: 'evaluation', frozenDatabaseSha256: template.frozen });
  }, 120_000);

  it('refuses an incomplete preparation journal, which also no longer matches the freeze identity', async () => {
    const work = workCopy();
    const path = join(work, WORK_FILES.preparationJournal);
    const lines = readFileSync(path, 'utf8').split('\n');
    writeFileSync(path, `${lines.slice(0, -2).join('\n')}\n`);
    const result = await evaluate(work);
    expect(result).toMatchObject({ status: 'refused', reason: 'preflight' });
    expect((result as { preflight: { problems: { code: string }[] } }).preflight.problems.map((p) => p.code)).toEqual(['preparation-incomplete', 'freeze-identity-mismatch']);
  });
});

describe('the frozen database during the run', () => {
  it('is not a result when the frozen database changed while it was being evaluated', async () => {
    const work = workCopy();
    const last = preparationRecords(work)[29]!.evidence['snapshotId'] as number;
    const search = searchFailing((id) => {
      if (id === last) {
        const db = new DatabaseSync(join(work, WORK_FILES.frozenDatabase));
        db.exec("INSERT INTO project (name, created_at) VALUES ('intruder', '2026-10-15T00:00:00.000Z')");
        db.close();
      }
      return null;
    });
    expect(await evaluate(work, {}, { search })).toMatchObject({ status: 'invalid', recordedThisRun: 30 });
    expect(existsSync(join(work, LOCK_FILE))).toBe(false);
  }, 120_000);
});

describe('the evaluation journal', () => {
  it('refuses a corrupt journal, and duplicate or out-of-order records', async () => {
    const work = workCopy();
    writeFileSync(journalOf(work), 'garbage\n');
    expect(await evaluate(work)).toMatchObject({ status: 'refused', reason: 'preflight' });

    const good = workCopy();
    executed(await evaluate(good));
    const lines = readFileSync(journalOf(good), 'utf8').split('\n');
    writeFileSync(journalOf(work), `${[lines[0], lines[2], lines[1]].join('\n')}\n`);
    expect(await evaluate(work)).toMatchObject({ status: 'refused', reason: 'preflight' });
    writeFileSync(journalOf(work), `${[lines[0], lines[1], lines[1]].join('\n')}\n`);
    expect(await evaluate(work)).toMatchObject({ status: 'refused', reason: 'preflight' });
  }, 120_000);

  it('never declares completion for records that do not match their inputs', async () => {
    const work = workCopy();
    executed(await evaluate(work));
    const lines = readFileSync(journalOf(work), 'utf8').trim().split('\n');
    const record = JSON.parse(lines[8]!) as EvaluationRecord;
    (record.evidence as any).query.description = 'another subject';
    lines[8] = canonicalJson(record);
    writeFileSync(journalOf(work), `${lines.join('\n')}\n`);
    expect(await evaluate(work)).toMatchObject({ status: 'invalid', recordedThisRun: 0 });

    const missingRanking = workCopy();
    executed(await evaluate(missingRanking));
    const other = readFileSync(journalOf(missingRanking), 'utf8').trim().split('\n');
    const changed = JSON.parse(other[4]!) as EvaluationRecord;
    delete (changed.evidence as any).rankings.noDescriptionPaths;
    other[4] = canonicalJson(changed);
    writeFileSync(journalOf(missingRanking), `${other.join('\n')}\n`);
    expect(await evaluate(missingRanking)).toMatchObject({ status: 'invalid' });
  }, 120_000);
});

describe('results assembly of what the runner wrote', () => {
  it('assembles the journals of a real run: complete, then Inconclusive after a primary failure', async () => {
    const manifestPath = join(tb.path, 'docs', 'evaluation', 'cochange', 'manifest.json');
    const work = workCopy();
    executed(await evaluate(work));
    const first = await assembleResults({ workDirectory: work, manifestPath }, { registration });
    if (first.status !== 'assembled') throw new Error(JSON.stringify(first));
    expect(first.results).toMatchObject({ status: 'complete', run: { commits: 30, primaryTestPopulation: 30 }, primary: { estimated: true } });
    expect(first.results.cases[0]!.targets).toEqual([
      { path: 'docs/guide.md', kind: 'doc', linked: null, missingReason: null },
      { path: 'test/a.test.ts', kind: 'test', linked: true, missingReason: null },
      { path: 'test/bin.test.ts', kind: 'test', linked: false, missingReason: 'binary' },
    ]);
    expect(first.results.cases[0]!.methods.sibling.targetRanks).toEqual({ 'docs/guide.md': null, 'test/a.test.ts': 1, 'test/bin.test.ts': null });
    const again = await assembleResults({ workDirectory: work, manifestPath }, { registration });
    expect(again.status === 'assembled' && again.sha256).toBe(first.sha256);

    const failing = workCopy();
    const target = preparationRecords(failing)[6]!.evidence['snapshotId'] as number;
    executed(await evaluate(failing, {}, { search: searchFailing((id, description) => (id === target && description !== '' ? new Error('search broke') : null)) }));
    const incomplete = await assembleResults({ workDirectory: failing, manifestPath }, { registration });
    expect(incomplete).toMatchObject({ status: 'assembled', results: { status: 'primary-incomplete', primary: { estimated: false }, decision: { outcome: 'inconclusive', rule: 'incomplete-run' } } });
  }, 120_000);
});
