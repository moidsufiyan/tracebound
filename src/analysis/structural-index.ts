import { inTransaction, type Database } from '../db/database.js';
import { requireReadySnapshot } from '../snapshots/snapshots.js';
import { extractImports, parseDialectFor, type ParseDialect } from './import-extraction.js';
import { isTestPath, resolveRelativeImport } from './module-resolution.js';

export class StructuralIndexNotBuiltError extends Error {
  readonly snapshotId: number;

  constructor(snapshotId: number) {
    super(`Snapshot ${snapshotId} has not been structurally indexed; call indexSnapshotStructurally first`);
    this.name = 'StructuralIndexNotBuiltError';
    this.snapshotId = snapshotId;
  }
}

export interface StructuralIndexingResult {
  /** False when the snapshot was already indexed and nothing was done. */
  indexed: boolean;
  /** (content, dialect) pairs parsed by this call; content seen before is not parsed again. */
  contentsParsed: number;
  /** Of those, how many the parser rejected (they contribute no imports). */
  contentsWithSyntaxErrors: number;
  /** Rows written to snapshot_relationship, counting an import and its test-to-source row separately. */
  relationships: number;
}

interface VersionRow {
  artifact_id: number;
  path: string;
  content_sha256: string;
}

/**
 * Extracts import facts for the content of a ready snapshot and resolves them into relationships
 * between that snapshot's own artifacts. Content-level facts are stored once per (content, dialect)
 * and reused by later snapshots and repositories; relationships are resolved per snapshot, only
 * against the paths present in it. Idempotent, and all-or-nothing: a snapshot is marked indexed in
 * the same transaction that writes its relationships. Never affects the snapshot's status.
 */
export function indexSnapshotStructurally(db: Database, snapshotId: number): StructuralIndexingResult {
  const snapshot = requireReadySnapshot(db, snapshotId);

  return inTransaction(db, () => {
    if (isSnapshotStructurallyIndexed(db, snapshot.id)) {
      return { indexed: false, contentsParsed: 0, contentsWithSyntaxErrors: 0, relationships: 0 };
    }

    const versions = db
      .prepare(
        `SELECT v.artifact_id, a.path, v.content_sha256
         FROM artifact_version v JOIN artifact a ON a.id = v.artifact_id
         WHERE v.snapshot_id = ?
         ORDER BY a.path`,
      )
      .all(snapshot.id) as unknown as VersionRow[];

    const analysed = versions.flatMap((version) => {
      const dialect = parseDialectFor(version.path);
      return dialect ? [{ ...version, dialect }] : [];
    });

    const parsing = parseUnseenContent(db, analysed);

    const artifactIds = new Map(versions.map((version) => [version.path, version.artifact_id]));
    const paths = new Set(artifactIds.keys());
    const specifiersOf = db.prepare(
      'SELECT specifier FROM content_import WHERE content_sha256 = ? AND dialect = ? ORDER BY specifier',
    );
    const insertRelationship = db.prepare(
      `INSERT OR IGNORE INTO snapshot_relationship (snapshot_id, source_artifact_id, target_artifact_id, kind)
       VALUES (?, ?, ?, ?)`,
    );

    let relationships = 0;
    for (const source of analysed) {
      const rows = specifiersOf.all(source.content_sha256, source.dialect) as unknown as { specifier: string }[];
      for (const { specifier } of rows) {
        const targetPath = resolveRelativeImport(source.path, specifier, paths);
        if (targetPath === undefined || targetPath === source.path) continue;

        const targetId = artifactIds.get(targetPath)!;
        relationships += Number(insertRelationship.run(snapshot.id, source.artifact_id, targetId, 'imports').changes);
        if (isTestPath(source.path)) {
          relationships += Number(
            insertRelationship.run(snapshot.id, source.artifact_id, targetId, 'test-to-source').changes,
          );
        }
      }
    }

    db.prepare('INSERT INTO structurally_indexed_snapshot (snapshot_id) VALUES (?)').run(snapshot.id);
    return { indexed: true, ...parsing, relationships };
  });
}

export function isSnapshotStructurallyIndexed(db: Database, snapshotId: number): boolean {
  return db.prepare('SELECT 1 FROM structurally_indexed_snapshot WHERE snapshot_id = ?').get(snapshotId) !== undefined;
}

function parseUnseenContent(
  db: Database,
  analysed: readonly { content_sha256: string; dialect: ParseDialect }[],
): { contentsParsed: number; contentsWithSyntaxErrors: number } {
  const isParsed = db.prepare('SELECT 1 FROM structural_parsed_content WHERE content_sha256 = ? AND dialect = ?');
  const readText = db.prepare('SELECT text FROM content WHERE sha256 = ?');
  const markParsed = db.prepare('INSERT INTO structural_parsed_content (content_sha256, dialect, status) VALUES (?, ?, ?)');
  const insertImport = db.prepare('INSERT INTO content_import (content_sha256, dialect, specifier) VALUES (?, ?, ?)');

  let contentsParsed = 0;
  let contentsWithSyntaxErrors = 0;
  for (const { content_sha256, dialect } of analysed) {
    if (isParsed.get(content_sha256, dialect) !== undefined) continue;

    const { text } = readText.get(content_sha256) as { text: string };
    const extraction = extractImports(text, dialect);
    markParsed.run(content_sha256, dialect, extraction.ok ? 'parsed' : 'syntax_error');
    if (extraction.ok) {
      for (const specifier of extraction.specifiers) insertImport.run(content_sha256, dialect, specifier);
    } else {
      contentsWithSyntaxErrors += 1;
    }
    contentsParsed += 1;
  }
  return { contentsParsed, contentsWithSyntaxErrors };
}
