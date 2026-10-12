import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildReviewPacket, type FrozenCase, type JsonObject } from './artifacts.js';
import { canonicalBytes, digestOf } from './canonical.js';
import { fileIdentity } from './freeze-database.js';
import { readJson, verifyRelease, type VerificationReport } from './verify.js';

export const GATE_CONDITIONS = [
  'the annotation records conform to schema 1.1.0 and are pre-populated from the frozen identities',
  'every review packet holds exactly the three frozen candidates, their own evidence and no model output, label or other annotator',
  'every package, ranking, packet and manifest digest verifies, and the frozen database hash is the recorded one',
  'the offline verifier passes every check',
] as const;

interface ManifestFileEntry {
  role: string;
  caseId: string | null;
  path: string;
  bytes: number;
  fileSha256: string;
  digest: string;
}
type Manifest = JsonObject & { files: ManifestFileEntry[]; database: { path: string; sha256: string } };

function writeManifest(releaseDir: string, manifest: JsonObject): string {
  const digest = digestOf(manifest);
  writeFileSync(join(releaseDir, 'release-manifest.json'), canonicalBytes(manifest));
  writeFileSync(join(releaseDir, 'release-manifest.sha256'), `${digest}\n`);
  return digest;
}

/**
 * Decides the distribution status from the verifier and records it in the manifest. The status is
 * RELEASED only if the verifier passes the manifest as written; any failure records BLOCKED with the
 * failed checks. The status is part of the manifest payload, so it is covered by the manifest digest.
 */
export async function applyReleaseGate(releaseDir: string, gatedAt: string): Promise<{ status: 'RELEASED' | 'BLOCKED'; manifestDigest: string; report: VerificationReport }> {
  const manifest = readJson(join(releaseDir, 'release-manifest.json')) as Manifest;

  writeManifest(releaseDir, { ...manifest, distribution: { status: 'BLOCKED', reason: 'verification pending' } });
  const draft = await verifyRelease(releaseDir);
  if (!draft.ok) {
    const failed = draft.checks.filter((check) => !check.ok).map((check) => check.name);
    const manifestDigest = writeManifest(releaseDir, { ...manifest, distribution: { status: 'BLOCKED', gatedAt, reason: 'verification failed', failedChecks: failed } });
    return { status: 'BLOCKED', manifestDigest, report: await verifyRelease(releaseDir) };
  }

  const released = { ...manifest, distribution: { status: 'RELEASED', gatedAt, conditions: [...GATE_CONDITIONS] } };
  const manifestDigest = writeManifest(releaseDir, released);
  const final = await verifyRelease(releaseDir, { expectedManifestDigest: manifestDigest });
  if (final.ok) return { status: 'RELEASED', manifestDigest, report: final };
  const failed = final.checks.filter((check) => !check.ok).map((check) => check.name);
  const blockedDigest = writeManifest(releaseDir, { ...manifest, distribution: { status: 'BLOCKED', gatedAt, reason: 'verification failed', failedChecks: failed } });
  return { status: 'BLOCKED', manifestDigest: blockedDigest, report: final };
}

export interface ReconciliationResult {
  previousManifestDigest: string;
  manifestDigest: string;
  status: 'RELEASED' | 'BLOCKED';
  packets: { caseId: string; before: string; after: string }[];
  unchanged: { databaseSha256: string; packageDigests: Record<string, string> };
  report: VerificationReport;
}

/**
 * Rebuilds only the review packets of an existing release from its own frozen database and evidence
 * packages (read-only; nothing is retrieved, embedded or reasoned), replaces them and their manifest
 * entries, and runs the gate. The database and the evidence packages are checked unchanged and are
 * never rewritten. The replaced packets and manifest are kept under `superseded/`.
 */
export async function reconcilePackets(releaseDir: string, reconciledAt: string, reason: string): Promise<ReconciliationResult> {
  const manifestPath = join(releaseDir, 'release-manifest.json');
  const manifest = readJson(manifestPath) as Manifest;
  const previousManifestDigest = digestOf(manifest);
  const candidateEntry = manifest.files.find((file) => file.role === 'candidate-manifest');
  if (!candidateEntry) throw new Error('The release has no candidate manifest');
  const candidateManifest = readJson(join(releaseDir, candidateEntry.path)) as JsonObject & { cases: { caseId: string; snapshot: { id: number; baseCommitSha: string }; candidates: FrozenCase['candidates'] }[] };
  if (digestOf(candidateManifest) !== candidateEntry.digest) throw new Error('The candidate manifest does not match its recorded digest');

  const databasePath = join(releaseDir, manifest.database.path);
  const database = await fileIdentity(databasePath);
  if (database.sha256 !== manifest.database.sha256) throw new Error('The frozen database does not match its recorded hash; refusing to reconcile');

  const archive = join(releaseDir, 'superseded', previousManifestDigest.slice(0, 12));
  if (existsSync(archive)) throw new Error(`${archive} already exists`);
  mkdirSync(join(archive, 'review-packets'), { recursive: true });

  const db = new DatabaseSync(databasePath, { readOnly: true });
  const rebuilt: { entry: ManifestFileEntry; value: JsonObject; before: string }[] = [];
  const packageDigests: Record<string, string> = {};
  try {
    for (const frozenCase of candidateManifest.cases) {
      const packageEntry = manifest.files.find((file) => file.role === 'evidence-package' && file.caseId === frozenCase.caseId);
      const packetEntry = manifest.files.find((file) => file.role === 'review-packet' && file.caseId === frozenCase.caseId);
      if (!packageEntry || !packetEntry) throw new Error(`${frozenCase.caseId} lacks a package or packet entry`);
      const evidencePackage = readJson(join(releaseDir, packageEntry.path)) as JsonObject;
      if (digestOf(evidencePackage) !== packageEntry.digest) throw new Error(`${packageEntry.path} does not match its recorded digest`);
      packageDigests[frozenCase.caseId] = packageEntry.digest;
      const value = buildReviewPacket({
        db,
        evidencePackage,
        evidencePackageDigest: packageEntry.digest,
        candidateManifestDigest: candidateEntry.digest,
        frozen: { caseId: frozenCase.caseId, snapshotId: frozenCase.snapshot.id, baseCommitSha: frozenCase.snapshot.baseCommitSha, candidates: frozenCase.candidates },
      });
      rebuilt.push({ entry: packetEntry, value, before: packetEntry.digest });
    }
  } finally {
    db.close();
  }

  cpSync(manifestPath, join(archive, 'release-manifest.json'));
  cpSync(join(releaseDir, 'release-manifest.sha256'), join(archive, 'release-manifest.sha256'));
  for (const { entry, value } of rebuilt) {
    cpSync(join(releaseDir, entry.path), join(archive, entry.path));
    rmSync(join(releaseDir, entry.path));
    writeFileSync(join(releaseDir, entry.path), canonicalBytes(value));
    const identity = await fileIdentity(join(releaseDir, entry.path));
    entry.bytes = identity.bytes;
    entry.fileSha256 = identity.sha256;
    entry.digest = digestOf(value);
  }

  const after = await fileIdentity(databasePath);
  if (after.sha256 !== database.sha256) throw new Error('The frozen database changed during reconciliation');
  const updated: Manifest = {
    ...manifest,
    reconciliation: {
      reconciledAt,
      reason,
      replaced: 'review packets only',
      previousManifestDigest,
      previousPacketDigests: Object.fromEntries(rebuilt.map(({ entry, before }) => [entry.caseId as string, before])),
      archivedUnder: `superseded/${previousManifestDigest.slice(0, 12)}`,
      unchanged: { databaseSha256: database.sha256, evidencePackageDigests: packageDigests },
    },
  };
  writeManifest(releaseDir, updated);

  const gate = await applyReleaseGate(releaseDir, reconciledAt);
  return {
    previousManifestDigest,
    manifestDigest: gate.manifestDigest,
    status: gate.status,
    packets: rebuilt.map(({ entry, before }) => ({ caseId: entry.caseId as string, before, after: entry.digest })),
    unchanged: { databaseSha256: database.sha256, packageDigests },
    report: gate.report,
  };
}
