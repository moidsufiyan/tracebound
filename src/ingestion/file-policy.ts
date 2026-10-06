import { posix } from 'node:path';
import type { ArtifactKind } from '../artifacts/artifacts.js';
import type { TreeEntry } from '../git/git.js';

// Which tree entries become artifacts. The scope is deliberately narrow (TS/JS code,
// prose documents, structured config) to match the current evaluation target; widen it
// only with evidence. See docs/architecture/decisions/snapshot-ingestion.md.

export type ExclusionReason =
  | 'symlink'
  | 'submodule'
  | 'generated'
  | 'unsupported_type'
  | 'oversized'
  | 'binary'
  | 'not_utf8';

export type EntryDecision = { included: true; kind: ArtifactKind } | { included: false; reason: ExclusionReason };

export const MAX_FILE_BYTES = 1024 * 1024;

const KIND_BY_EXTENSION: ReadonlyMap<string, ArtifactKind> = new Map([
  ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((ext) => [ext, 'code'] as const),
  ...['.md', '.mdx', '.txt'].map((ext) => [ext, 'document'] as const),
  ...['.json', '.yaml', '.yml'].map((ext) => [ext, 'config'] as const),
]);

// Build output and vendored dependencies, recognised by any path segment.
const GENERATED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo']);
const GENERATED_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml']);
const MINIFIED_SUFFIXES = ['.min.js', '.min.mjs', '.min.cjs'];

export function classifyTreeEntry(entry: Pick<TreeEntry, 'mode' | 'path' | 'size'>): EntryDecision {
  if (entry.mode === '120000') return { included: false, reason: 'symlink' };
  if (entry.mode === '160000') return { included: false, reason: 'submodule' };
  if (isGenerated(entry.path)) return { included: false, reason: 'generated' };

  const kind = KIND_BY_EXTENSION.get(posix.extname(entry.path).toLowerCase());
  if (!kind) return { included: false, reason: 'unsupported_type' };
  if (entry.size === null || entry.size > MAX_FILE_BYTES) return { included: false, reason: 'oversized' };
  return { included: true, kind };
}

function isGenerated(path: string): boolean {
  const segments = path.split('/');
  const fileName = segments.at(-1)?.toLowerCase() ?? '';
  return (
    segments.slice(0, -1).some((segment) => GENERATED_DIRECTORIES.has(segment)) ||
    GENERATED_FILES.has(fileName) ||
    MINIFIED_SUFFIXES.some((suffix) => fileName.endsWith(suffix))
  );
}
