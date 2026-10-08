import { posix } from 'node:path';

// Relative module resolution and the test-file heuristic, as implemented by the Phase 1 B1 baseline
// (experiments/structural/index.js), plus one recorded extension: the Node ESM / TypeScript
// convention of writing `.js` in a specifier whose source file is `.ts` or `.tsx`.

// Tried in this order, appended to the joined path. B1 does not try `.mts` or `/index.tsx` and
// does not read tsconfig paths.
const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'] as const;

// Only after every B1 candidate failed, and only for a specifier ending in `.js`.
const SOURCE_SUFFIXES_FOR_JS_SPECIFIER = ['.ts', '.tsx'] as const;

/**
 * The artifact path that a relative `specifier` in `sourcePath` refers to, among `snapshotPaths`
 * (the Git paths of one snapshot). Bare module names, aliases and absolute specifiers are not
 * resolved: only specifiers beginning with `.` are.
 *
 * An exact match always wins: B1's candidates are tried first, so an existing `foo.js` is never
 * replaced by `foo.ts`. Only when none exists does a specifier ending in `.js` fall back to the
 * same path with `.js` replaced by `.ts`, then `.tsx`. No other extension is substituted.
 */
export function resolveRelativeImport(
  sourcePath: string,
  specifier: string,
  snapshotPaths: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;

  const joined = posix.join(posix.dirname(sourcePath), specifier);
  const exact = CANDIDATE_SUFFIXES.map((suffix) => joined + suffix).find((candidate) => snapshotPaths.has(candidate));
  if (exact !== undefined || !specifier.endsWith('.js')) return exact;

  const stem = joined.slice(0, -'.js'.length);
  if (stem === '' || stem.endsWith('/')) return undefined;
  return SOURCE_SUFFIXES_FOR_JS_SPECIFIER.map((suffix) => stem + suffix).find((candidate) => snapshotPaths.has(candidate));
}

/** B1's test heuristic: the path contains `.test.` or `.spec.` anywhere. */
export function isTestPath(gitRepositoryPath: string): boolean {
  return gitRepositoryPath.includes('.test.') || gitRepositoryPath.includes('.spec.');
}
