import type { ArtifactKind } from '../artifacts/artifacts.js';
import type { Database } from '../db/database.js';
import { requireReadySnapshot } from '../snapshots/snapshots.js';
import { isSnapshotStructurallyIndexed, StructuralIndexNotBuiltError } from './structural-index.js';

export type RelationshipKind = 'imports' | 'test-to-source';

/** One end of a relationship: an artifact as it exists in the queried snapshot. */
export interface RelationshipEnd {
  artifactId: number;
  versionId: number;
  path: string;
  kind: ArtifactKind;
}

/** `source` imports `target`; for `test-to-source`, `source` is additionally a test file. */
export interface SnapshotRelationship {
  kind: RelationshipKind;
  source: RelationshipEnd;
  target: RelationshipEnd;
}

interface RelationshipRow {
  relationship_kind: RelationshipKind;
  source_artifact_id: number;
  source_version_id: number;
  source_path: string;
  source_kind: ArtifactKind;
  target_artifact_id: number;
  target_version_id: number;
  target_path: string;
  target_kind: ArtifactKind;
}

const SELECT_RELATIONSHIPS = `
  SELECT r.kind AS relationship_kind,
         r.source_artifact_id, sv.id AS source_version_id, sa.path AS source_path, sa.kind AS source_kind,
         r.target_artifact_id, tv.id AS target_version_id, ta.path AS target_path, ta.kind AS target_kind
  FROM snapshot_relationship r
  JOIN artifact_version sv ON sv.snapshot_id = r.snapshot_id AND sv.artifact_id = r.source_artifact_id
  JOIN artifact sa ON sa.id = r.source_artifact_id
  JOIN artifact_version tv ON tv.snapshot_id = r.snapshot_id AND tv.artifact_id = r.target_artifact_id
  JOIN artifact ta ON ta.id = r.target_artifact_id`;

/**
 * Relationships whose target is one of `targetArtifactIds`: the artifacts that import them (reverse
 * dependencies) and the test files that import them. Ordered by source path, target path, kind.
 *
 * Throws NotFoundError for an unknown snapshot, SnapshotNotReadyError for a failed one and
 * StructuralIndexNotBuiltError when the snapshot has not been structurally indexed.
 */
export function findIncomingRelationships(
  db: Database,
  snapshotId: number,
  targetArtifactIds: readonly number[],
): SnapshotRelationship[] {
  return findRelationships(db, snapshotId, 'target_artifact_id', targetArtifactIds);
}

/**
 * Relationships whose source is one of `sourceArtifactIds`: what those artifacts import. Same
 * ordering and errors as findIncomingRelationships.
 */
export function findOutgoingRelationships(
  db: Database,
  snapshotId: number,
  sourceArtifactIds: readonly number[],
): SnapshotRelationship[] {
  return findRelationships(db, snapshotId, 'source_artifact_id', sourceArtifactIds);
}

function findRelationships(
  db: Database,
  snapshotId: number,
  column: 'source_artifact_id' | 'target_artifact_id',
  artifactIds: readonly number[],
): SnapshotRelationship[] {
  const snapshot = requireReadySnapshot(db, snapshotId);
  if (!isSnapshotStructurallyIndexed(db, snapshot.id)) throw new StructuralIndexNotBuiltError(snapshot.id);
  if (artifactIds.length === 0) return [];

  const placeholders = artifactIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `${SELECT_RELATIONSHIPS}
       WHERE r.snapshot_id = ? AND r.${column} IN (${placeholders})
       ORDER BY sa.path, ta.path, r.kind`,
    )
    .all(snapshot.id, ...artifactIds) as unknown as RelationshipRow[];

  return rows.map((row) => ({
    kind: row.relationship_kind,
    source: {
      artifactId: row.source_artifact_id,
      versionId: row.source_version_id,
      path: row.source_path,
      kind: row.source_kind,
    },
    target: {
      artifactId: row.target_artifact_id,
      versionId: row.target_version_id,
      path: row.target_path,
      kind: row.target_kind,
    },
  }));
}
