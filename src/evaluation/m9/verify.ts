import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { annotationSection, IDENTITY_SCOPE, SCHEMAS, type JsonObject } from './artifacts.js';
import { canonicalBytes, digestOf, sha256Hex } from './canonical.js';
import { checkDatabase, fileIdentity, tableDigests } from './freeze-database.js';

// The offline verifier: it needs only the release directory (the frozen database, the candidate
// manifest, packages, rankings, review packets and the release manifest). It does not start
// Ollama, run retrieval or reasoning, or open any Git repository, and it opens the database
// read-only. A digest or hash shows the files are the recorded bytes, not who recorded them.

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerificationReport {
  ok: boolean;
  manifestDigest: string | null;
  /** The distribution status the manifest records; the verifier reports it but does not set it. */
  distributionStatus: string | null;
  checks: Check[];
}

interface ManifestFile {
  role: 'candidate-manifest' | 'evidence-package' | 'production-ranking' | 'review-packet';
  caseId: string | null;
  path: string;
  bytes: number;
  fileSha256: string;
  digest: string;
}

interface FrozenCandidateRecord {
  position: number;
  artifactId: number;
  versionId: number;
  path: string;
  kind: string;
  contentSha256: string;
  gitBlobSha: string;
  fusedRank: number;
  eligibleRank: number;
}

interface CaseRecord {
  caseId: string;
  snapshot: { id: number; baseCommitSha: string };
  changedPaths: string[];
  changedPathFusedRanks: { path: string; rank: number }[];
  rankedCandidateCount: number;
  candidates: FrozenCandidateRecord[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const PACKET_KEYS = ['schema', 'schemaVersion', 'identityScope', 'derivedFrom', 'case', 'baseCommitSha', 'instructions', 'candidates', 'annotationContract', 'reviewWorkflow', 'annotationTemplates'];
const ABSOLUTE_PATH_TEXT = /(^|[\s"'(=])([A-Za-z]:[\\/]|\/(Users|home|tmp|var|private)\/|\\\\)/;
/** Keys that must never appear in a reviewer packet: model output, model metadata, labels. */
const FORBIDDEN_PACKET_KEYS = new Set([
  'reasoningModel',
  'reasoningModelId',
  'classification', // only allowed inside the blank annotation templates
  'relevance',
  'labeled_by',
  'labelConfidence',
  'label',
  'impactReport',
  'findings',
  'diff',
  'patch',
]);

export function findLeakedKeys(value: unknown): string[] {
  return leakedKeys(value);
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Verifies the release at `releaseDir`; never throws for a content problem, which becomes a failed check. */
export async function verifyRelease(releaseDir: string, options: { expectedManifestDigest?: string } = {}): Promise<VerificationReport> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string): boolean => {
    checks.push({ name, ok, ...(detail !== undefined && !ok ? { detail } : {}) });
    return ok;
  };
  let manifestDigest: string | null = null;
  let distributionStatus: string | null = null;
  try {
    manifestDigest = await verifyInto(releaseDir, options, check);
    const recorded = (readJson(join(releaseDir, 'release-manifest.json')) as { distribution?: { status?: string } }).distribution?.status;
    distributionStatus = recorded ?? null;
    check('release manifest records a distribution status', recorded === 'RELEASED' || recorded === 'BLOCKED', String(recorded));
  } catch (error) {
    check('verification completed', false, error instanceof Error ? error.message : String(error));
  }
  return { ok: checks.every((entry) => entry.ok), manifestDigest, distributionStatus, checks };
}

async function verifyInto(
  releaseDir: string,
  options: { expectedManifestDigest?: string },
  check: (name: string, ok: boolean, detail?: string) => boolean,
): Promise<string | null> {
  // 1. The release manifest.
  const manifestPath = join(releaseDir, 'release-manifest.json');
  if (!check('release manifest exists', existsSync(manifestPath), manifestPath)) return null;
  const manifest = readJson(manifestPath) as JsonObject & {
    files: ManifestFile[];
    database: { path: string; bytes: number; sha256: string; userVersion: number; journalMode: string; tables: { name: string; rows: number; sha256: string }[] };
    candidateManifestDigest: string;
  };
  const manifestDigest = digestOf(manifest);
  check('release manifest schema', manifest.schema === SCHEMAS.releaseManifest);
  const recorded = existsSync(join(releaseDir, 'release-manifest.sha256')) ? readFileSync(join(releaseDir, 'release-manifest.sha256'), 'utf8').trim() : null;
  check('release manifest digest matches its .sha256 file', recorded === manifestDigest, `recorded ${recorded}, computed ${manifestDigest}`);
  if (options.expectedManifestDigest !== undefined) {
    check('release manifest digest matches the expected digest', options.expectedManifestDigest === manifestDigest);
  }

  // 2. Every listed file: bytes, file hash, canonical digest, schema.
  const parsed = new Map<string, JsonObject>();
  for (const file of manifest.files) {
    const path = join(releaseDir, file.path);
    if (!check(`${file.path} exists`, existsSync(path))) continue;
    const identity = await fileIdentity(path);
    check(`${file.path} size`, identity.bytes === file.bytes, `${identity.bytes} != ${file.bytes}`);
    check(`${file.path} file SHA-256`, identity.sha256 === file.fileSha256);
    const value = readJson(path) as JsonObject;
    check(`${file.path} canonical digest`, digestOf(value) === file.digest);
    check(`${file.path} is canonical JSON`, Buffer.compare(readFileSync(path), canonicalBytes(value)) === 0);
    check(`${file.path} has no absolute paths`, !containsAbsolutePath(value), 'a string value looks like an absolute path');
    parsed.set(file.path, value);
  }
  const byRole = (role: ManifestFile['role'], caseId: string | null): { file: ManifestFile; value: JsonObject } | undefined => {
    const file = manifest.files.find((entry) => entry.role === role && entry.caseId === caseId);
    const value = file && parsed.get(file.path);
    return file && value ? { file, value } : undefined;
  };

  const reconciliation = (manifest as JsonObject & { reconciliation?: { unchanged: { databaseSha256: string; evidencePackageDigests: Record<string, string> } } }).reconciliation;
  if (reconciliation) {
    check('reconciliation left the database hash as recorded', reconciliation.unchanged.databaseSha256 === manifest.database.sha256);
    check(
      'reconciliation left every evidence package digest as recorded',
      manifest.files.filter((file) => file.role === 'evidence-package').every((file) => file.caseId !== null && reconciliation.unchanged.evidencePackageDigests[file.caseId] === file.digest),
    );
  }

  // 3. The frozen database.
  const dbPath = join(releaseDir, manifest.database.path);
  const database = existsSync(dbPath) ? await fileIdentity(dbPath) : null;
  if (!check('frozen database exists', database !== null, dbPath) || database === null) return manifestDigest;
  check('frozen database size', database.bytes === manifest.database.bytes);
  check('frozen database SHA-256', database.sha256 === manifest.database.sha256);
  check('no sidecar files next to the frozen database', !existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`));
  const state = checkDatabase(dbPath);
  check('database integrity_check', state.integrityCheck === 'ok', state.integrityCheck);
  check('database foreign_key_check', state.foreignKeyViolations === 0, String(state.foreignKeyViolations));
  check('database schema version', state.userVersion === manifest.database.userVersion, String(state.userVersion));
  check('database journal mode', state.journalMode === manifest.database.journalMode, state.journalMode);
  const tables = tableDigests(dbPath);
  const sameTables =
    tables.length === manifest.database.tables.length &&
    tables.every((table, index) => {
      const expected = manifest.database.tables[index];
      return expected !== undefined && expected.name === table.name && expected.rows === table.rows && expected.sha256 === table.sha256;
    });
  check('database per-table digests', sameTables);

  // 4. Candidate manifest and the identities it freezes.
  const candidateManifest = byRole('candidate-manifest', null);
  if (!check('candidate manifest listed', candidateManifest !== undefined) || candidateManifest === undefined) return manifestDigest;
  check('candidate manifest digest recorded', candidateManifest.file.digest === manifest.candidateManifestDigest);
  const frozenCases = (candidateManifest.value as unknown as { cases: CaseRecord[] }).cases;
  check('every case freezes exactly three candidates', frozenCases.length > 0 && frozenCases.every((entry) => entry.candidates.length === 3));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const frozen of frozenCases) {
      const id = frozen.caseId;
      const snapshot = db.prepare('SELECT commit_sha, status FROM repository_snapshot WHERE id = ?').get(frozen.snapshot.id) as
        | { commit_sha: string; status: string }
        | undefined;
      check(`${id} snapshot is ready at the recorded commit`, snapshot?.status === 'ready' && snapshot.commit_sha === frozen.snapshot.baseCommitSha);
      for (const candidate of frozen.candidates) {
        const row = db
          .prepare(
            `SELECT v.artifact_id, v.snapshot_id, a.path, a.kind, v.content_sha256, v.git_blob_sha, c.text
             FROM artifact_version v JOIN artifact a ON a.id = v.artifact_id LEFT JOIN content c ON c.sha256 = v.content_sha256
             WHERE v.id = ?`,
          )
          .get(candidate.versionId) as
          | { artifact_id: number; snapshot_id: number; path: string; kind: string; content_sha256: string; git_blob_sha: string; text: string | null }
          | undefined;
        const identityOk =
          row !== undefined &&
          row.snapshot_id === frozen.snapshot.id &&
          row.artifact_id === candidate.artifactId &&
          row.path === candidate.path &&
          row.kind === candidate.kind &&
          row.content_sha256 === candidate.contentSha256 &&
          row.git_blob_sha === candidate.gitBlobSha;
        check(`${id} #${candidate.position} ${candidate.path} identity`, identityOk);
        check(`${id} #${candidate.position} content hash`, row?.text != null && sha256Hex(row.text) === candidate.contentSha256);
      }
    }
  } finally {
    db.close();
  }

  // 5. Packages, rankings and packets, per case.
  for (const frozen of frozenCases) {
    const id = frozen.caseId;
    const pkg = byRole('evidence-package', id);
    const ranking = byRole('production-ranking', id);
    const packet = byRole('review-packet', id);
    if (!check(`${id} package, ranking and packet listed`, pkg !== undefined && ranking !== undefined && packet !== undefined)) continue;
    if (pkg === undefined || ranking === undefined || packet === undefined) continue;
    verifyPackage(id, frozen, pkg.value, check);
    verifyRanking(id, frozen, ranking.value, check);
    verifyPacket(id, frozen, pkg.value, packet, candidateManifest.file.digest, pkg.file.digest, check);
  }
  return manifestDigest;
}

type Reporter = (name: string, ok: boolean, detail?: string) => boolean;

interface PackageCandidate {
  rank: number;
  artifactId: number;
  versionId: number;
  path: string;
  kind: string;
  contentSha256: string;
  gitBlobSha: string;
  evidence: { id: string; type: string; fusedRank?: number; k?: number }[];
}

function verifyPackage(id: string, frozen: CaseRecord, value: JsonObject, check: Reporter): void {
  const pkg = value as unknown as {
    schema: string;
    identityScope: string;
    case: { id: string; changedPaths: string[]; evaluationCutoff: string };
    snapshot: { id: number; baseCommitSha: string; committedAt: string; recordedAt: string };
    retrieval: { rrfK: number; rankedCandidateCount: number; evidenceLimit: number };
    candidates: PackageCandidate[];
  };
  check(`${id} package schema`, pkg.schema === SCHEMAS.evidencePackage && pkg.identityScope === IDENTITY_SCOPE);
  check(`${id} package case and snapshot`, pkg.case.id === id && pkg.snapshot.id === frozen.snapshot.id && pkg.snapshot.baseCommitSha === frozen.snapshot.baseCommitSha);
  // The commit time (not the later ingestion time) is what must not follow the evaluation cutoff.
  check(`${id} snapshot was committed at or before the evaluation cutoff`, pkg.snapshot.committedAt <= pkg.case.evaluationCutoff, `${pkg.snapshot.committedAt} > ${pkg.case.evaluationCutoff}`);
  check(`${id} package RRF K`, pkg.retrieval.rrfK === 60);
  check(`${id} package ranked count`, pkg.retrieval.rankedCandidateCount === frozen.rankedCandidateCount);
  check(`${id} package is complete up to its limit`, pkg.candidates.length === Math.min(pkg.retrieval.evidenceLimit, pkg.retrieval.rankedCandidateCount - frozen.changedPathFusedRanks.length));
  const changed = new Set(pkg.case.changedPaths);
  check(`${id} package has no changed path as a candidate`, pkg.candidates.every((candidate) => !changed.has(candidate.path)));
  check(
    `${id} package candidates are in increasing fused rank`,
    pkg.candidates.every((candidate, index) => index === 0 || (pkg.candidates[index - 1] as PackageCandidate).rank < candidate.rank),
  );
  const ids = new Set<string>();
  let evidenceOk = true;
  for (const candidate of pkg.candidates) {
    const fusion = candidate.evidence.find((item) => item.type === 'fusion');
    if (!fusion || fusion.fusedRank !== candidate.rank || fusion.k !== pkg.retrieval.rrfK) evidenceOk = false;
    for (const item of candidate.evidence) {
      // Evidence ids embed version ids: `kind:V`, `structural:signal:SOURCE>TARGET`, `semantic:V:model:chunk`.
      const names = new RegExp(`(^|[:>])${candidate.versionId}($|[:>])`).test(item.id);
      if (!SHA256.test(candidate.contentSha256) || ids.has(item.id) || !names) evidenceOk = false;
      ids.add(item.id);
    }
  }
  check(`${id} evidence ids are unique, belong to their candidate and carry its fused rank`, evidenceOk);
  for (const selected of frozen.candidates) {
    const index = pkg.candidates.findIndex((candidate) => candidate.versionId === selected.versionId);
    const found = pkg.candidates[index];
    check(
      `${id} #${selected.position} ${selected.path} is in the package at the frozen ranks`,
      found !== undefined &&
        found.path === selected.path &&
        found.artifactId === selected.artifactId &&
        found.contentSha256 === selected.contentSha256 &&
        found.gitBlobSha === selected.gitBlobSha &&
        found.rank === selected.fusedRank &&
        index + 1 === selected.eligibleRank,
    );
  }
}

function verifyRanking(id: string, frozen: CaseRecord, value: JsonObject, check: Reporter): void {
  const ranking = value as unknown as {
    schema: string;
    rrfK: number;
    rankedCandidateCount: number;
    ranking: { rank: number; eligibleRank: number | null; versionId: number; path: string }[];
  };
  check(`${id} ranking schema and size`, ranking.schema === SCHEMAS.productionRanking && ranking.ranking.length === ranking.rankedCandidateCount && ranking.rrfK === 60);
  check(`${id} ranking count matches the frozen case`, ranking.rankedCandidateCount === frozen.rankedCandidateCount);
  const changed = new Set(frozen.changedPaths);
  let eligible = 0;
  const consistent = ranking.ranking.every((entry, index) => {
    const isChanged = changed.has(entry.path);
    if (!isChanged) eligible += 1;
    return entry.rank === index + 1 && entry.eligibleRank === (isChanged ? null : eligible);
  });
  check(`${id} ranking ranks and eligible ranks are consistent`, consistent);
  for (const selected of frozen.candidates) {
    const entry = ranking.ranking[selected.fusedRank - 1];
    check(
      `${id} #${selected.position} frozen ranks appear in the full ranking`,
      entry !== undefined && entry.versionId === selected.versionId && entry.rank === selected.fusedRank && entry.eligibleRank === selected.eligibleRank,
    );
  }
}

function verifyPacket(
  id: string,
  frozen: CaseRecord,
  pkgValue: JsonObject,
  packet: { file: ManifestFile; value: JsonObject },
  candidateManifestDigest: string,
  packageDigest: string,
  check: Reporter,
): void {
  const value = packet.value as unknown as {
    schema: string;
    derivedFrom: { evidencePackageDigest: string; candidateManifestDigest: string };
    case: { id: string; changedPaths: string[]; description: string; evaluationCutoff: string };
    baseCommitSha: string;
    candidates: { versionId: number; path: string; contentSha256: string; source: { text: string }; evidence: unknown[] }[];
  };
  const pkg = pkgValue as unknown as { case: { changedPaths: string[]; description: string; evaluationCutoff: string }; candidates: PackageCandidate[] };
  check(`${id} packet schema`, value.schema === SCHEMAS.reviewPacket);
  check(`${id} packet is derived from this package and manifest`, value.derivedFrom.evidencePackageDigest === packageDigest && value.derivedFrom.candidateManifestDigest === candidateManifestDigest);
  check(`${id} packet has exactly three candidates`, value.candidates.length === 3);
  check(`${id} packet states the change, cutoff and base commit`, value.case.description === pkg.case.description && value.case.evaluationCutoff === pkg.case.evaluationCutoff && value.baseCommitSha === frozen.snapshot.baseCommitSha && JSON.stringify(value.case.changedPaths) === JSON.stringify(pkg.case.changedPaths));
  let faithful = value.candidates.length === frozen.candidates.length;
  for (const [index, selected] of frozen.candidates.entries()) {
    const candidate = value.candidates[index];
    const packaged = pkg.candidates.find((entry) => entry.versionId === selected.versionId);
    if (!candidate || !packaged) {
      faithful = false;
      continue;
    }
    if (candidate.versionId !== selected.versionId || candidate.path !== selected.path || sha256Hex(candidate.source.text) !== selected.contentSha256) faithful = false;
    if (digestOf(candidate.evidence) !== digestOf(packaged.evidence)) faithful = false;
  }
  check(`${id} packet candidates, source hashes and evidence match the package`, faithful);
  // The annotation contract and the blank per-candidate records (schema 1.1.0) must be exactly what the
  // frozen identities produce: nothing missing, renamed, extra or pre-filled.
  const expectedAnnotation = annotationSection({
    caseId: id,
    snapshotId: frozen.snapshot.id,
    baseCommitSha: frozen.snapshot.baseCommitSha,
    candidates: frozen.candidates,
  });
  const actual = packet.value as JsonObject;
  for (const key of Object.keys(expectedAnnotation)) {
    check(`${id} packet ${key} matches the authoritative annotation schema`, digestOf(actual[key]) === digestOf(expectedAnnotation[key]));
  }
  check(
    `${id} packet has exactly the expected sections`,
    JSON.stringify(Object.keys(actual).sort()) === JSON.stringify([...PACKET_KEYS].sort()),
    Object.keys(actual).join(','),
  );
  check(`${id} packet has one blank annotation record per frozen candidate`, Array.isArray(actual['annotationTemplates']) && (actual['annotationTemplates'] as unknown[]).length === 3);
  const leaked = leakedKeys(value as unknown as JsonObject);
  check(`${id} packet carries no reasoning output, model metadata or labels`, leaked.length === 0, leaked.join(', '));
  void packet.file;
}

function leakedKeys(value: unknown, inForm = false, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) leakedKeys(item, inForm, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const form = inForm || key === 'annotationTemplates';
      if (FORBIDDEN_PACKET_KEYS.has(key) && !(form && key === 'classification')) found.push(key);
      leakedKeys(child, form, found);
    }
  }
  return found;
}

function containsAbsolutePath(value: unknown): boolean {
  if (typeof value === 'string') return ABSOLUTE_PATH_TEXT.test(value) && !value.includes('\n');
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsAbsolutePath);
  return false;
}
