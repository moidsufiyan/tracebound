import { describe, expect, it } from 'vitest';
import { positionOf, removeInputs, scoredEntries, SCORED_DEPTH, siblingRanking, siblingTestPool } from '../src/evaluation/cochange/rankings.js';

const ranked = (...paths: string[]) => paths.map((path, i) => ({ rank: i + 1, path }));
const pathsOf = (list: readonly { path: string }[]) => list.map((entry) => entry.path);
const tiers = (inputs: string[], pool: string[]) => siblingRanking(inputs, pool).map(({ path, tier, inputIndex }) => [path, tier, inputIndex]);

describe('input removal and scoring', () => {
  it('removes exactly the input paths and keeps the order', () => {
    const list = ranked('src/a.ts', 'test/a.test.ts', 'src/b.ts', 'docs/a.md', 'src/a.tsx');
    expect(pathsOf(removeInputs(list, ['src/a.ts', 'src/b.ts']))).toEqual(['test/a.test.ts', 'docs/a.md', 'src/a.tsx']);
  });

  it('keeps targets, which are never inputs', () => {
    const list = ranked('src/a.ts', 'test/a.test.ts');
    expect(pathsOf(removeInputs(list, ['src/a.ts']))).toEqual(['test/a.test.ts']);
  });

  it('rejects a ranking that lists a path twice', () => {
    expect(() => removeInputs(ranked('a.ts', 'b.ts', 'a.ts'), [])).toThrow(RangeError);
  });

  it('scores the first 20 entries and locates targets in the whole list', () => {
    const list = ranked(...Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`));
    expect(SCORED_DEPTH).toBe(20);
    expect(scoredEntries(list)).toHaveLength(20);
    expect(scoredEntries(list.slice(0, 4))).toHaveLength(4);
    expect(positionOf(list, 'f00.ts')).toBe(1);
    expect(positionOf(list, 'f22.ts')).toBe(23);
    expect(positionOf(list, 'missing.ts')).toBeNull();
  });
});

describe('the sibling-test pool', () => {
  it('keeps the usable test paths of the snapshot, sorted, and no docs or sources', () => {
    const pool = siblingTestPool([
      { path: 'src/z.test.ts', kind: 'code' },
      { path: 'test/helpers.ts', kind: 'code' },
      { path: 'src/a.ts', kind: 'code' },
      { path: 'docs/a.test.md', kind: 'document' },
      { path: 'package.json', kind: 'config' },
      { path: 'src/__tests__/a.ts', kind: 'code' },
    ]);
    expect(pool).toEqual(['src/__tests__/a.ts', 'src/z.test.ts', 'test/helpers.ts']);
  });
});

describe('the sibling-test heuristic', () => {
  it.each([
    ['tier 1: same directory, s.test.', ['src/a.ts'], ['src/a.test.ts'], [['src/a.test.ts', 1, 0]]],
    ['tier 1: same directory, s.spec.', ['src/a.ts'], ['src/a.spec.js'], [['src/a.spec.js', 1, 0]]],
    ['tier 2: d/__tests__, any s. file', ['src/a.ts'], ['src/__tests__/a.ts'], [['src/__tests__/a.ts', 2, 0]]],
    ['tier 2 beats tier 3 for d/__tests__/s.test.', ['src/a.ts'], ['src/__tests__/a.test.ts'], [['src/__tests__/a.test.ts', 2, 0]]],
    ['tier 3: any directory', ['src/a.ts'], ['test/unit/a.test.ts'], [['test/unit/a.test.ts', 3, 0]]],
    ['root input: tier 1 in the root', ['a.ts'], ['a.test.ts'], [['a.test.ts', 1, 0]]],
    ['root input: tier 2 is exactly __tests__', ['a.ts'], ['__tests__/a.ts', 'x/__tests__/a.ts'], [['__tests__/a.ts', 2, 0]]],
    ['index: literal stem at tier 1', ['src/foo/index.ts'], ['src/foo/index.test.ts'], [['src/foo/index.test.ts', 1, 0]]],
    ['index: literal stem at tier 2', ['src/foo/index.ts'], ['src/foo/__tests__/index.ts'], [['src/foo/__tests__/index.ts', 2, 0]]],
    ['index: directory name only at tier 3', ['src/foo/index.ts'], ['src/foo/foo.test.ts', 'test/foo.spec.ts'], [['src/foo/foo.test.ts', 3, 0], ['test/foo.spec.ts', 3, 0]]],
    ['index: no directory-name rule at tier 2', ['src/foo/index.ts'], ['src/foo/__tests__/foo.ts'], []],
    ['root index: no directory-name rule', ['index.ts'], ['test/index.test.ts', 'test/.test.ts'], [['test/index.test.ts', 3, 0]]],
    ['case-sensitive prefixes', ['src/a.ts'], ['src/A.test.ts', 'src/a.Test.ts'], []],
    ['s.test without a following dot does not match', ['src/a.ts'], ['src/a.test', 'src/a.tests.ts', 'src/ab.test.ts'], []],
    ['stem is the name before the last extension', ['src/a.b.ts'], ['src/a.b.test.ts', 'src/a.test.ts'], [['src/a.b.test.ts', 1, 0]]],
    ['a tier-3 match in the same directory as tier 1 keeps tier 1', ['src/a.ts'], ['src/a.test.ts', 'lib/a.test.ts'], [['src/a.test.ts', 1, 0], ['lib/a.test.ts', 3, 0]]],
  ])('%s', (_label, inputs, pool, expected) => {
    expect(tiers(inputs, pool)).toEqual(expected);
  });

  it('keeps the earliest input within the best tier', () => {
    // Both inputs reach test/a.test.ts at tier 3; with the sorted inputs [lib/a.ts, src/a.ts] the first wins.
    expect(tiers(['src/a.ts', 'lib/a.ts'], ['test/a.test.ts'])).toEqual([['test/a.test.ts', 3, 0]]);
    // A better tier for a later input wins over a worse tier for an earlier one.
    expect(tiers(['lib/a.ts', 'src/a.ts'], ['src/a.test.ts'])).toEqual([['src/a.test.ts', 1, 1]]);
  });

  it('orders by tier, then input position, then path', () => {
    const inputs = ['src/b.ts', 'src/a.ts'];
    const pool = ['test/b.test.ts', 'src/b.test.ts', 'test/a.test.ts', 'src/__tests__/a.x.ts', 'src/a.test.ts', 'other/a.spec.ts'];
    expect(tiers(inputs, pool)).toEqual([
      ['src/a.test.ts', 1, 0],
      ['src/b.test.ts', 1, 1],
      ['src/__tests__/a.x.ts', 2, 0],
      ['other/a.spec.ts', 3, 0],
      ['test/a.test.ts', 3, 0],
      ['test/b.test.ts', 3, 1],
    ]);
  });

  it('sorts inputs and paths in UTF-16 code-unit order, not by locale', () => {
    // 'B' (0x42) < 'a' (0x61) < 'é' (0xe9).
    expect(tiers(['src/é.ts', 'src/a.ts', 'src/B.ts'], ['x/a.test.ts', 'x/B.test.ts', 'x/é.test.ts']).map(([path]) => path)).toEqual([
      'x/B.test.ts',
      'x/a.test.ts',
      'x/é.test.ts',
    ]);
    expect(tiers(['src/a.ts'], ['z/a.test.ts', 'Z/a.test.ts', 'é/a.test.ts']).map(([path]) => path)).toEqual(['Z/a.test.ts', 'z/a.test.ts', 'é/a.test.ts']);
  });

  it('cuts the list at 20', () => {
    const pool = Array.from({ length: 25 }, (_, i) => `t${String(i).padStart(2, '0')}/a.test.ts`);
    const result = siblingRanking(['src/a.ts'], pool);
    expect(result).toHaveLength(20);
    expect(result[19]!.path).toBe('t19/a.test.ts');
  });

  it('proposes only paths from the test pool, so never a doc', () => {
    expect(siblingRanking(['src/a.ts'], siblingTestPool([{ path: 'src/a.test.md', kind: 'document' }]))).toEqual([]);
    expect(siblingRanking(['src/a.ts'], [])).toEqual([]);
    expect(siblingRanking([], ['src/a.test.ts'])).toEqual([]);
  });
});
