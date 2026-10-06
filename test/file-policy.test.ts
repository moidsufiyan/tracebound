import { describe, expect, it } from 'vitest';
import { classifyTreeEntry, MAX_FILE_BYTES } from '../src/ingestion/file-policy.js';

const blob = (path: string, size = 10) => ({ mode: '100644', path, size });

describe('classifyTreeEntry', () => {
  it.each([
    ['src/index.ts', 'code'],
    ['src/App.TSX', 'code'],
    ['scripts/build.mjs', 'code'],
    ['docs/architecture.md', 'document'],
    ['package.json', 'config'],
    ['.github/workflows/ci.yml', 'config'],
  ])('includes %s as %s', (path, kind) => {
    expect(classifyTreeEntry(blob(path))).toEqual({ included: true, kind });
  });

  it('includes executable files like regular files', () => {
    expect(classifyTreeEntry({ mode: '100755', path: 'bin/cli.js', size: 10 })).toEqual({ included: true, kind: 'code' });
  });

  it.each([
    ['assets/logo.png', 'unsupported_type'],
    ['Makefile', 'unsupported_type'],
    ['yarn.lock', 'unsupported_type'],
    ['node_modules/lib/index.js', 'generated'],
    ['packages/web/dist/main.js', 'generated'],
    ['package-lock.json', 'generated'],
    ['public/vendor.min.js', 'generated'],
  ])('excludes %s as %s', (path, reason) => {
    expect(classifyTreeEntry(blob(path))).toEqual({ included: false, reason });
  });

  it('only treats directory segments, not file names, as generated directories', () => {
    expect(classifyTreeEntry(blob('src/build.ts'))).toEqual({ included: true, kind: 'code' });
  });

  it('excludes symlinks and submodules regardless of name', () => {
    expect(classifyTreeEntry({ mode: '120000', path: 'link.ts', size: 8 })).toEqual({ included: false, reason: 'symlink' });
    expect(classifyTreeEntry({ mode: '160000', path: 'vendor/lib', size: null })).toEqual({
      included: false,
      reason: 'submodule',
    });
  });

  it('accepts files up to the size limit and excludes anything larger', () => {
    expect(classifyTreeEntry(blob('big.ts', MAX_FILE_BYTES))).toEqual({ included: true, kind: 'code' });
    expect(classifyTreeEntry(blob('big.ts', MAX_FILE_BYTES + 1))).toEqual({ included: false, reason: 'oversized' });
  });
});
