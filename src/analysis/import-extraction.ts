import { parse } from '@babel/parser';

// Import extraction as implemented by the Phase 1 B1 baseline (experiments/structural/index.js).
// B1 used @babel/parser (its README says the TypeScript compiler API, but the code does not), and
// this module uses the same parser. The TypeScript package installed here is 7.x, whose native
// compiler has no in-process createSourceFile API.
//
// Exactly the forms B1 collected are extracted: ImportDeclaration nodes (`import x from`, named,
// namespace, side-effect and `import type` forms), found anywhere in the syntax tree. Not
// extracted, as in B1: `export ... from`, `import x = require()`, `require()`, dynamic `import()`.

/** Which Babel plugins a text is parsed with. Part of the cache key: JSX changes how `<` parses. */
export type ParseDialect = 'typescript' | 'typescript-jsx';

export type ImportExtraction = { ok: true; specifiers: string[] } | { ok: false };

// B1 analysed `.ts .tsx .js .jsx` files only (not .mts, .cts, .mjs or .cjs).
const ANALYSED_PATH = /\.(ts|tsx|js|jsx)$/;

/**
 * The dialect for an artifact path, or undefined when B1 would not analyse it. Unlike B1, which
 * parsed everything without JSX and therefore lost the imports of every file containing JSX, files
 * other than `.ts` are parsed with JSX enabled.
 */
export function parseDialectFor(gitRepositoryPath: string): ParseDialect | undefined {
  if (!ANALYSED_PATH.test(gitRepositoryPath)) return undefined;
  return gitRepositoryPath.endsWith('.ts') ? 'typescript' : 'typescript-jsx';
}

/** Distinct module specifiers of the import declarations in `text`, in order of appearance. */
export function extractImports(text: string, dialect: ParseDialect): ImportExtraction {
  let program: unknown;
  try {
    program = parse(text, {
      sourceType: 'module',
      plugins: dialect === 'typescript-jsx' ? ['typescript', 'jsx'] : ['typescript'],
    }).program;
  } catch {
    // Like B1, a text the parser rejects contributes no imports.
    return { ok: false };
  }

  const specifiers = new Set<string>();
  collectImportSpecifiers(program, specifiers);
  return { ok: true, specifiers: [...specifiers] };
}

// A generic walk, as in B1, so import declarations nested in `declare module` blocks are found too.
function collectImportSpecifiers(node: unknown, specifiers: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectImportSpecifiers(child, specifiers);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  const record = node as Record<string, unknown>;
  if (record['type'] === 'ImportDeclaration') {
    const source = record['source'] as { value: string };
    specifiers.add(source.value);
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    if (child !== null && typeof child === 'object') collectImportSpecifiers(child, specifiers);
  }
}
