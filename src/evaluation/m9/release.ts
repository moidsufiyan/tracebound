import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { IDENTITY_SCOPE, SCHEMA_VERSION, SCHEMAS, type EmbeddingIdentity, type EvidenceRunProvenance, type JsonObject } from './artifacts.js';
import { CANONICALIZATION, canonicalBytes, digestOf } from './canonical.js';
import { fileIdentity, type FileIdentity, type FrozenDatabase } from './freeze-database.js';

export interface ReleaseCase {
  caseId: string;
  evidencePackage: JsonObject;
  ranking: JsonObject;
  packet: JsonObject;
}

export interface ReleaseInput {
  outDir: string;
  /** Release-relative path of the frozen database, already written by `freezeDatabase`. */
  databaseFile: string;
  frozen: FrozenDatabase;
  source: FileIdentity;
  sourceAfter: FileIdentity;
  sourceSameRows: boolean;
  candidateManifest: JsonObject & { protocol: unknown };
  cases: ReleaseCase[];
  provenance: EvidenceRunProvenance;
  embedding: EmbeddingIdentity;
  generatedAt: string;
}

/**
 * Writes the canonical artifacts and the release manifest into `outDir`. Each artifact is stored as
 * its canonical (RFC 8785) bytes, so its file hash equals its digest; the manifest lists both, and
 * its own digest goes in `release-manifest.sha256`, outside the payload it covers.
 */
export async function writeRelease(input: ReleaseInput): Promise<{ manifest: JsonObject; manifestDigest: string }> {
  const files: JsonObject[] = [];
  const put = async (role: string, caseId: string | null, path: string, value: unknown): Promise<void> => {
    const bytes = canonicalBytes(value);
    mkdirSync(dirname(join(input.outDir, path)), { recursive: true });
    writeFileSync(join(input.outDir, path), bytes);
    const identity = await fileIdentity(join(input.outDir, path));
    files.push({ role, caseId, path, bytes: identity.bytes, fileSha256: identity.sha256, digest: digestOf(value) });
  };

  await put('candidate-manifest', null, 'candidate-manifest.json', input.candidateManifest);
  for (const entry of input.cases) {
    await put('evidence-package', entry.caseId, `packages/${entry.caseId}.evidence-package.json`, entry.evidencePackage);
    await put('production-ranking', entry.caseId, `rankings/${entry.caseId}.production-ranking.json`, entry.ranking);
    await put('review-packet', entry.caseId, `review-packets/${entry.caseId}.review-packet.json`, entry.packet);
  }

  const { frozen } = input.frozen;
  const manifest: JsonObject = {
    schema: SCHEMAS.releaseManifest,
    schemaVersion: SCHEMA_VERSION,
    identityScope: IDENTITY_SCOPE,
    release: 'phase1-pilot',
    generatedAt: input.generatedAt,
    protocol: input.candidateManifest.protocol,
    canonicalization: { ...CANONICALIZATION, digest: 'SHA-256 over the canonical bytes of the parsed JSON value' },
    candidateManifestDigest: digestOf(input.candidateManifest),
    provenance: { ...input.provenance },
    embedding: { ...input.embedding },
    database: {
      path: input.databaseFile,
      bytes: frozen.bytes,
      sha256: frozen.sha256,
      userVersion: frozen.userVersion,
      journalMode: frozen.journalMode,
      pageSize: frozen.pageSize,
      pageCount: frozen.pageCount,
      integrityCheck: frozen.integrityCheck,
      foreignKeyViolations: frozen.foreignKeyViolations,
      tables: input.frozen.tables.map((table) => ({ ...table })),
      origin: {
        description: 'the source database, opened read-only and copied with the SQLite backup API; its bytes were hashed before and after',
        sha256: input.source.sha256,
        bytes: input.source.bytes,
        unchangedByFreeze: input.frozen.source.unchanged,
        unchangedByExport: input.sourceAfter.sha256 === input.source.sha256 && input.sourceAfter.bytes === input.source.bytes,
        sameRowsInEveryTable: input.sourceSameRows,
      },
    },
    distribution: { status: 'BLOCKED', reason: 'release gate not yet run' },
    files,
  };
  const manifestDigest = digestOf(manifest);
  writeFileSync(join(input.outDir, 'release-manifest.json'), canonicalBytes(manifest));
  writeFileSync(join(input.outDir, 'release-manifest.sha256'), `${manifestDigest}\n`);
  return { manifest, manifestDigest };
}
