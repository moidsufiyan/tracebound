import { describe, expect, it } from 'vitest';
import type { DeterministicCategory } from '../src/retrieval/deterministic-ranking.js';
import {
  DEFAULT_RRF_K,
  fuseRrf,
  InconsistentCandidateError,
  type RankedCandidate,
  type RankedDeterministicCandidate,
} from '../src/retrieval/rrf.js';

// Version ids are 100 + artifact id throughout, so a test only names the artifact.
function sem(rank: number, id: number, path = `p${id}.md`): RankedCandidate {
  return { rank, artifactId: id, versionId: 100 + id, path, kind: 'document' };
}

function det(rank: number, id: number, category: DeterministicCategory = 'single-term', path = `p${id}.md`): RankedDeterministicCandidate {
  return { ...sem(rank, id, path), category };
}

describe('RRF mathematics', () => {
  it('uses K = 60 by default', () => {
    expect(DEFAULT_RRF_K).toBe(60);
  });

  it('scores a deterministic-only candidate 1 / (60 + rank)', () => {
    const [only] = fuseRrf([det(3, 1)], []);
    expect(only).toMatchObject({ rrfScore: 1 / 63, deterministicRank: 3, semanticRank: null, rank: 1 });
  });

  it('scores a semantic-only candidate 1 / (60 + rank)', () => {
    const [only] = fuseRrf([], [sem(7, 1)]);
    expect(only).toMatchObject({ rrfScore: 1 / 67, deterministicRank: null, semanticRank: 7, deterministicCategory: null });
  });

  it('sums both contributions for a candidate found by both', () => {
    const [both] = fuseRrf([det(3, 1)], [sem(5, 1)]);
    expect(both!.rrfScore).toBe(1 / 63 + 1 / 65);
    expect(both).toMatchObject({ deterministicRank: 3, semanticRank: 5 });
  });

  it('matches hand-computed values for K = 60', () => {
    const [both] = fuseRrf([det(1, 1)], [sem(1, 1)]);
    expect(both!.rrfScore).toBeCloseTo(2 / 61, 15);
    expect(both!.rrfScore).toBeCloseTo(0.032786885245901641, 15);
  });

  it('honours a custom K', () => {
    const [both] = fuseRrf([det(2, 1)], [sem(4, 1)], { k: 10 });
    expect(both!.rrfScore).toBe(1 / 12 + 1 / 14);
    const [lone] = fuseRrf([], [sem(1, 1)], { k: 1 });
    expect(lone!.rrfScore).toBe(1 / 2);
  });

  it('works with empty lists', () => {
    expect(fuseRrf([], [])).toEqual([]);
    expect(fuseRrf([det(1, 1)], []).map((c) => c.path)).toEqual(['p1.md']);
    expect(fuseRrf([], [sem(1, 1)]).map((c) => c.path)).toEqual(['p1.md']);
  });

  it('fuses complete lists: a candidate deep in a long ranking still contributes', () => {
    const long = Array.from({ length: 500 }, (_, i) => sem(i + 1, i + 1));
    const fused = fuseRrf([det(1, 400)], long);
    const deep = fused.find((c) => c.artifactId === 400)!;
    expect(deep.semanticRank).toBe(400);
    expect(deep.rrfScore).toBe(1 / 61 + 1 / 460);
    expect(fused).toHaveLength(500);
  });
});

describe('union and ranks', () => {
  it('returns the union with each modality rank preserved and consecutive fused ranks', () => {
    const fused = fuseRrf(
      [det(1, 1), det(2, 2), det(3, 3)],
      [sem(1, 3), sem(2, 4), sem(3, 1)],
    );

    expect(fused).toHaveLength(4);
    expect(fused.map((c) => c.rank)).toEqual([1, 2, 3, 4]);
    const byId = new Map(fused.map((c) => [c.artifactId, c]));
    expect(byId.get(1)).toMatchObject({ deterministicRank: 1, semanticRank: 3 });
    expect(byId.get(2)).toMatchObject({ deterministicRank: 2, semanticRank: null });
    expect(byId.get(3)).toMatchObject({ deterministicRank: 3, semanticRank: 1 });
    expect(byId.get(4)).toMatchObject({ deterministicRank: null, semanticRank: 2 });
  });

  it('orders by score, so agreement between the two rankings outranks one strong vote', () => {
    const fused = fuseRrf([det(1, 1), det(2, 2)], [sem(1, 3), sem(2, 2)]);
    // 2 is second in both (1/62 + 1/62) and beats 1 and 3, which are first in only one list.
    expect(fused.map((c) => c.artifactId)).toEqual([2, 1, 3]);
  });

  it('exposes only retrieval facts', () => {
    const [fused] = fuseRrf([det(1, 1, 'critical-structural')], [sem(1, 1)]);
    expect(Object.keys(fused!).sort()).toEqual(
      ['artifactId', 'deterministicCategory', 'deterministicRank', 'kind', 'path', 'rank', 'rrfScore', 'semanticRank', 'versionId'].sort(),
    );
  });

  it('does not modify its inputs', () => {
    const deterministic = [det(1, 1), det(2, 2)];
    const semantic = [sem(1, 2), sem(2, 1)];
    const before = JSON.stringify([deterministic, semantic]);
    fuseRrf(deterministic, semantic);
    expect(JSON.stringify([deterministic, semantic])).toBe(before);
  });
});

describe('historical H2 tie-breaking', () => {
  it('breaks equal scores by deterministic category before path, not by deterministic rank', () => {
    // A is det 5 / sem 3 and B is det 3 / sem 5: identical scores. B has the better deterministic
    // rank, but A has the better category, so A comes first; paths would put B first.
    const fused = fuseRrf([det(3, 2, 'single-term', 'a-b.md'), det(5, 1, 'critical-structural', 'z-a.md')], [sem(3, 1, 'z-a.md'), sem(5, 2, 'a-b.md')]);

    expect(fused[0]!.rrfScore).toBe(fused[1]!.rrfScore);
    expect(fused.map((c) => c.path)).toEqual(['z-a.md', 'a-b.md']);
  });

  it('puts a candidate the deterministic ranking found before one it did not, when scores tie', () => {
    // Same score: det-only rank 4 and sem-only rank 4.
    const fused = fuseRrf([det(4, 1, 'single-term', 'z.md')], [sem(4, 2, 'a.md')]);
    expect(fused[0]!.rrfScore).toBe(fused[1]!.rrfScore);
    expect(fused.map((c) => c.path)).toEqual(['z.md', 'a.md']);
  });

  it('orders all seven categories by precedence', () => {
    const best = [
      'critical-structural',
      'path-and-multi-content',
      'high-content-density',
      'weak-structural',
      'path-only',
      'multiple-terms',
      'single-term',
    ] as const;
    // Pair j holds two candidates with swapped ranks, hence equal scores. The one with the WORSE
    // category has the better deterministic rank, so only the category can put the other first.
    const deterministic: RankedDeterministicCandidate[] = [];
    const semantic: RankedCandidate[] = [];
    best.slice(0, -1).forEach((better, j) => {
      const worse = best[j + 1]!;
      deterministic.push(det(2 * j + 1, 10 + 2 * j, worse), det(2 * j + 2, 11 + 2 * j, better));
      semantic.push(sem(2 * j + 1, 11 + 2 * j), sem(2 * j + 2, 10 + 2 * j));
    });

    const fused = fuseRrf(deterministic, semantic);

    best.slice(0, -1).forEach((better, j) => {
      const first = fused.find((c) => c.artifactId === 11 + 2 * j)!;
      const second = fused.find((c) => c.artifactId === 10 + 2 * j)!;
      expect(first.rrfScore).toBe(second.rrfScore);
      expect(first.deterministicCategory).toBe(better);
      expect(first.rank, `${better} before ${best[j + 1]}`).toBeLessThan(second.rank);
    });
  });

  it('then orders by path in code unit order, independent of locale', () => {
    // Equal scores need equal ranks, which two lists provide: det 1 / sem 2 versus det 2 / sem 1.
    const tied = fuseRrf(
      [det(1, 1, 'single-term', 'a.md'), det(2, 2, 'single-term', 'B.md')],
      [sem(1, 2, 'B.md'), sem(2, 1, 'a.md')],
    );
    expect(tied.map((c) => c.path)).toEqual(['B.md', 'a.md']); // 'B' (0x42) before 'a' (0x61); localeCompare would reverse them
  });

  it('is deterministic across repeated calls and input-independent order of equal data', () => {
    const deterministic = [det(1, 1), det(2, 2), det(3, 3)];
    const semantic = [sem(1, 3), sem(2, 4), sem(3, 1)];
    expect(fuseRrf(deterministic, semantic)).toEqual(fuseRrf(deterministic, semantic));
  });
});

describe('validation', () => {
  const rejects = (run: () => unknown, pattern: RegExp) => {
    expect(run).toThrow(InconsistentCandidateError);
    expect(run).toThrow(pattern);
  };

  it('rejects an invalid K', () => {
    for (const k of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => fuseRrf([], [], { k }), String(k)).toThrow(RangeError);
    }
  });

  it('rejects non-positive, fractional and non-finite ranks', () => {
    for (const rank of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      rejects(() => fuseRrf([det(rank, 1)], []), /positive integers/);
      rejects(() => fuseRrf([], [sem(rank, 1)]), /positive integers/);
    }
  });

  it('rejects ranks that do not strictly increase', () => {
    rejects(() => fuseRrf([det(2, 1), det(1, 2)], []), /must increase/);
    rejects(() => fuseRrf([], [sem(1, 1), sem(1, 2)]), /must increase/);
  });

  it('accepts a list with gaps in its ranks', () => {
    expect(fuseRrf([], [sem(2, 1), sem(9, 2)])).toHaveLength(2);
  });

  it('rejects the same version twice in one list', () => {
    rejects(() => fuseRrf([], [sem(1, 1), { ...sem(2, 2), versionId: 101, path: 'other.md' }]), /version 101 more than once/);
  });

  it('rejects the same path twice in one list', () => {
    rejects(() => fuseRrf([det(1, 1, 'single-term', 'same.md'), det(2, 2, 'single-term', 'same.md')], []), /path "same.md" more than once/);
  });

  it('rejects a version that has a different artifact, path or kind in the other list', () => {
    rejects(() => fuseRrf([det(1, 1)], [{ ...sem(1, 1), artifactId: 9 }]), /Version 101/);
    rejects(() => fuseRrf([det(1, 1)], [{ ...sem(1, 1), path: 'renamed.md' }]), /Version 101/);
    rejects(() => fuseRrf([det(1, 1)], [{ ...sem(1, 1), kind: 'code' }]), /Version 101/);
  });

  it('rejects one path standing for different versions across the lists', () => {
    rejects(
      () => fuseRrf([det(1, 1, 'single-term', 'shared.md')], [{ ...sem(1, 2, 'shared.md') }]),
      /Path "shared.md" is version 101 in one ranking and version 102/,
    );
  });

  it('rejects one artifact standing for different versions across the lists', () => {
    rejects(
      () => fuseRrf([det(1, 1)], [{ ...sem(1, 1), versionId: 777, path: 'p1-other.md' }]),
      /Artifact 1 is version 101 in one ranking and version 777/,
    );
  });

  it('rejects non-integer ids', () => {
    rejects(() => fuseRrf([], [{ ...sem(1, 1), versionId: Number.NaN }]), /non-integer/);
  });
});
