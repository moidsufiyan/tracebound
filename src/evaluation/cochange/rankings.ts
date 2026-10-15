import { posix } from 'node:path';
import type { ArtifactKind } from '../../artifacts/artifacts.js';
import { classifyPath } from './selector.js';

// Ranked lists of the co-change evaluation (docs/evaluation/cochange/protocol.md, section 4): input
// removal from the retrieval rankings and the sibling-test heuristic. Pure; paths are compared in
// UTF-16 code-unit order, never by locale.

/** Entries scored per ranking after the inputs are removed. */
export const SCORED_DEPTH = 20;

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The ranking without the input paths (exact path equality), order kept. A path listed twice is
 * rejected: positions would be ambiguous.
 */
export function removeInputs<T extends { path: string }>(ranking: readonly T[], inputs: readonly string[]): T[] {
  const seen = new Set<string>();
  for (const entry of ranking) {
    if (seen.has(entry.path)) throw new RangeError(`The ranking lists ${JSON.stringify(entry.path)} more than once`);
    seen.add(entry.path);
  }
  const removed = new Set(inputs);
  return ranking.filter((entry) => !removed.has(entry.path));
}

/** The entries that are scored: the first 20 of a list the inputs were removed from. */
export function scoredEntries<T>(list: readonly T[]): T[] {
  return list.slice(0, SCORED_DEPTH);
}

/** 1-based position of `path` in the whole list (not only the scored part), or null if absent. */
export function positionOf(list: readonly { path: string }[], path: string): number | null {
  const index = list.findIndex((entry) => entry.path === path);
  return index < 0 ? null : index + 1;
}

/** The usable test paths of a base snapshot (section 3 classification), sorted. */
export function siblingTestPool(artifacts: readonly { path: string; kind: ArtifactKind }[]): string[] {
  return artifacts.filter((artifact) => classifyPath(artifact.path, artifact.kind) === 'test').map((artifact) => artifact.path).sort(byPath);
}

export interface SiblingCandidate {
  path: string;
  tier: 1 | 2 | 3;
  /** Position of the matching input in the sorted input list. */
  inputIndex: number;
}

/**
 * The sibling-test heuristic of section 4, cut at 20. For input `d/s.e`: tier 1 is `d/s.test.*` or
 * `d/s.spec.*`; tier 2 is `d/__tests__/s.*` (`__tests__/s.*` for a root input); tier 3 is
 * `s.test.*` or `s.spec.*` in any directory, plus, for an `index` input outside the root,
 * `n.test.*` or `n.spec.*` where `n` is its directory's last segment. A path keeps its lowest tier
 * and, within it, the earliest input; candidates are ordered by tier, input position, then path.
 */
export function siblingRanking(inputs: readonly string[], testPool: readonly string[]): SiblingCandidate[] {
  const sortedInputs = [...new Set(inputs)].sort(byPath);
  const best = new Map<string, SiblingCandidate>();
  const offer = (path: string, tier: 1 | 2 | 3, inputIndex: number) => {
    const current = best.get(path);
    if (!current || tier < current.tier || (tier === current.tier && inputIndex < current.inputIndex)) best.set(path, { path, tier, inputIndex });
  };

  for (const [inputIndex, input] of sortedInputs.entries()) {
    const d = directoryOf(input);
    const s = stemOf(posix.basename(input));
    const testsDirectory = d === '' ? '__tests__' : `${d}/__tests__`;
    const stems = [s];
    if (s === 'index' && d !== '') stems.push(posix.basename(d));

    for (const path of testPool) {
      const directory = directoryOf(path);
      const name = posix.basename(path);
      const testOf = (stem: string) => name.startsWith(`${stem}.test.`) || name.startsWith(`${stem}.spec.`);
      if (directory === d && testOf(s)) offer(path, 1, inputIndex);
      if (directory === testsDirectory && name.startsWith(`${s}.`)) offer(path, 2, inputIndex);
      if (stems.some(testOf)) offer(path, 3, inputIndex);
    }
  }

  return [...best.values()]
    .sort((a, b) => a.tier - b.tier || a.inputIndex - b.inputIndex || byPath(a.path, b.path))
    .slice(0, SCORED_DEPTH);
}

/** The directory of a Git path, '' for a file in the repository root. */
function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** The base name before its last extension (the whole name when it has none). */
function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}
