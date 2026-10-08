import { describe, expect, it } from 'vitest';
import { isTestPath, resolveRelativeImport } from '../src/analysis/module-resolution.js';

const paths = (...list: string[]) => new Set(list);

describe('resolveRelativeImport', () => {
  it('resolves an extensionless sibling import to a TypeScript file', () => {
    expect(resolveRelativeImport('src/a.ts', './b', paths('src/a.ts', 'src/b.ts'))).toBe('src/b.ts');
  });

  it('resolves parent and nested directories against the importing file', () => {
    const all = paths('src/util/deep/x.ts', 'src/shared.ts', 'src/util/helper/y.ts');
    expect(resolveRelativeImport('src/util/deep/x.ts', '../../shared', all)).toBe('src/shared.ts');
    expect(resolveRelativeImport('src/util/deep/x.ts', '../helper/y', all)).toBe('src/util/helper/y.ts');
  });

  it('resolves imports from a file at the repository root', () => {
    expect(resolveRelativeImport('main.ts', './lib/a', paths('main.ts', 'lib/a.ts'))).toBe('lib/a.ts');
  });

  it('tries suffixes in B1 order: exact, .ts, .tsx, .js, .jsx, /index.ts, /index.js', () => {
    const order = ['x', 'x.ts', 'x.tsx', 'x.js', 'x.jsx', 'x/index.ts', 'x/index.js'];
    for (let i = 0; i < order.length; i += 1) {
      const present = paths(...order.slice(i).map((p) => `d/${p}`));
      expect(resolveRelativeImport('d/s.ts', './x', present)).toBe(`d/${order[i]}`);
    }
  });

  it('resolves directory imports through index files, including "." and ".."', () => {
    const all = paths('src/index.ts', 'src/lib/index.js', 'src/lib/sub/a.ts');
    expect(resolveRelativeImport('src/lib/sub/a.ts', '..', all)).toBe('src/lib/index.js');
    expect(resolveRelativeImport('src/lib/sub/a.ts', '../..', all)).toBe('src/index.ts');
    expect(resolveRelativeImport('src/lib/x.ts', '.', all)).toBe('src/lib/index.js');
  });

  it('matches an exact file name including its extension', () => {
    expect(resolveRelativeImport('src/a.ts', './data.json', paths('src/data.json'))).toBe('src/data.json');
  });

  describe('.js specifiers for TypeScript sources (Node ESM convention)', () => {
    it('keeps an exact .js target over any TypeScript source', () => {
      expect(resolveRelativeImport('src/a.ts', './b.js', paths('src/b.js'))).toBe('src/b.js');
      expect(resolveRelativeImport('src/a.ts', './b.js', paths('src/b.js', 'src/b.ts', 'src/b.tsx'))).toBe('src/b.js');
    });

    it('resolves to the .ts source when the exact target is absent', () => {
      expect(resolveRelativeImport('src/a.ts', './b.js', paths('src/b.ts'))).toBe('src/b.ts');
      expect(resolveRelativeImport('src/a.ts', '../lib/b.js', paths('lib/b.ts'))).toBe('lib/b.ts');
    });

    it('prefers .ts over .tsx, and resolves to .tsx when neither .js nor .ts exists', () => {
      expect(resolveRelativeImport('src/a.ts', './b.js', paths('src/b.ts', 'src/b.tsx'))).toBe('src/b.ts');
      expect(resolveRelativeImport('src/a.ts', './b.js', paths('src/b.tsx'))).toBe('src/b.tsx');
    });

    it('leaves the specifier unresolved when no matching file exists', () => {
      expect(resolveRelativeImport('src/a.ts', './b.js', paths('src/a.ts', 'src/c.ts', 'src/b.md'))).toBeUndefined();
      expect(resolveRelativeImport('src/a.ts', './b.js', paths('other/b.ts'))).toBeUndefined();
    });

    it('still applies the B1 candidates first, such as a file literally named b.js.ts', () => {
      expect(resolveRelativeImport('src/a.ts', './b.js', paths('src/b.js.ts', 'src/b.ts'))).toBe('src/b.js.ts');
    });

    it('does not substitute any other extension', () => {
      const all = paths('src/styles.ts', 'src/styles.tsx', 'src/b.ts', 'src/data.ts', 'src/c.ts');
      expect(resolveRelativeImport('src/a.ts', './styles.css', all)).toBeUndefined();
      expect(resolveRelativeImport('src/a.ts', './b.mjs', all)).toBeUndefined();
      expect(resolveRelativeImport('src/a.ts', './b.cjs', all)).toBeUndefined();
      expect(resolveRelativeImport('src/a.ts', './b.jsx', all)).toBeUndefined();
      expect(resolveRelativeImport('src/a.ts', './data.json', all)).toBeUndefined();
      expect(resolveRelativeImport('src/a.ts', './c.JS', all)).toBeUndefined();
    });

    it('does not turn the substitution into alias, bare-module or absolute resolution', () => {
      const all = paths('src/b.ts', 'src/utils/x.ts', 'utils/x.ts', 'pkg/index.ts');
      expect(resolveRelativeImport('src/a.ts', '@/utils/x.js', all)).toBeUndefined();
      expect(resolveRelativeImport('src/a.ts', 'src/b.js', all)).toBeUndefined();
      expect(resolveRelativeImport('src/a.ts', 'pkg.js', all)).toBeUndefined();
      expect(resolveRelativeImport('src/a.ts', '/utils/x.js', all)).toBeUndefined();
    });

    it('does not guess for a specifier with no file name before the extension', () => {
      expect(resolveRelativeImport('src/a.ts', './.js', paths('src/.ts'))).toBeUndefined();
    });
  });

  it('does not resolve external modules, aliases or absolute specifiers', () => {
    const all = paths('src/hono.ts', 'src/utils/x.ts', 'node_modules/hono/index.js', 'utils/x.ts');
    expect(resolveRelativeImport('src/a.ts', 'hono', all)).toBeUndefined();
    expect(resolveRelativeImport('src/a.ts', '@/utils/x', all)).toBeUndefined();
    expect(resolveRelativeImport('src/a.ts', '~/utils/x', all)).toBeUndefined();
    expect(resolveRelativeImport('src/a.ts', '/utils/x', all)).toBeUndefined();
    expect(resolveRelativeImport('src/a.ts', 'src/utils/x', all)).toBeUndefined();
  });

  it('leaves relative specifiers without a matching file unresolved', () => {
    expect(resolveRelativeImport('src/a.ts', './missing', paths('src/a.ts'))).toBeUndefined();
    expect(resolveRelativeImport('a.ts', '../outside', paths('a.ts', 'outside.ts'))).toBeUndefined();
  });

  it('only considers the supplied snapshot paths, with case-sensitive matching', () => {
    expect(resolveRelativeImport('src/a.ts', './B', paths('src/b.ts'))).toBeUndefined();
  });
});

describe('isTestPath', () => {
  it.each(['src/a.test.ts', 'src/a.spec.tsx', 'test.test.js', 'src/a.test.helpers.ts', 'x.spec.d.ts'])(
    'treats %s as a test',
    (path) => {
      expect(isTestPath(path)).toBe(true);
    },
  );

  it.each(['src/a.ts', 'src/test/a.ts', 'src/tests/a.ts', 'src/contest.ts', 'src/a.Test.ts', 'src/a_test.ts'])(
    'does not treat %s as a test',
    (path) => {
      expect(isTestPath(path)).toBe(false);
    },
  );
});
