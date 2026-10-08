import { describe, expect, it } from 'vitest';
import { extractImports, parseDialectFor } from '../src/analysis/import-extraction.js';

const specifiers = (text: string, dialect: 'typescript' | 'typescript-jsx' = 'typescript') => {
  const result = extractImports(text, dialect);
  if (!result.ok) throw new Error('unexpected syntax error');
  return result.specifiers;
};

describe('extractImports: forms that are extracted (B1 collected every ImportDeclaration)', () => {
  it('extracts default, named, namespace and combined imports', () => {
    expect(
      specifiers(`
        import a from './default';
        import { b, c as d } from './named';
        import * as e from './namespace';
        import f, { g } from './combined';
      `),
    ).toEqual(['./default', './named', './namespace', './combined']);
  });

  it('extracts side-effect imports', () => {
    expect(specifiers(`import './polyfill';`)).toEqual(['./polyfill']);
  });

  it('extracts type-only imports, like any other import', () => {
    expect(specifiers(`import type { T } from './types'; import { type U } from './more-types';`)).toEqual([
      './types',
      './more-types',
    ]);
  });

  it('extracts external and relative specifiers alike, exactly as written', () => {
    expect(specifiers(`import x from 'hono'; import y from '@scope/pkg'; import z from '../up/file.js';`)).toEqual([
      'hono',
      '@scope/pkg',
      '../up/file.js',
    ]);
  });

  it('returns each specifier once, in order of first appearance', () => {
    expect(specifiers(`import { a } from './x'; import { b } from './y'; import { c } from './x';`)).toEqual([
      './x',
      './y',
    ]);
  });

  it('finds imports nested in ambient module declarations, as the generic B1 walk did', () => {
    expect(specifiers(`declare module 'virtual' { import { a } from './inside'; }`)).toEqual(['./inside']);
  });

  it('extracts from TypeScript syntax that surrounds the imports', () => {
    expect(
      specifiers(`
        import { A } from './a';
        export interface Props<T extends A = A> { value: T }
        export const f = <T,>(x: T): T => x as T;
      `),
    ).toEqual(['./a']);
  });

  it('returns an empty list for a text without imports', () => {
    expect(specifiers(`export const x = 1;`)).toEqual([]);
    expect(specifiers(``)).toEqual([]);
  });
});

describe('extractImports: forms that are not extracted (B1 did not collect them)', () => {
  it('ignores export-from, require, import-equals and dynamic import', () => {
    expect(
      specifiers(`
        export * from './re-export-all';
        export { a } from './re-export-named';
        import legacy = require('./import-equals');
        const r = require('./commonjs');
        const lazy = () => import('./dynamic');
        type T = import('./type-import').X;
      `),
    ).toEqual([]);
  });
});

describe('extractImports: dialects and syntax errors', () => {
  const jsx = `import { View } from './view';\nexport const x = <View prop={1}>text</View>;\n`;

  it('parses JSX only in the JSX dialect', () => {
    expect(specifiers(jsx, 'typescript-jsx')).toEqual(['./view']);
    expect(extractImports(jsx, 'typescript')).toEqual({ ok: false });
  });

  it('accepts angle-bracket type assertions only in the plain TypeScript dialect', () => {
    const assertion = `import { a } from './a';\nconst x = <number>y;\n`;
    expect(specifiers(assertion, 'typescript')).toEqual(['./a']);
    expect(extractImports(assertion, 'typescript-jsx')).toEqual({ ok: false });
  });

  it('reports a rejected text instead of returning partial imports, as B1 did', () => {
    expect(extractImports(`import { a } from './a';\nconst = ;\n`, 'typescript')).toEqual({ ok: false });
  });
});

describe('parseDialectFor', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/types.d.ts', 'typescript'],
    ['src/a.tsx', 'typescript-jsx'],
    ['src/a.js', 'typescript-jsx'],
    ['src/a.jsx', 'typescript-jsx'],
  ])('analyses %s as %s', (path, dialect) => {
    expect(parseDialectFor(path)).toBe(dialect);
  });

  it.each(['src/a.mts', 'src/a.cts', 'src/a.mjs', 'src/a.cjs', 'README.md', 'package.json', 'src/ts', 'src/a.TS'])(
    'does not analyse %s (B1 analysed .ts .tsx .js .jsx only)',
    (path) => {
      expect(parseDialectFor(path)).toBeUndefined();
    },
  );
});
