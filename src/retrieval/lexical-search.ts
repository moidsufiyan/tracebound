import type { ArtifactKind } from '../artifacts/artifacts.js';
import type { Database } from '../db/database.js';
import { requireReadySnapshot } from '../snapshots/snapshots.js';
import { isSnapshotLexicallyIndexed, LexicalIndexNotBuiltError } from './lexical-index.js';
import { rankMatches, type LexicalCategory, type LexicalMatch } from './lexical-ranking.js';
import { queryTerms } from './tokenizer.js';

export interface LexicalQuery {
  /** Human-readable change description, file names, or any other prose. */
  text: string;
  /** Explicit identifiers (function or constant names) that should be matched even when short. */
  symbols?: readonly string[];
}

/**
 * One artifact of the searched snapshot that matched at least one query term. Candidates are
 * ordered by `rank`, which is 1-based and directly usable as the rank in reciprocal rank fusion.
 */
export interface LexicalCandidate {
  rank: number;
  artifactId: number;
  versionId: number;
  path: string;
  kind: ArtifactKind;
  category: LexicalCategory;
  /** Distinct query terms found in the normalized content. */
  contentMatchCount: number;
  /** Distinct query terms found in the Git path. */
  pathMatchCount: number;
  /** Distinct query terms found in the path or the content, sorted. */
  matchedTerms: string[];
}

interface MatchRow {
  artifact_id: number;
  version_id: number;
  path: string;
  kind: ArtifactKind;
  token: string;
}

interface ArtifactMatch extends LexicalMatch {
  kind: ArtifactKind;
  contentTerms: Set<string>;
  pathTerms: Set<string>;
}

/**
 * Lexical candidates for `query` among the artifacts of one ready snapshot, best first.
 *
 * Only that snapshot's versions are visible: HEAD, other snapshots and other repositories are never
 * consulted. A path-only match is a candidate even when the content has no match, and an artifact
 * appears once however many terms matched. Artifacts that share identical content each remain a
 * candidate. The snapshot must have been indexed with indexSnapshotLexically.
 *
 * Throws NotFoundError for an unknown snapshot, SnapshotNotReadyError for a failed one, and
 * LexicalIndexNotBuiltError when the snapshot's index is missing or incomplete.
 */
export function searchLexical(db: Database, snapshotId: number, query: LexicalQuery): LexicalCandidate[] {
  const snapshot = requireReadySnapshot(db, snapshotId);
  if (!isSnapshotLexicallyIndexed(db, snapshot.id)) throw new LexicalIndexNotBuiltError(snapshot.id);

  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const placeholders = terms.map(() => '?').join(', ');

  const contentRows = db
    .prepare(
      `SELECT v.artifact_id, v.id AS version_id, a.path, a.kind, ct.token
       FROM content_token ct
       JOIN artifact_version v ON v.content_sha256 = ct.content_sha256 AND v.snapshot_id = ?
       JOIN artifact a ON a.id = v.artifact_id
       WHERE ct.token IN (${placeholders})`,
    )
    .all(snapshot.id, ...terms) as unknown as MatchRow[];
  const pathRows = db
    .prepare(
      `SELECT v.artifact_id, v.id AS version_id, a.path, a.kind, pt.token
       FROM artifact_path_token pt
       JOIN artifact_version v ON v.artifact_id = pt.artifact_id AND v.snapshot_id = ?
       JOIN artifact a ON a.id = v.artifact_id
       WHERE pt.token IN (${placeholders})`,
    )
    .all(snapshot.id, ...terms) as unknown as MatchRow[];

  const matches = new Map<number, ArtifactMatch>();
  const collect = (rows: MatchRow[], side: 'contentTerms' | 'pathTerms') => {
    for (const row of rows) {
      let match = matches.get(row.artifact_id);
      if (!match) {
        match = {
          artifactId: row.artifact_id,
          versionId: row.version_id,
          path: row.path,
          kind: row.kind,
          contentTerms: new Set(),
          pathTerms: new Set(),
        };
        matches.set(row.artifact_id, match);
      }
      match[side].add(row.token);
    }
  };
  collect(contentRows, 'contentTerms');
  collect(pathRows, 'pathTerms');

  return rankMatches([...matches.values()]).map((ranked) => ({
    rank: ranked.rank,
    artifactId: ranked.artifactId,
    versionId: ranked.versionId,
    path: ranked.path,
    kind: ranked.kind,
    category: ranked.category,
    contentMatchCount: ranked.contentTerms.size,
    pathMatchCount: ranked.pathTerms.size,
    matchedTerms: ranked.matchedTerms,
  }));
}
