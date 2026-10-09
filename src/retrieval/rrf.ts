import type { ArtifactKind } from '../artifacts/artifacts.js';
import { DETERMINISTIC_CATEGORIES, type DeterministicCategory } from './deterministic-ranking.js';

// Reciprocal Rank Fusion, the approved H2 design (experiments/hybrid/index.js, docs/architecture/
// decisions/retrieval.md): score(c) = sum over the input rankings that contain c of 1 / (K + rank).

export const DEFAULT_RRF_K = 60;

/** The facts a ranking must give about a candidate for it to be fused. */
export interface RankedCandidate {
  /** 1-based position in its ranking. */
  rank: number;
  artifactId: number;
  versionId: number;
  path: string;
  kind: ArtifactKind;
}

/** A deterministic candidate also carries its B6 category, which breaks ties between fused scores. */
export interface RankedDeterministicCandidate extends RankedCandidate {
  category: DeterministicCategory;
}

export interface FusedCandidate {
  /** 1-based position in the fused ranking. */
  rank: number;
  artifactId: number;
  versionId: number;
  path: string;
  kind: ArtifactKind;
  rrfScore: number;
  deterministicRank: number | null;
  semanticRank: number | null;
  deterministicCategory: DeterministicCategory | null;
}

export interface RrfOptions {
  /** The rank constant; a positive integer. Defaults to 60. */
  k?: number;
}

/** The two rankings disagree about a candidate, or a ranking is malformed. */
export class InconsistentCandidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InconsistentCandidateError';
  }
}

/**
 * Fuses two complete rankings of the artifact versions of one snapshot. The result is the union of
 * the two lists, scored on demand, ordered by score, then by deterministic category (candidates the
 * deterministic ranking did not find last), then by path in UTF-16 code unit order, then by
 * artifact id. Ranks of the result are 1-based and consecutive.
 *
 * Pure: it reads no database and removes nothing. Inputs are validated rather than merged
 * leniently: ranks must be positive integers in strictly increasing order, no version or path may
 * repeat within a list, and a candidate that appears in both lists must be the same version, with
 * the same artifact, path and kind.
 */
export function fuseRrf(
  deterministic: readonly RankedDeterministicCandidate[],
  semantic: readonly RankedCandidate[],
  options: RrfOptions = {},
): FusedCandidate[] {
  const k = options.k ?? DEFAULT_RRF_K;
  if (!Number.isInteger(k) || k <= 0) throw new RangeError(`RRF constant K must be a positive integer, received ${k}`);

  validateRanking('deterministic', deterministic);
  validateRanking('semantic', semantic);

  const byVersion = new Map<number, FusedCandidate>();
  const addAll = (list: readonly RankedCandidate[], side: 'deterministic' | 'semantic') => {
    for (const candidate of list) {
      let fused = byVersion.get(candidate.versionId);
      if (fused) assertSameCandidate(fused, candidate);
      else {
        fused = {
          rank: 0,
          artifactId: candidate.artifactId,
          versionId: candidate.versionId,
          path: candidate.path,
          kind: candidate.kind,
          rrfScore: 0,
          deterministicRank: null,
          semanticRank: null,
          deterministicCategory: null,
        };
        byVersion.set(candidate.versionId, fused);
      }
      if (side === 'deterministic') {
        fused.deterministicRank = candidate.rank;
        fused.deterministicCategory = (candidate as RankedDeterministicCandidate).category;
      } else {
        fused.semanticRank = candidate.rank;
      }
    }
  };
  addAll(deterministic, 'deterministic');
  addAll(semantic, 'semantic');
  assertConsistentIdentities(byVersion.values());

  const fused = [...byVersion.values()];
  for (const candidate of fused) {
    // Deterministic term first, as H2 summed them; a missing ranking contributes zero.
    candidate.rrfScore =
      (candidate.deterministicRank === null ? 0 : 1 / (k + candidate.deterministicRank)) +
      (candidate.semanticRank === null ? 0 : 1 / (k + candidate.semanticRank));
  }

  fused.sort(
    (a, b) =>
      b.rrfScore - a.rrfScore ||
      categoryPrecedence(a.deterministicCategory) - categoryPrecedence(b.deterministicCategory) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.artifactId - b.artifactId,
  );
  return fused.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/** Position of the category among the B6 categories; no category (not found) is after all of them. */
function categoryPrecedence(category: DeterministicCategory | null): number {
  return category === null ? DETERMINISTIC_CATEGORIES.length : DETERMINISTIC_CATEGORIES.indexOf(category);
}

function validateRanking(name: string, list: readonly RankedCandidate[]): void {
  const versions = new Set<number>();
  const paths = new Set<string>();
  let previousRank = 0;
  for (const candidate of list) {
    const label = `${name} candidate ${JSON.stringify(candidate.path)}`;
    if (!Number.isInteger(candidate.rank) || candidate.rank < 1) {
      throw new InconsistentCandidateError(`${label} has rank ${candidate.rank}; ranks are positive integers`);
    }
    if (candidate.rank <= previousRank) {
      throw new InconsistentCandidateError(`${label} has rank ${candidate.rank} after rank ${previousRank}; ranks must increase`);
    }
    previousRank = candidate.rank;
    if (!Number.isInteger(candidate.artifactId) || !Number.isInteger(candidate.versionId)) {
      throw new InconsistentCandidateError(`${label} has a non-integer artifact or version id`);
    }
    if (versions.has(candidate.versionId)) {
      throw new InconsistentCandidateError(`${name} ranking lists version ${candidate.versionId} more than once`);
    }
    if (paths.has(candidate.path)) {
      throw new InconsistentCandidateError(`${name} ranking lists path ${JSON.stringify(candidate.path)} more than once`);
    }
    versions.add(candidate.versionId);
    paths.add(candidate.path);
  }
}

function assertSameCandidate(existing: FusedCandidate, other: RankedCandidate): void {
  if (
    existing.artifactId !== other.artifactId ||
    existing.path !== other.path ||
    existing.kind !== other.kind
  ) {
    throw new InconsistentCandidateError(
      `Version ${other.versionId} is ${JSON.stringify(existing.path)} (artifact ${existing.artifactId}, ${existing.kind}) ` +
        `in one ranking and ${JSON.stringify(other.path)} (artifact ${other.artifactId}, ${other.kind}) in the other`,
    );
  }
}

/** The same path or artifact must not stand for different versions across the two lists. */
function assertConsistentIdentities(candidates: Iterable<FusedCandidate>): void {
  const versionByPath = new Map<string, number>();
  const versionByArtifact = new Map<number, number>();
  for (const candidate of candidates) {
    const samePath = versionByPath.get(candidate.path);
    if (samePath !== undefined && samePath !== candidate.versionId) {
      throw new InconsistentCandidateError(
        `Path ${JSON.stringify(candidate.path)} is version ${samePath} in one ranking and version ${candidate.versionId} in the other`,
      );
    }
    const sameArtifact = versionByArtifact.get(candidate.artifactId);
    if (sameArtifact !== undefined && sameArtifact !== candidate.versionId) {
      throw new InconsistentCandidateError(
        `Artifact ${candidate.artifactId} is version ${sameArtifact} in one ranking and version ${candidate.versionId} in the other`,
      );
    }
    versionByPath.set(candidate.path, candidate.versionId);
    versionByArtifact.set(candidate.artifactId, candidate.versionId);
  }
}
