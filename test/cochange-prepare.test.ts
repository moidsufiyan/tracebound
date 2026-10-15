import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { ingestSnapshot } from '../src/ingestion/ingest-snapshot.js';
import { indexSnapshotLexically } from '../src/retrieval/lexical-index.js';
import { indexSnapshotStructurally } from '../src/analysis/structural-index.js';
import { indexSnapshotSemantically } from '../src/semantic/semantic-index.js';
import { canonicalJson, sha256Hex } from '../src/evaluation/m9/canonical.js';
import { checkDatabase, tableDigests } from '../src/evaluation/m9/freeze-database.js';
import { bindingsOf, FREEZE_IDENTITY_FILE, parseFreezeIdentity, serializeFreezeIdentity, verifyFreezeIdentity } from '../src/evaluation/cochange/freeze-identity.js';
import { inspectJournal, type PreparationRecord } from '../src/evaluation/cochange/journal.js';
import { LOCK_FILE } from '../src/evaluation/cochange/lock.js';
import { WORK_FILES, type PreflightDependencies, type Registration } from '../src/evaluation/cochange/preflight.js';
import { causedByProviderOutage, runPreparation, type PreparationDependencies, type PreparationRequest, type PreparationStages } from '../src/evaluation/cochange/prepare.js';
import { EmbeddingProviderError, EmbeddingProviderUnavailableError, type EmbeddingProvider } from '../src/semantic/provider.js';
import { DESIGN_CASE_COMMITS, PROTOCOL, SELECTION_RULES, type CochangeManifest } from '../src/evaluation/cochange/selector.js';
import { FakeEmbeddingProvider } from './fake-embedding-provider.js';
import { FixtureRepo } from './git-fixture.js';

const MODEL_ID = 'ollama:nomic-embed-text:v1.5@0a109f422b47';
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
    'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, i]),
  });
  commits = [got.commit(files(0), { message: 'root' })];
  for (let i = 1; i <= 31; i += 1) commits.push(got.commit(files(i), { message: `change ${i}` }));
  scratch = mkdtempSync(join(tmpdir(), 'tracebound-prepare-test-'));
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

const fakeCompile: NonNullable<PreflightDependencies['compile']> = async (root, outDir) => {
  writeFileSync(join(outDir, 'a.js'), compiled(readFileSync(join(root, 'src', 'a.ts'), 'utf8')));
};

interface Setup {
  tb: FixtureRepo;
  work: string;
  request: PreparationRequest;
  deps: PreparationDependencies;
  provider: FakeEmbeddingProvider;
  bases: string[];
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
  const work = join(scratch, `work-${counter}`);
  const registration: Registration = { manifestSha256: sha256Hex(bytes), repositoryName: 'owner/repo', head: commits[31]!, since: null, embeddingModel: 'nomic-embed-text:v1.5' };
  const provider = new FakeEmbeddingProvider(['import', 'export', 'const', 'guide', 'check'], { modelId: MODEL_ID });
  return {
    tb,
    work,
    provider,
    bases: commits.slice(0, 30),
    request: { traceboundRoot: tb.path, repositoryPath: got.path, workDirectory: work, embeddingModelId: MODEL_ID, provider },
    deps: { compile: fakeCompile, registration },
  };
}

const run = (s: Setup, deps: Partial<PreparationDependencies> = {}, request: Partial<PreparationRequest> = {}) =>
  runPreparation({ ...s.request, ...request }, { ...s.deps, ...deps });

/** The production stages, each logging its call and failing when `fail` says so. */
function stagesWith(log: string[], fail?: (stage: keyof PreparationStages, base: string) => Error | null): PreparationStages {
  const baseOf = (db: Parameters<typeof indexSnapshotLexically>[0], snapshotId: number) =>
    (db.prepare('SELECT commit_sha FROM repository_snapshot WHERE id = ?').get(snapshotId) as { commit_sha: string }).commit_sha;
  const check = (stage: keyof PreparationStages, base: string) => {
    log.push(`${stage} ${base}`);
    const error = fail?.(stage, base);
    if (error) throw error;
  };
  return {
    ingest: async (db, repositoryId, base) => (check('ingest', base), ingestSnapshot(db, repositoryId, base)),
    indexLexically: (db, id) => (check('indexLexically', baseOf(db, id)), indexSnapshotLexically(db, id)),
    indexStructurally: (db, id) => (check('indexStructurally', baseOf(db, id)), indexSnapshotStructurally(db, id)),
    indexSemantically: async (db, id, provider) => (check('indexSemantically', baseOf(db, id)), indexSnapshotSemantically(db, id, provider)),
  };
}

/** Crashes (throws out of runPreparation) just before the record of the `n`-th base (0-based) of this run would be appended. */
function crashBefore(n: number): (record: PreparationRecord) => void {
  let seen = 0;
  return () => {
    if (seen++ === n) throw new Error('simulated crash');
  };
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
  if (existsSync(dir)) walk(dir);
  return out;
}

const journalPath = (s: Setup) => join(s.work, WORK_FILES.preparationJournal);
const databasePath = (s: Setup) => join(s.work, WORK_FILES.workingDatabase);
const frozenPath = (s: Setup) => join(s.work, WORK_FILES.frozenDatabase);
const lockPresent = (s: Setup) => existsSync(join(s.work, LOCK_FILE));
function records(s: Setup): PreparationRecord[] {
  return readFileSync(journalPath(s), 'utf8').trim().split('\n').slice(1).map((line) => JSON.parse(line) as PreparationRecord);
}

describe('a full preparation', () => {
  it('prepares every base in manifest order with the production stages, records each once, and freezes', async () => {
    const s = setup();
    const before = [tree(got.path), tree(s.tb.path)];
    const log: string[] = [];
    const result = await run(s, { stages: stagesWith(log) });
    if (result.status !== 'prepared') throw new Error(JSON.stringify(result));

    expect(result).toMatchObject({ bases: 30, succeeded: 30, failed: 0, recordedThisRun: 30, recoveredTornTail: false });
    expect(log).toEqual(s.bases.flatMap((base) => [`ingest ${base}`, `indexLexically ${base}`, `indexStructurally ${base}`, `indexSemantically ${base}`]));
    expect(records(s).map((r) => [r.base, r.status])).toEqual(s.bases.map((base) => [base, 'succeeded']));
    expect(records(s)[0]!.evidence).toMatchObject({ artifactCount: 4, excludedEntries: [{ path: 'assets/logo.png', reason: 'unsupported_type' }], semantic: { modelId: MODEL_ID } });

    const frozenBytes = readFileSync(frozenPath(s));
    expect(result.frozen).toMatchObject({ file: 'frozen.sqlite', sha256: sha256Hex(frozenBytes), bytes: frozenBytes.length, journalMode: 'delete', integrityCheck: 'ok' });
    expect(checkDatabase(frozenPath(s))).toMatchObject({ integrityCheck: 'ok', foreignKeyViolations: 0, journalMode: 'delete' });
    const frozen = new DatabaseSync(frozenPath(s), { readOnly: true });
    expect((frozen.prepare("SELECT COUNT(*) AS n FROM repository_snapshot WHERE status = 'ready'").get() as { n: number }).n).toBe(30);
    frozen.close();

    expect(lockPresent(s)).toBe(false);
    expect([tree(got.path), tree(s.tb.path)]).toEqual(before);
  }, 120_000);

  it('records a failed base with its stage and evidence, and goes on with the next bases', async () => {
    const s = setup();
    const failing = s.bases[1]!;
    const result = await run(s, { stages: stagesWith([], (stage, base) => (stage === 'indexSemantically' && base === failing ? new TypeError('model went away') : null)) });
    expect(result).toMatchObject({ status: 'prepared', succeeded: 29, failed: 1 });
    const failed = records(s)[1]!;
    expect(failed).toMatchObject({ base: failing, status: 'failed', failures: [{ stage: 'semantic-index', errorName: 'TypeError', message: 'model went away' }] });
    expect(failed.evidence).toMatchObject({ snapshotId: expect.any(Number), excludedEntries: [{ path: 'assets/logo.png', reason: 'unsupported_type' }] });
    expect(records(s)[2]!.status).toBe('succeeded');
  }, 120_000);
});

describe('resuming', () => {
  it('never prepares a recorded base again, failed or succeeded, and continues with the unrecorded ones', async () => {
    const s = setup();
    const failing = s.bases[1]!;
    await expect(run(s, { stages: stagesWith([], (stage, base) => (stage === 'ingest' && base === failing ? new Error('broken tree') : null)), beforeAppend: crashBefore(4) })).rejects.toThrow('simulated crash');
    expect(records(s)).toHaveLength(4);
    expect(lockPresent(s)).toBe(false);

    const log: string[] = [];
    const result = await run(s, { stages: stagesWith(log) });
    expect(result).toMatchObject({ status: 'prepared', bases: 30, succeeded: 29, failed: 1, recordedThisRun: 26 });
    expect(log.filter((line) => s.bases.slice(0, 4).some((base) => line.endsWith(base)))).toEqual([]);
    expect(log[0]).toBe(`ingest ${s.bases[4]}`);
    expect(records(s).map((r) => r.base)).toEqual(s.bases);
    expect(records(s)[1]).toMatchObject({ status: 'failed', failures: [{ stage: 'ingestion', message: 'broken tree' }] });
  }, 120_000);

  it('finishes a base that was interrupted after its stages ran but before its record', async () => {
    const s = setup();
    await expect(run(s, { beforeAppend: crashBefore(2) })).rejects.toThrow('simulated crash');
    expect(records(s)).toHaveLength(2);
    const log: string[] = [];
    const result = await run(s, { stages: stagesWith(log) });
    expect(result).toMatchObject({ status: 'prepared', succeeded: 30 });
    expect(log.slice(0, 4)).toEqual([`ingest ${s.bases[2]}`, `indexLexically ${s.bases[2]}`, `indexStructurally ${s.bases[2]}`, `indexSemantically ${s.bases[2]}`]);
  }, 120_000);

  it('recovers a torn journal tail under the lock and resumes at that base', async () => {
    const s = setup();
    await expect(run(s, { beforeAppend: crashBefore(3) })).rejects.toThrow('simulated crash');
    writeFileSync(journalPath(s), `${readFileSync(journalPath(s), 'utf8')}{"kind":"record","pha`);
    const seenDuringRecovery: boolean[] = [];
    const log: string[] = [];
    const stages = stagesWith(log);
    const result = await run(s, {
      stages: { ...stages, ingest: async (...args) => (seenDuringRecovery.push(lockPresent(s) && existsSync(`${journalPath(s)}.torn`)), stages.ingest(...args)) },
    });
    expect(result).toMatchObject({ status: 'prepared', recoveredTornTail: true, recordedThisRun: 27 });
    expect(readFileSync(`${journalPath(s)}.torn`, 'utf8')).toBe('{"kind":"record","pha');
    expect(seenDuringRecovery[0]).toBe(true);
    expect(log[0]).toBe(`ingest ${s.bases[3]}`);
  }, 120_000);
});

describe('refusals before any work', () => {
  it('holds the lock while preflight runs, and releases it afterwards', async () => {
    const s = setup();
    const lockSeen: boolean[] = [];
    const compile: PreflightDependencies['compile'] = async (root, outDir) => {
      lockSeen.push(lockPresent(s) && JSON.parse(readFileSync(join(s.work, LOCK_FILE), 'utf8')).pid === process.pid);
      return fakeCompile(root, outDir);
    };
    const result = await run(s, { compile, stages: stagesWith([], () => null) });
    expect(result.status).toBe('prepared');
    expect(lockSeen).toEqual([true]);
    expect(lockPresent(s)).toBe(false);
  }, 120_000);

  it('refuses when another invocation holds the lock, touching nothing', async () => {
    const s = setup();
    mkdirSync(s.work);
    const foreign = `${JSON.stringify({ schema: 'tracebound.cochange.lock', version: 1, token: 'x', purpose: 'other', pid: 1, hostname: 'elsewhere.invalid', startedAt: '2026-10-15T00:00:00.000Z' })}\n`;
    writeFileSync(join(s.work, LOCK_FILE), foreign);
    expect(await run(s)).toMatchObject({ status: 'locked', lock: { status: 'held', ownerProcess: 'unknown' } });
    expect(tree(s.work)).toEqual({ [LOCK_FILE]: sha256Hex(foreign) });
  });

  it('refuses a provider that is not the registered model before creating any database', async () => {
    const s = setup();
    const other = new FakeEmbeddingProvider(['import'], { modelId: 'ollama:nomic-embed-text:v1.5@ffffffffffff' });
    expect(await run(s, {}, { provider: other })).toMatchObject({ status: 'refused', reason: 'model-mismatch' });
    expect(tree(s.work)).toEqual({});
  });

  it('refuses a work directory inside the checkout without creating it', async () => {
    const s = setup();
    const inside = join(s.tb.path, 'work');
    expect(await run(s, {}, { workDirectory: inside })).toMatchObject({ status: 'refused', reason: 'work-directory-unsafe' });
    expect(existsSync(inside)).toBe(false);
  });

  it('refuses an invalid journal, a conflicting recovery artifact, and a database without a journal', async () => {
    const s = setup();
    mkdirSync(s.work);
    writeFileSync(journalPath(s), 'garbage\n');
    expect(await run(s)).toMatchObject({ status: 'refused', reason: 'preflight' });
    expect(existsSync(databasePath(s))).toBe(false);

    rmSync(journalPath(s));
    await expect(run(s, { beforeAppend: crashBefore(1) })).rejects.toThrow('simulated crash');
    writeFileSync(journalPath(s), `${readFileSync(journalPath(s), 'utf8')}{"torn"`);
    writeFileSync(`${journalPath(s)}.torn`, 'something else');
    const before = tree(s.work);
    expect(await run(s)).toMatchObject({ status: 'refused', reason: 'preflight' });
    expect(tree(s.work)).toEqual(before);

    rmSync(journalPath(s));
    rmSync(`${journalPath(s)}.torn`);
    expect(await run(s)).toMatchObject({ status: 'refused', reason: 'preflight', preflight: { problems: [{ code: 'database-without-journal' }] } });
    expect(lockPresent(s)).toBe(false);
  }, 120_000);
});

describe('database consistency on resume', () => {
  async function interrupted(s: Setup, after: number): Promise<string> {
    await expect(run(s, { beforeAppend: crashBefore(after) })).rejects.toThrow('simulated crash');
    return readFileSync(journalPath(s), 'utf8');
  }

  it.each([
    ['a lexical index', 'DELETE FROM artifact_path_token'],
    ['a structural index', 'DELETE FROM structurally_indexed_snapshot WHERE snapshot_id = 1'],
    ['a semantic index', 'DELETE FROM semantic_chunk WHERE snapshot_id = 1; DELETE FROM semantic_indexed_snapshot WHERE snapshot_id = 1'],
    ['a recorded excluded entry', 'DELETE FROM excluded_entry WHERE snapshot_id = 1'],
  ])('refuses when %s of a recorded success is missing, and never rebuilds it', async (_label, sql) => {
    const s = setup();
    const journal = await interrupted(s, 3);
    const db = openDatabase(databasePath(s));
    db.exec(sql);
    db.close();
    expect(await run(s)).toMatchObject({ status: 'refused', reason: 'database-inconsistent' });
    expect(readFileSync(journalPath(s), 'utf8')).toBe(journal);
    expect(existsSync(frozenPath(s))).toBe(false);
  }, 120_000);

  it('refuses a snapshot the journal does not account for', async () => {
    const s = setup();
    const journal = await interrupted(s, 3);
    const db = openDatabase(databasePath(s));
    await ingestSnapshot(db, 1, s.bases[10]!);
    db.close();
    expect(await run(s)).toMatchObject({ status: 'refused', reason: 'database-inconsistent' });
    expect(readFileSync(journalPath(s), 'utf8')).toBe(journal);
  }, 120_000);

  it('refuses a missing working database instead of rebuilding recorded bases', async () => {
    const s = setup();
    await interrupted(s, 3);
    rmSync(databasePath(s));
    for (const suffix of ['-wal', '-shm']) rmSync(`${databasePath(s)}${suffix}`, { force: true });
    expect(await run(s)).toMatchObject({ status: 'refused', reason: 'database-missing' });
    expect(existsSync(databasePath(s))).toBe(false);
  }, 120_000);

  it('refuses a corrupt working database', async () => {
    const s = setup();
    const journal = await interrupted(s, 3);
    const bytes = readFileSync(databasePath(s));
    bytes.fill(0x5a, 4096, Math.min(bytes.length, 4096 * 6));
    writeFileSync(databasePath(s), bytes);
    const result = await run(s);
    expect(result).toMatchObject({ status: 'refused' });
    expect(['database-invalid', 'database-inconsistent']).toContain((result as { reason: string }).reason);
    expect(readFileSync(journalPath(s), 'utf8')).toBe(journal);
    expect(lockPresent(s)).toBe(false);
  }, 120_000);

  it('stops without a record when a stage leaves the database damaged', async () => {
    const s = setup();
    const damaging: PreparationStages = {
      ...stagesWith([]),
      indexLexically: (db, id) => {
        if (id === 3) {
          db.exec('PRAGMA foreign_keys = OFF');
          db.exec("INSERT INTO excluded_entry (snapshot_id, path, reason) VALUES (999, 'x', 'binary')");
          db.exec('PRAGMA foreign_keys = ON');
          throw new Error('index failed after damage');
        }
        return indexSnapshotLexically(db, id);
      },
    };
    const result = await run(s, { stages: damaging });
    expect(result).toMatchObject({ status: 'stopped', reason: 'database-invalid', recordedThisRun: 2 });
    expect(records(s)).toHaveLength(2);
    expect(existsSync(frozenPath(s))).toBe(false);
    expect(lockPresent(s)).toBe(false);
  }, 120_000);
});

describe('freezing', () => {
  it('never overwrites an existing frozen database, and reports what it holds', async () => {
    const s = setup();
    const first = await run(s);
    if (first.status !== 'prepared') throw new Error(JSON.stringify(first));
    const frozenBefore = readFileSync(frozenPath(s));
    const again = await run(s);
    expect(again).toMatchObject({
      status: 'refused',
      reason: 'frozen-database-exists',
      frozenInspection: { sha256: first.frozen.sha256, integrityCheck: 'ok', journalMode: 'delete', sameRowsAsWorkingDatabase: true, error: null },
    });
    expect(readFileSync(frozenPath(s)).equals(frozenBefore)).toBe(true);

    writeFileSync(frozenPath(s), 'not a database');
    const damaged = await run(s);
    expect(damaged).toMatchObject({ status: 'refused', reason: 'frozen-database-exists', frozenInspection: { sha256: sha256Hex('not a database') } });
    expect((damaged as { frozenInspection: { error: string | null; integrityCheck: string | null } }).frozenInspection.integrityCheck).not.toBe('ok');
    expect(readFileSync(frozenPath(s), 'utf8')).toBe('not a database');
  }, 120_000);

  it('freezes a journal that was complete but not yet frozen', async () => {
    const s = setup();
    await expect(run(s, { beforeAppend: crashBefore(29) })).rejects.toThrow('simulated crash');
    expect(records(s)).toHaveLength(29);
    const result = await run(s);
    expect(result).toMatchObject({ status: 'prepared', bases: 30, recordedThisRun: 1 });
    const inspection = inspectJournal(journalPath(s), { header: inspectHeader(s), keys: s.bases });
    expect(inspection.status).toBe('valid');
  }, 120_000);
});

function inspectHeader(s: Setup) {
  return JSON.parse(readFileSync(journalPath(s), 'utf8').split('\n')[0]!);
}

/** The fixture's fake provider, which can be made to fail: on every call, or once. */
class SwitchableProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxInputChars: number;
  readonly inner: FakeEmbeddingProvider;
  failure: { make: () => Error; once: boolean } | null = null;

  constructor(inner: FakeEmbeddingProvider) {
    this.inner = inner;
    this.modelId = inner.modelId;
    this.dimensions = inner.dimensions;
    this.maxInputChars = inner.maxInputChars;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    const failure = this.failure;
    if (failure) {
      if (failure.once) this.failure = null;
      throw failure.make();
    }
    return this.inner.embed(texts);
  }
}

const outage = () => new EmbeddingProviderUnavailableError('Cannot reach Ollama at http://127.0.0.1:11434/api/embed', { cause: new TypeError('fetch failed') });

/** Stages that log their calls and switch the provider's failure on when `index`'s base is ingested. */
function failingFrom(s: Setup, provider: SwitchableProvider, index: number, failure: { make: () => Error; once: boolean }, log: string[]): PreparationStages {
  const stages = stagesWith(log);
  return {
    ...stages,
    ingest: async (db, repositoryId, base) => {
      if (base === s.bases[index]) provider.failure = failure;
      return stages.ingest(db, repositoryId, base);
    },
  };
}

function workingDatabaseIntegrity(s: Setup): string {
  const db = new DatabaseSync(databasePath(s));
  try {
    return (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((row) => row.integrity_check).join('; ');
  } finally {
    db.close();
  }
}

describe('an embedding-provider outage', () => {
  it('records the failure of the base it hit, stops before the next base, and freezes nothing', async () => {
    const s = setup();
    const provider = new SwitchableProvider(s.provider);
    const log: string[] = [];
    const result = await run(s, { stages: failingFrom(s, provider, 3, { make: outage, once: false }, log) }, { provider });

    expect(result).toMatchObject({ status: 'stopped', reason: 'provider-unavailable', recordedThisRun: 4 });
    expect((result as { detail: string }).detail).toContain('26 bases are left unrecorded');
    expect(records(s).map((r) => [r.base, r.status])).toEqual([...s.bases.slice(0, 3).map((base) => [base, 'succeeded']), [s.bases[3], 'failed']]);
    expect(records(s)[3]).toMatchObject({
      failures: [{ stage: 'semantic-index', errorName: 'Error', message: expect.stringContaining('Embedding failed') }],
      evidence: { snapshotId: expect.any(Number), excludedEntries: [{ path: 'assets/logo.png', reason: 'unsupported_type' }], providerUnavailable: true },
    });
    expect(readFileSync(journalPath(s), 'utf8').endsWith('\n')).toBe(true);
    expect(log.filter((line) => line.endsWith(s.bases[3]!))).toEqual(['ingest', 'indexLexically', 'indexStructurally', 'indexSemantically'].map((stage) => `${stage} ${s.bases[3]}`));
    expect(log.some((line) => s.bases.slice(4).some((base) => line.endsWith(base)))).toBe(false);
    expect(existsSync(frozenPath(s))).toBe(false);
    expect(lockPresent(s)).toBe(false);
    expect(workingDatabaseIntegrity(s)).toBe('ok');
    const journal = inspectJournal(journalPath(s), { header: inspectHeader(s), keys: s.bases });
    expect(journal.status === 'valid' && journal.journal.next).toBe(s.bases[4]);
  }, 120_000);

  it('resumes after the provider is back at the first unrecorded base, never rerunning recorded ones', async () => {
    const s = setup();
    const provider = new SwitchableProvider(s.provider);
    await run(s, { stages: failingFrom(s, provider, 3, { make: outage, once: false }, []) }, { provider });
    const recordedBefore = readFileSync(journalPath(s), 'utf8');

    provider.failure = null;
    const log: string[] = [];
    const result = await run(s, { stages: stagesWith(log) }, { provider });
    expect(result).toMatchObject({ status: 'prepared', bases: 30, succeeded: 29, failed: 1, recordedThisRun: 26 });
    expect(log[0]).toBe(`ingest ${s.bases[4]}`);
    expect(log.filter((line) => s.bases.slice(0, 4).some((base) => line.endsWith(base)))).toEqual([]);
    expect(log).toHaveLength(26 * 4);
    expect(readFileSync(journalPath(s), 'utf8').startsWith(recordedBefore)).toBe(true);
    expect(records(s).map((r) => r.base)).toEqual(s.bases);
    expect(existsSync(frozenPath(s))).toBe(true);
  }, 120_000);

  it.each([
    ['an ordinary provider error (HTTP 500)', () => new EmbeddingProviderError('Ollama request to http://x/api/embed failed (500): boom')],
    ['an error whose message only sounds like an outage', () => new Error('connect ECONNREFUSED 127.0.0.1:11434: Cannot reach Ollama')],
    ['an error that only carries the outage name', () => Object.assign(new Error('unavailable'), { name: 'EmbeddingProviderUnavailableError' })],
  ])('keeps going after %s, recording it as an ordinary failure', async (_label, make) => {
    const s = setup();
    const provider = new SwitchableProvider(s.provider);
    const log: string[] = [];
    const result = await run(s, { stages: failingFrom(s, provider, 3, { make, once: true }, log) }, { provider });
    expect(result).toMatchObject({ status: 'prepared', bases: 30, succeeded: 29, failed: 1, recordedThisRun: 30 });
    expect(records(s)[3]).toMatchObject({ status: 'failed', failures: [{ stage: 'semantic-index' }] });
    expect(records(s)[3]!.evidence).not.toHaveProperty('providerUnavailable');
    expect(log).toHaveLength(30 * 4);
  }, 120_000);

  it('does not treat an outage error outside semantic indexing as a provider outage', async () => {
    const s = setup();
    const stages = stagesWith([], (stage, base) => (stage === 'ingest' && base === s.bases[3] ? outage() : null));
    const result = await run(s, { stages });
    expect(result).toMatchObject({ status: 'prepared', failed: 1, recordedThisRun: 30 });
    expect(records(s)[3]).toMatchObject({ status: 'failed', failures: [{ stage: 'ingestion', errorName: 'EmbeddingProviderUnavailableError' }] });
  }, 120_000);

  it('records nothing for the base when the database is damaged, even during an outage', async () => {
    const s = setup();
    const provider = new SwitchableProvider(s.provider);
    const stages = failingFrom(s, provider, 3, { make: outage, once: false }, []);
    const damaging: PreparationStages = {
      ...stages,
      indexSemantically: async (db, id, p) => {
        if (provider.failure) {
          db.exec('PRAGMA foreign_keys = OFF');
          db.exec("INSERT INTO excluded_entry (snapshot_id, path, reason) VALUES (999, 'x', 'binary')");
          db.exec('PRAGMA foreign_keys = ON');
        }
        return stages.indexSemantically(db, id, p);
      },
    };
    const result = await run(s, { stages: damaging }, { provider });
    expect(result).toMatchObject({ status: 'stopped', reason: 'database-invalid', recordedThisRun: 3 });
    expect(records(s)).toHaveLength(3);
    expect(existsSync(frozenPath(s))).toBe(false);
    expect(lockPresent(s)).toBe(false);
  }, 120_000);

  it('records nothing when the lock is lost, and leaves the other lock alone', async () => {
    const s = setup();
    const provider = new SwitchableProvider(s.provider);
    const stages = failingFrom(s, provider, 3, { make: outage, once: false }, []);
    const foreign = `${JSON.stringify({ schema: 'tracebound.cochange.lock', version: 1, token: 'other', purpose: 'other', pid: 1, hostname: 'elsewhere.invalid', startedAt: '2026-10-15T00:00:00.000Z' })}\n`;
    const stealing: PreparationStages = {
      ...stages,
      indexSemantically: async (db, id, p) => {
        if (provider.failure) writeFileSync(join(s.work, LOCK_FILE), foreign);
        return stages.indexSemantically(db, id, p);
      },
    };
    const result = await run(s, { stages: stealing }, { provider });
    expect(result).toMatchObject({ status: 'stopped', reason: 'lock-lost', recordedThisRun: 3 });
    expect(records(s)).toHaveLength(3);
    expect(readFileSync(join(s.work, LOCK_FILE), 'utf8')).toBe(foreign);
    expect(existsSync(frozenPath(s))).toBe(false);
  }, 120_000);

  it('recognizes an outage only by its type, through the cause chain', () => {
    const wrapped = new Error('Embedding failed for a batch of 2 inputs', { cause: outage() });
    expect(causedByProviderOutage(outage())).toBe(true);
    expect(causedByProviderOutage(wrapped)).toBe(true);
    expect(causedByProviderOutage(new Error('outer', { cause: wrapped }))).toBe(true);
    expect(causedByProviderOutage(new EmbeddingProviderError('Cannot reach Ollama'))).toBe(false);
    expect(causedByProviderOutage(new Error('Cannot reach Ollama at http://x', { cause: new TypeError('fetch failed') }))).toBe(false);
    expect(causedByProviderOutage({ name: 'EmbeddingProviderUnavailableError' })).toBe(false);
    expect(causedByProviderOutage(undefined)).toBe(false);
    const cyclic = new Error('cyclic');
    (cyclic as { cause?: unknown }).cause = cyclic;
    expect(causedByProviderOutage(cyclic)).toBe(false);
  });
});

describe('the freeze identity', () => {
  const identityPath = (s: Setup) => join(s.work, FREEZE_IDENTITY_FILE);
  const tmpFiles = (s: Setup) => readdirSync(s.work).filter((name) => name.endsWith('.tmp'));

  it('publishes a canonical identity of the verified frozen database, bound to the run and the complete journal', async () => {
    const s = setup();
    const result = await run(s);
    if (result.status !== 'prepared') throw new Error(JSON.stringify(result));
    const bytes = readFileSync(identityPath(s));
    const parsed = parseFreezeIdentity(bytes);
    if (parsed.status !== 'ok') throw new Error(JSON.stringify(parsed));
    const identity = parsed.identity;
    const frozenBytes = readFileSync(frozenPath(s));

    expect(result.frozen).toMatchObject({ identityFile: 'frozen.identity.json', identitySha256: sha256Hex(bytes) });
    expect(identity.database).toMatchObject({
      file: 'frozen.sqlite',
      sha256: result.frozen.sha256,
      bytes: frozenBytes.length,
      userVersion: result.frozen.userVersion,
      journalMode: 'delete',
      integrityCheck: 'ok',
    });
    expect(identity.database.sha256).toBe(sha256Hex(frozenBytes));
    expect(identity.database.tables).toEqual(tableDigests(frozenPath(s)));
    expect(identity.database.tables).toHaveLength(result.frozen.tables);
    expect(identity.database).toMatchObject({ pageSize: checkDatabase(frozenPath(s)).pageSize, pageCount: checkDatabase(frozenPath(s)).pageCount });
    expect(identity.preparation).toEqual({ journalSha256: sha256Hex(readFileSync(journalPath(s))), bases: 30, succeeded: 30, failed: 0 });
    expect(identity).toMatchObject({
      protocolVersion: '1.0.0',
      manifestSha256: s.deps.registration!.manifestSha256,
      repository: { name: 'owner/repo', head: commits[31] },
      tracebound: { commit: s.tb.git('rev-parse', 'HEAD'), sourceClean: true },
      embeddingModelId: MODEL_ID,
    });

    // The file is exactly the canonical form of the identity, with no trailing newline, and holds no path.
    expect(bytes.equals(serializeFreezeIdentity(identity))).toBe(true);
    const text = bytes.toString('utf8');
    expect(text).not.toContain('\n');
    for (const forbidden of [s.work, tmpdir(), s.tb.path, got.path, 'C:\\', '\\\\']) expect(text, forbidden).not.toContain(forbidden);

    // The identity verifies, deeply, against the files it describes.
    const verification = await verifyFreezeIdentity(
      { identity: identityPath(s), database: frozenPath(s), preparationJournal: journalPath(s) },
      bindingsOf(identity),
      { deep: true },
    );
    expect(verification).toMatchObject({ status: 'verified', deep: true });
    expect(tmpFiles(s)).toEqual([]);
    expect(lockPresent(s)).toBe(false);
  }, 120_000);

  it('binds the same run identity for the same inputs, in two independent preparations', async () => {
    const a = setup();
    const b = setup();
    await run(a);
    await run(b);
    const first = parseFreezeIdentity(readFileSync(identityPath(a)));
    const second = parseFreezeIdentity(readFileSync(identityPath(b)));
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('invalid identity');
    // Everything but the checkout's own commit (each setup is a separate fixture checkout) and the database bytes
    // (the working database records creation times) is the same.
    const comparable = (i: typeof first.identity) => ({ ...bindingsOf(i), tracebound: { ...i.tracebound, commit: 'checkout' } });
    expect(comparable(first.identity)).toEqual(comparable(second.identity));
    expect(first.identity.preparation.bases).toBe(second.identity.preparation.bases);
    expect(first.identity.database.tables.map((t) => [t.name, t.rows])).toEqual(second.identity.database.tables.map((t) => [t.name, t.rows]));
  }, 240_000);

  it('refuses a frozen database without an identity after a crash between freezing and publishing, and never adopts it', async () => {
    const s = setup();
    await expect(run(s, { beforeIdentity: () => { throw new Error('simulated crash'); } })).rejects.toThrow('simulated crash');
    expect(existsSync(frozenPath(s))).toBe(true);
    expect(existsSync(identityPath(s))).toBe(false);
    expect(lockPresent(s)).toBe(false);
    const frozenBefore = readFileSync(frozenPath(s));
    const before = tree(s.work);

    const again = await run(s);
    expect(again).toMatchObject({
      status: 'refused',
      reason: 'frozen-database-without-identity',
      frozenInspection: { sha256: sha256Hex(frozenBefore), integrityCheck: 'ok', journalMode: 'delete', sameRowsAsWorkingDatabase: true, error: null },
    });
    expect((again as { detail: string }).detail).toContain('remove it by hand and run the preparation again');
    expect(tree(s.work)).toEqual(before);
    expect(existsSync(identityPath(s))).toBe(false);

    // The documented recovery: remove the frozen file by hand and prepare again; recorded bases are not run again.
    rmSync(frozenPath(s));
    const log: string[] = [];
    const recovered = await run(s, { stages: stagesWith(log) });
    expect(recovered).toMatchObject({ status: 'prepared', bases: 30, recordedThisRun: 0, frozen: { identityFile: 'frozen.identity.json' } });
    expect(log).toEqual([]);
    const parsed = parseFreezeIdentity(readFileSync(identityPath(s)));
    expect(parsed.status === 'ok' && parsed.identity.database.sha256).toBe(sha256Hex(readFileSync(frozenPath(s))));
  }, 240_000);

  it('leaves no half-published identity when the crash is at the link, and refuses the frozen database the same way', async () => {
    const s = setup();
    await expect(run(s, { beforeIdentityLink: () => { throw new Error('simulated crash'); } })).rejects.toThrow('simulated crash');
    expect(existsSync(identityPath(s))).toBe(false);
    expect(tmpFiles(s)).toEqual([]);
    expect(await run(s)).toMatchObject({ status: 'refused', reason: 'frozen-database-without-identity' });
  }, 120_000);

  it('refuses a frozen database nobody published, in a work directory with nothing else', async () => {
    const s = setup();
    mkdirSync(s.work);
    writeFileSync(frozenPath(s), 'not a database');
    const before = tree(s.work);
    expect(await run(s)).toMatchObject({ status: 'refused', reason: 'frozen-database-without-identity', frozenInspection: { sha256: sha256Hex('not a database'), sameRowsAsWorkingDatabase: null } });
    expect(tree(s.work)).toEqual(before);
    expect(existsSync(databasePath(s))).toBe(false);
  });

  it('refuses an identity without its database, and never replaces it', async () => {
    const s = setup();
    await run(s);
    const identity = readFileSync(identityPath(s));
    rmSync(frozenPath(s));
    const before = tree(s.work);
    expect(await run(s)).toMatchObject({ status: 'refused', reason: 'preflight', preflight: { problems: [{ code: 'freeze-identity-orphan' }] } });
    expect(tree(s.work)).toEqual(before);
    expect(readFileSync(identityPath(s)).equals(identity)).toBe(true);
  }, 120_000);

  it('stops, writing nothing, when the lock is lost while the identity is published', async () => {
    const s = setup();
    const foreign = `${JSON.stringify({ schema: 'tracebound.cochange.lock', version: 1, token: 'other', purpose: 'other', pid: 1, hostname: 'elsewhere.invalid', startedAt: '2026-10-15T00:00:00.000Z' })}\n`;
    const result = await run(s, { beforeIdentityLink: () => writeFileSync(join(s.work, LOCK_FILE), foreign) });
    expect(result).toMatchObject({ status: 'stopped', reason: 'lock-lost' });
    expect(existsSync(identityPath(s))).toBe(false);
    expect(tmpFiles(s)).toEqual([]);
    expect(readFileSync(join(s.work, LOCK_FILE), 'utf8')).toBe(foreign);
    expect(existsSync(frozenPath(s))).toBe(true);
  }, 120_000);

  it('never overwrites an identity that appeared meanwhile, and reports the preparation as not published', async () => {
    const s = setup();
    const result = await run(s, { beforeIdentityLink: () => writeFileSync(identityPath(s), 'someone else') });
    expect(result).toMatchObject({ status: 'stopped', reason: 'freeze-identity-not-published' });
    expect(readFileSync(identityPath(s), 'utf8')).toBe('someone else');
    expect(tmpFiles(s)).toEqual([]);
    expect(lockPresent(s)).toBe(false);
  }, 120_000);

  it('holds the lock while the identity is published', async () => {
    const s = setup();
    const held: boolean[] = [];
    await run(s, { beforeIdentityLink: () => held.push(lockPresent(s)) });
    expect(held).toEqual([true]);
    expect(lockPresent(s)).toBe(false);
  }, 120_000);
});
