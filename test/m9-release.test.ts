import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexSnapshotStructurally } from '../src/analysis/structural-index.js';
import { findArtifactAtSnapshot } from '../src/artifacts/artifacts.js';
import { openDatabase } from '../src/db/database.js';
import {
  buildEvidencePackage,
  buildProductionRanking,
  buildReviewPacket,
  caseSpecFromParsed,
  rankingEntries,
  type CaseSpec,
  type EvidenceRunProvenance,
  type FrozenCase,
  type JsonObject,
  type RunContext,
} from '../src/evaluation/m9/artifacts.js';
import { buildAnnotationTemplate, type AnnotationRecord } from '../src/evaluation/m9/annotation.js';
import { canonicalBytes, digestOf } from '../src/evaluation/m9/canonical.js';
import { fileIdentity, freezeDatabase, tableDigests } from '../src/evaluation/m9/freeze-database.js';
import { writeRelease } from '../src/evaluation/m9/release.js';
import { applyReleaseGate, reconcilePackets } from '../src/evaluation/m9/gate.js';
import { findLeakedKeys, verifyRelease } from '../src/evaluation/m9/verify.js';
import { ingestSnapshot } from '../src/ingestion/ingest-snapshot.js';
import { createProject, registerRepository } from '../src/projects/projects.js';
import { constructEvidence } from '../src/retrieval/evidence.js';
import { searchHybridDetailed } from '../src/retrieval/hybrid-search.js';
import { indexSnapshotLexically } from '../src/retrieval/lexical-index.js';
import { indexSnapshotSemantically } from '../src/semantic/semantic-index.js';
import { FakeEmbeddingProvider } from './fake-embedding-provider.js';
import { FixtureRepo } from './git-fixture.js';

const FILES: Record<string, string> = {
  'src/billing.ts': `import { post } from './ledger';\nimport type { Money } from "./money";\nexport const billing = post;\n`,
  'src/ledger.ts': `export const post = 1;\n`,
  'src/money.ts': `export type Money = number;\n`,
  'src/invoice.ts': `import {\n  billing,\n} from './billing';\nexport const invoice = billing;\n`,
  'src/billing.test.ts': `import { billing } from './billing.js';\nexport const check = billing;\n`,
  'docs/refunds.md': `A refund is posted to the billing ledger.\n`,
  'docs/other.md': `Nothing to do with it.\n`,
};
const SPEC: CaseSpec = {
  caseId: 'TB-TEST',
  repositoryName: 'r',
  description: 'fix refund billing',
  changedPaths: ['src/billing.ts'],
  symbols: [],
  evaluationCutoff: '2999-01-01T00:00:00.000Z',
};
const VOCABULARY = ['billing', 'ledger', 'refund', 'invoice', 'money'];

let dir: string;
let release: string;
let provider: FakeEmbeddingProvider;
let snapshotId: number;
let baseCommitSha: string;
let fixture: FixtureRepo;
let build: () => Promise<{ frozenCase: FrozenCase; candidateManifest: JsonObject; evidencePackage: JsonObject; ranking: JsonObject; packet: JsonObject }>;
let manifestDigest: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tracebound-m9-release-'));
  release = join(dir, 'release');
  provider = new FakeEmbeddingProvider(VOCABULARY);
  fixture = new FixtureRepo();

  // The "source" database, populated and indexed the normal way.
  const sourcePath = join(dir, 'source.sqlite');
  const source = openDatabase(sourcePath);
  const project = createProject(source, 'p');
  const repository = await registerRepository(source, { projectId: project.id, name: 'r', sourcePath: fixture.path });
  baseCommitSha = fixture.commit(FILES);
  snapshotId = (await ingestSnapshot(source, repository.id, baseCommitSha)).snapshot.id;
  indexSnapshotLexically(source, snapshotId);
  indexSnapshotStructurally(source, snapshotId);
  await indexSnapshotSemantically(source, snapshotId, provider);
  source.close();

  const frozen = await freezeDatabase(sourcePath, join(dir, 'frozen.sqlite'));
  const sourceIdentity = await fileIdentity(sourcePath);
  const provenance: EvidenceRunProvenance = {
    runId: 'test-run',
    generatedAt: '2026-10-12T00:00:00.000Z',
    runKind: 'new-evidence-generation-run',
    traceboundCommit: 'a'.repeat(40),
    retrievalSourcesMatchCommit: true,
    exporterVersion: 'test',
    database: { sha256: frozen.frozen.sha256, bytes: frozen.frozen.bytes, userVersion: frozen.frozen.userVersion },
  };
  const embedding = { modelId: provider.modelId, weightsDigest: 'b'.repeat(64), dimensions: provider.dimensions, maxInputChars: provider.maxInputChars };

  build = async () => {
    const db = new DatabaseSync(join(dir, 'frozen.sqlite'), { readOnly: true });
    try {
      const run = await searchHybridDetailed(db, snapshotId, provider, { description: SPEC.description, changedPaths: SPEC.changedPaths });
      const bundle = constructEvidence(db, snapshotId, provider, run);
      const context: RunContext = { db, spec: SPEC, snapshotId, run, bundle, embedding, provenance };
      const entries = rankingEntries(run);
      const selected = entries.filter((entry) => entry.eligibleRank !== null).slice(0, 3);
      const candidates = selected.map((entry, index) => {
        const artifact = findArtifactAtSnapshot(db, snapshotId, entry.path)!;
        return {
          position: index + 1,
          artifactId: entry.artifactId,
          versionId: entry.versionId,
          path: entry.path,
          kind: entry.kind,
          contentSha256: artifact.contentSha256,
          gitBlobSha: artifact.gitBlobSha,
          fusedRank: entry.rank,
          eligibleRank: entry.eligibleRank!,
        };
      });
      const frozenCase: FrozenCase = { caseId: SPEC.caseId, snapshotId, baseCommitSha, candidates };
      const candidateManifest: JsonObject = {
        schema: 'tracebound.m9.candidate-manifest',
        schemaVersion: '1.0.0',
        identityScope: 'database-scoped',
        protocol: { version: 'test' },
        cases: [
          {
            caseId: SPEC.caseId,
            snapshot: { id: snapshotId, baseCommitSha },
            changedPaths: [...SPEC.changedPaths],
            changedPathFusedRanks: run.fused.filter((entry) => SPEC.changedPaths.includes(entry.path)).map((entry) => ({ path: entry.path, rank: entry.rank })),
            rankedCandidateCount: run.fused.length,
            candidates,
          },
        ],
      };
      const evidencePackage = buildEvidencePackage(context);
      const packet = buildReviewPacket({
        db,
        evidencePackage,
        evidencePackageDigest: digestOf(evidencePackage),
        candidateManifestDigest: digestOf(candidateManifest),
        frozen: frozenCase,
      });
      return { frozenCase, candidateManifest, evidencePackage, ranking: buildProductionRanking(context), packet };
    } finally {
      db.close();
    }
  };

  const built = await build();
  const written = await writeRelease({
    outDir: release,
    databaseFile: 'database/tracebound-m9.sqlite',
    frozen,
    source: sourceIdentity,
    sourceAfter: await fileIdentity(sourcePath),
    sourceSameRows: JSON.stringify(tableDigests(sourcePath)) === JSON.stringify(frozen.tables),
    candidateManifest: built.candidateManifest as JsonObject & { protocol: unknown },
    cases: [{ caseId: SPEC.caseId, evidencePackage: built.evidencePackage, ranking: built.ranking, packet: built.packet }],
    provenance,
    embedding,
    generatedAt: provenance.generatedAt,
  });
  cpSync(join(dir, 'frozen.sqlite'), join(release, 'database', 'tracebound-m9.sqlite'));
  manifestDigest = (await applyReleaseGate(release, '2026-10-12T00:00:00.000Z')).manifestDigest;
  void written;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  fixture.remove();
});

const failed = (report: Awaited<ReturnType<typeof verifyRelease>>) => report.checks.filter((check) => !check.ok).map((check) => check.name);

describe('the M9 release and its offline verifier', () => {
  it('verifies a release built from one production run and its evidence', async () => {
    const report = await verifyRelease(release, { expectedManifestDigest: manifestDigest });
    expect(failed(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.manifestDigest).toBe(manifestDigest);
    expect(report.checks.length).toBeGreaterThan(40);
  });

  it('builds identical artifacts, digests included, from the same run', async () => {
    const first = await build();
    const second = await build();
    expect(digestOf(first.evidencePackage)).toBe(digestOf(second.evidencePackage));
    expect(digestOf(first.packet)).toBe(digestOf(second.packet));
    expect(canonicalBytes(first.packet).equals(canonicalBytes(second.packet))).toBe(true);
  });

  it('puts the complete production ranking in the archival record and marks the changed file ineligible', async () => {
    const ranking = (await build()).ranking as unknown as { rankedCandidateCount: number; ranking: { path: string; rank: number; eligibleRank: number | null }[] };
    expect(ranking.ranking).toHaveLength(ranking.rankedCandidateCount);
    const changed = ranking.ranking.find((entry) => entry.path === 'src/billing.ts')!;
    expect(changed.eligibleRank).toBeNull();
    const eligible = ranking.ranking.filter((entry) => entry.eligibleRank !== null);
    expect(eligible.map((entry) => entry.eligibleRank)).toEqual(eligible.map((_entry, index) => index + 1));
    // Eligible candidates keep their fused ranks; only the eligible rank skips the changed file.
    expect(eligible.map((entry) => entry.rank)).toEqual(ranking.ranking.map((entry) => entry.rank).filter((rank) => rank !== changed.rank));
  });

  it('keeps the archival package complete and the reviewer packet blinded', async () => {
    const { evidencePackage, packet, frozenCase } = await build();
    const pkg = evidencePackage as unknown as { candidates: { path: string; evidence: unknown[] }[]; case: { changedPaths: string[] } };
    expect(pkg.candidates.length).toBeGreaterThan(3);
    expect(pkg.candidates.some((candidate) => candidate.path === 'src/billing.ts')).toBe(false);

    const review = packet as unknown as {
      candidates: { path: string; evidence: unknown[]; source: { text: string } }[];
      annotationTemplates: AnnotationRecord[];
    };
    expect(review.candidates).toHaveLength(3);
    for (const [index, candidate] of review.candidates.entries()) {
      expect(candidate.path).toBe(frozenCase.candidates[index]!.path);
      expect(digestOf(candidate.evidence)).toBe(digestOf(pkg.candidates.find((entry) => entry.path === candidate.path)!.evidence));
    }
    expect(review.annotationTemplates).toHaveLength(3);
    for (const [index, template] of review.annotationTemplates.entries()) {
      const selected = frozenCase.candidates[index]!;
      expect(template).toEqual(
        buildAnnotationTemplate({ caseId: frozenCase.caseId, path: selected.path, artifactId: selected.artifactId, versionId: selected.versionId, contentSha256: selected.contentSha256 }),
      );
      expect(template.evaluation_record.reference_assessment.classification).toBe('');
      expect(template.evaluation_record.reference_assessment.cited_evidence_ids).toEqual([]);
    }

    const text = JSON.stringify(packet);
    const unselected = pkg.candidates.map((candidate) => candidate.path).filter((path) => !frozenCase.candidates.some((entry) => entry.path === path));
    expect(unselected.length).toBeGreaterThan(0);
    for (const path of unselected) expect(text).not.toContain(`"path":"${path}"`);
    expect(findLeakedKeys(packet)).toEqual([]);
  });

  it('detects reasoning output, model metadata and labels in a packet', () => {
    expect(findLeakedKeys({ candidates: [{ relevance: 'direct-impact' }] })).toEqual(['relevance']);
    expect(findLeakedKeys({ reasoningModelId: 'x', impactReport: {} })).toEqual(['reasoningModelId', 'impactReport']);
    expect(findLeakedKeys({ candidates: [{ classification: 'likely_affected' }] })).toEqual(['classification']);
    expect(findLeakedKeys({ annotationTemplates: [{ evaluation_record: { reference_assessment: { classification: '' } } }] })).toEqual([]);
    expect(findLeakedKeys({ findings: [], diff: 'x' })).toEqual(['findings', 'diff']);
  });

  it('refuses source text that does not hash to the frozen content hash', async () => {
    const { frozenCase, evidencePackage } = await build();
    const tampered: FrozenCase = { ...frozenCase, candidates: frozenCase.candidates.map((entry, index) => (index === 0 ? { ...entry, contentSha256: '0'.repeat(64) } : entry)) };
    const db = new DatabaseSync(join(dir, 'frozen.sqlite'), { readOnly: true });
    try {
      expect(() => buildReviewPacket({ db, evidencePackage, evidencePackageDigest: 'x', candidateManifestDigest: 'y', frozen: tampered })).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects an absolute or non-POSIX changed path when reading a case', () => {
    const base = { case_id: 'TB-X', repository: { name: 'r' }, source_change: { description: 'd', evaluation_cutoff: '2026-01-01T00:00:00Z' } };
    expect(() => caseSpecFromParsed({ ...base, changed_artifacts: [{ path: 'C:\\repo\\a.ts' }] })).toThrow(RangeError);
    expect(caseSpecFromParsed({ ...base, changed_artifacts: [{ path: 'a/b.ts', symbols: [{ name: 'f' }] }] }).symbols).toEqual(['f']);
  });

  describe('tampering', () => {
    const edit = (relative: string, change: (text: string) => string): void => {
      const path = join(release, relative);
      writeFileSync(path, change(readFileSync(path, 'utf8')));
    };

    it('fails when an evidence package is edited', async () => {
      edit('packages/TB-TEST.evidence-package.json', (text) => text.replace('"retrievalSourcesMatchCommit":true', '"retrievalSourcesMatchCommit":false'));
      const report = await verifyRelease(release);
      expect(report.ok).toBe(false);
      expect(failed(report).some((name) => name.includes('evidence-package') && name.includes('digest'))).toBe(true);
    });

    it('fails when a review packet is removed', async () => {
      rmSync(join(release, 'review-packets', 'TB-TEST.review-packet.json'));
      expect((await verifyRelease(release)).ok).toBe(false);
    });

    it('fails when the frozen database differs by one byte', async () => {
      const path = join(release, 'database', 'tracebound-m9.sqlite');
      const bytes = readFileSync(path);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
      writeFileSync(path, bytes);
      const report = await verifyRelease(release);
      expect(report.ok).toBe(false);
      expect(failed(report)).toContain('frozen database SHA-256');
    });

    it('fails when the manifest is changed or its digest file is replaced', async () => {
      edit('release-manifest.sha256', () => `${'0'.repeat(64)}\n`);
      const report = await verifyRelease(release);
      expect(report.ok).toBe(false);
      expect(failed(report)).toContain('release manifest digest matches its .sha256 file');
      expect((await verifyRelease(release, { expectedManifestDigest: '1'.repeat(64) })).ok).toBe(false);
    });

    it('fails when a frozen candidate no longer matches the database identity', async () => {
      // Re-record the candidate manifest with a wrong blob SHA and keep every digest consistent:
      // the verifier must still catch it against the database.
      const manifestPath = join(release, 'release-manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: { role: string; path: string; digest: string; fileSha256: string; bytes: number }[]; candidateManifestDigest: string };
      const entry = manifest.files.find((file) => file.role === 'candidate-manifest')!;
      const candidateManifest = JSON.parse(readFileSync(join(release, entry.path), 'utf8')) as { cases: { candidates: { gitBlobSha: string }[] }[] };
      candidateManifest.cases[0]!.candidates[0]!.gitBlobSha = 'f'.repeat(40);
      const bytes = canonicalBytes(candidateManifest);
      writeFileSync(join(release, entry.path), bytes);
      entry.bytes = bytes.length;
      entry.digest = digestOf(candidateManifest);
      entry.fileSha256 = (await fileIdentity(join(release, entry.path))).sha256;
      manifest.candidateManifestDigest = entry.digest;
      writeFileSync(manifestPath, canonicalBytes(manifest));
      writeFileSync(join(release, 'release-manifest.sha256'), `${digestOf(manifest)}\n`);

      const report = await verifyRelease(release);
      expect(report.ok).toBe(false);
      expect(failed(report).some((name) => name.includes('identity'))).toBe(true);
    });
  });
});

describe('the release gate and packet reconciliation', () => {
  const readManifest = () => JSON.parse(readFileSync(join(release, 'release-manifest.json'), 'utf8')) as { distribution: { status: string; failedChecks?: string[] }; files: { role: string; caseId: string | null; path: string; bytes: number; fileSha256: string; digest: string }[]; database: { sha256: string } };

  it('records RELEASED only after the verifier passes the manifest as written', async () => {
    expect(readManifest().distribution.status).toBe('RELEASED');
    const report = await verifyRelease(release, { expectedManifestDigest: manifestDigest });
    expect(report.ok).toBe(true);
    expect(report.distributionStatus).toBe('RELEASED');
  });

  it('records BLOCKED with the failed checks when something does not verify', async () => {
    const path = join(release, 'packages', 'TB-TEST.evidence-package.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"rrfK":60', '"rrfK":61'));
    const gate = await applyReleaseGate(release, '2026-10-12T01:00:00.000Z');
    expect(gate.status).toBe('BLOCKED');
    expect(readManifest().distribution.failedChecks?.some((name) => name.includes('evidence-package'))).toBe(true);
  });

  it('rebuilds only the packets, leaves the database and packages byte-identical and archives what it replaced', async () => {
    // Put the release into the old state: a packet with the earlier form, digests kept consistent.
    const manifestPath = join(release, 'release-manifest.json');
    const manifest = readManifest() as ReturnType<typeof readManifest> & Record<string, unknown>;
    const entry = manifest.files.find((file) => file.role === 'review-packet')!;
    const packet = JSON.parse(readFileSync(join(release, entry.path), 'utf8')) as Record<string, unknown>;
    delete packet['annotationTemplates'];
    packet['annotationForm'] = { annotations: [] };
    const bytes = canonicalBytes(packet);
    writeFileSync(join(release, entry.path), bytes);
    entry.bytes = bytes.length;
    entry.digest = digestOf(packet);
    entry.fileSha256 = (await fileIdentity(join(release, entry.path))).sha256;
    writeFileSync(manifestPath, canonicalBytes(manifest));
    writeFileSync(join(release, 'release-manifest.sha256'), `${digestOf(manifest)}
`);
    expect((await verifyRelease(release)).ok).toBe(false);

    const before = {
      database: (await fileIdentity(join(release, 'database', 'tracebound-m9.sqlite'))).sha256,
      pkg: (await fileIdentity(join(release, 'packages', 'TB-TEST.evidence-package.json'))).sha256,
    };
    const result = await reconcilePackets(release, '2026-10-12T02:00:00.000Z', 'annotation schema 1.1.0');
    expect(result.status).toBe('RELEASED');
    expect(result.report.ok).toBe(true);
    expect(result.packets).toHaveLength(1);
    expect(result.packets[0]!.before).not.toBe(result.packets[0]!.after);
    expect((await fileIdentity(join(release, 'database', 'tracebound-m9.sqlite'))).sha256).toBe(before.database);
    expect((await fileIdentity(join(release, 'packages', 'TB-TEST.evidence-package.json'))).sha256).toBe(before.pkg);
    expect(existsSync(join(release, 'superseded', result.previousManifestDigest.slice(0, 12), 'review-packets', 'TB-TEST.review-packet.json'))).toBe(true);
    expect((await verifyRelease(release, { expectedManifestDigest: result.manifestDigest })).ok).toBe(true);

    // The rebuilt packet is the one a fresh build produces.
    const fresh = await build();
    expect(digestOf(JSON.parse(readFileSync(join(release, 'review-packets', 'TB-TEST.review-packet.json'), 'utf8')))).toBe(digestOf(fresh.packet));
  });

  it('refuses to reconcile when the database is not the recorded one', async () => {
    const path = join(release, 'database', 'tracebound-m9.sqlite');
    const bytes = readFileSync(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(path, bytes);
    await expect(reconcilePackets(release, '2026-10-12T02:00:00.000Z', 'x')).rejects.toThrow(/recorded hash/);
  });
});
