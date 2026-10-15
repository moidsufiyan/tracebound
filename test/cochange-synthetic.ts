import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '../src/evaluation/m9/canonical.js';
import { createJournal, type EvaluationHeader, type EvaluationRecord, type PreparationHeader, type PreparationRecord } from '../src/evaluation/cochange/journal.js';
import { WORK_FILES, type Registration } from '../src/evaluation/cochange/preflight.js';
import { DESIGN_CASE_COMMITS, PROTOCOL, SELECTION_RULES, type CochangeManifest } from '../src/evaluation/cochange/selector.js';

// Synthetic manifests and journals for the results tests: 30 commits, no repository, no database,
// no provider. Commit i has input src/m{i}.ts and targets test/m{i}.test.ts, docs/m{i}.md when
// i % 3 = 0 and test/n{i}.test.ts when i % 5 = 0; test/m{i}.test.ts is linked when i is even.

export const N = 30;
const hex = (prefix: string, i: number) => `${prefix}${i.toString(16).padStart(39, '0')}`;
export const commitSha = (i: number) => hex('a', i);
export const baseSha = (i: number) => hex('b', i);
export const HEAD = hex('c', 0);

export function targetsOf(i: number) {
  return [
    ...(i % 3 === 0 ? [{ path: `docs/m${i}.md`, kind: 'doc' as const, status: 'modified' as const }] : []),
    { path: `test/m${i}.test.ts`, kind: 'test' as const, status: 'modified' as const },
    ...(i % 5 === 0 ? [{ path: `test/n${i}.test.ts`, kind: 'test' as const, status: 'modified' as const }] : []),
  ];
}
const linkedOf = (i: number) => (i % 2 === 0 ? [`test/m${i}.test.ts`] : []);

export function manifestValue(): CochangeManifest {
  return {
    schema: 'tracebound.cochange.manifest',
    schemaVersion: '1.0.0',
    protocol: PROTOCOL,
    repository: { name: 'owner/repo', head: HEAD, since: null },
    rules: SELECTION_RULES,
    exclusions: { designCaseCommits: [...DESIGN_CASE_COMMITS].sort() },
    counts: { reachable: 32, eligible: N, selected: N, rejected: { root: 1, merge: 0, design_case: 0, too_many_changes: 0, no_changes: 0, no_source_input: 1, no_target: 0 } },
    commits: Array.from({ length: N }, (_, i) => {
      const targets = targetsOf(i);
      const changes = [
        ...targets.map((t) => ({ status: 'modified' as const, path: t.path, previousPath: null, similarity: null, basePath: t.path, baseClass: t.kind })),
        { status: 'modified' as const, path: `src/m${i}.ts`, previousPath: null, similarity: null, basePath: `src/m${i}.ts`, baseClass: 'source' as const },
      ].sort((a, b) => (a.path < b.path ? -1 : 1));
      return { sha: commitSha(i), base: baseSha(i), subject: `change ${i}`, eligibleIndex: i, changes, inputs: [`src/m${i}.ts`], targets };
    }),
  };
}

export type Method = 'hybrid' | 'deterministic' | 'semantic' | 'sibling' | 'no-description';
const KEYS: Record<Method, string> = { hybrid: 'hybridPaths', deterministic: 'deterministicPaths', semantic: 'semanticPaths', sibling: 'siblingPaths', 'no-description': 'noDescriptionPaths' };
/** Where each method ranks commit i's k-th target (1-based), or null for not ranked. */
export type Placement = (method: Method, i: number, k: number) => number | null;

/** Hybrid finds every target first; the sibling heuristic never within 20. */
export const STRONG_HYBRID: Placement = (method, i, k) =>
  method === 'hybrid' ? k : method === 'deterministic' ? 3 + k : method === 'semantic' ? (i % 2 === 1 ? 2 + k : 11 + k) : method === 'sibling' ? 20 + k : 5 + k;
export const STRONG_SIBLING: Placement = (method, _i, k) => (method === 'sibling' ? k : method === 'hybrid' ? 20 + k : method === 'no-description' ? 5 + k : 3 + k);

function rankingOf(i: number, place: Placement, method: Method): string[] {
  const list = Array.from({ length: 30 }, (_, n) => `filler/f${n}.ts`);
  const targets = method === 'sibling' ? targetsOf(i).filter((t) => t.kind === 'test') : targetsOf(i);
  targets.forEach((t, k) => {
    const rank = place(method, i, k + 1);
    if (rank !== null) list.splice(rank - 1, 0, t.path);
  });
  return list;
}

export interface Scenario {
  place?: Placement;
  failures?: { i: number; methods: Method[]; stage: 'retrieval' | 'analysis' | 'preparation' }[];
  unprepared?: number[];
}

function evaluationRecord(i: number, scenario: Scenario): EvaluationRecord {
  const place = scenario.place ?? STRONG_HYBRID;
  const unprepared = scenario.unprepared?.includes(i) ?? false;
  const failed = new Map<Method, string>();
  for (const f of scenario.failures ?? []) if (f.i === i) for (const m of f.methods) failed.set(m, f.stage);
  const order: Method[] = ['hybrid', 'deterministic', 'semantic', 'sibling', 'no-description'];
  if (unprepared) for (const m of order) failed.set(m, 'preparation');
  const rankings = Object.fromEntries(order.filter((m) => !failed.has(m)).map((m) => [KEYS[m], rankingOf(i, place, m)]));
  return {
    kind: 'record',
    phase: 'evaluation',
    commit: commitSha(i),
    status: failed.size === 0 ? 'succeeded' : 'failed',
    // Raw messages carry machine paths on purpose: they must never reach the results.
    failures: order.filter((m) => failed.has(m)).map((m) => ({ method: m, stage: failed.get(m) as 'retrieval', errorName: 'Error', message: `C:\\machine\\path broke ${m}` })),
    evidence: {
      base: baseSha(i),
      snapshotId: unprepared ? null : i + 1,
      preparation: unprepared ? { status: 'failed', stage: 'ingestion' } : { status: 'succeeded' },
      query: { description: `change ${i}`, inputPaths: [`src/m${i}.ts`] },
      targets: targetsOf(i).map(({ path, kind }) => ({ path, kind })),
      ...(unprepared ? {} : { missingTargets: i === 4 ? [{ path: 'test/m4.test.ts', reason: 'binary' }] : [], linkedTargetPaths: linkedOf(i) }),
      rankings,
    },
  };
}

export interface Built {
  manifestPath: string;
  work: string;
  registration: Registration;
  header: EvaluationHeader;
}

/** Writes a manifest, a complete preparation journal, a frozen database file and an evaluation journal under `dir`. */
export function buildSynthetic(dir: string, scenario: Scenario = {}, options: { records?: number; preparationHeader?: Partial<PreparationHeader> } = {}): Built {
  const manifest = manifestValue();
  const bytes = Buffer.from(canonicalJson(manifest), 'utf8');
  const manifestPath = join(dir, 'manifest.json');
  const work = join(dir, 'work');
  writeFileSync(manifestPath, bytes);
  const registration: Registration = { manifestSha256: sha256Hex(bytes), repositoryName: 'owner/repo', head: HEAD, since: null, embeddingModel: 'nomic-embed-text:v1.5' };
  mkdirSync(work);
  writeFileSync(join(work, WORK_FILES.frozenDatabase), 'frozen database bytes');
  const common = {
    kind: 'header' as const,
    schema: 'tracebound.cochange.journal' as const,
    schemaVersion: '1.0.0' as const,
    protocolVersion: '1.0.0',
    manifestSha256: registration.manifestSha256,
    repository: { name: 'owner/repo', head: HEAD },
    tracebound: { commit: 'e'.repeat(40), sourceClean: true, buildSha256: 'b'.repeat(64) },
    nodeVersion: 'v24.20.0',
    embeddingModelId: 'ollama:nomic-embed-text:v1.5@0a109f422b47',
  };
  const header: EvaluationHeader = { ...common, phase: 'evaluation', frozenDatabaseSha256: sha256Hex('frozen database bytes') };
  const preparation = createJournal(join(work, WORK_FILES.preparationJournal), {
    header: { ...common, phase: 'preparation', ...options.preparationHeader } as PreparationHeader,
    keys: manifest.commits.map((c) => c.base),
  });
  manifest.commits.forEach((c, i) => {
    const unprepared = scenario.unprepared?.includes(i) ?? false;
    const record: PreparationRecord = unprepared
      ? { kind: 'record', phase: 'preparation', base: c.base, status: 'failed', failures: [{ stage: 'ingestion', errorName: 'Error', message: 'tree unreadable' }], evidence: { snapshotId: null } }
      : { kind: 'record', phase: 'preparation', base: c.base, status: 'succeeded', failures: [], evidence: { snapshotId: i + 1 } };
    preparation.append(record);
  });
  const evaluation = createJournal(join(work, WORK_FILES.evaluationJournal), { header, keys: manifest.commits.map((c) => c.sha) });
  for (let i = 0; i < (options.records ?? N); i += 1) evaluation.append(evaluationRecord(i, scenario));
  return { manifestPath, work, registration, header };
}
