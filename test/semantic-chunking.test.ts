import { describe, expect, it } from 'vitest';
import { chunkArtifact, embeddingInputHash, formatSemanticQuery } from '../src/semantic/chunking.js';

describe('embedding input format', () => {
  it('prefixes a whole file with its path, exactly as B7.1 did', () => {
    expect(chunkArtifact('docs/a.md', '# Title\nbody\n', 1000)).toEqual([
      { chunkIndex: 0, text: 'search_document: File: docs/a.md\n\n# Title\nbody\n' },
    ]);
  });

  it('formats the query exactly as B7 did', () => {
    expect(formatSemanticQuery('Fix the lock', ['src/a.ts', 'src/b.ts'])).toBe(
      'search_query: Change Description: Fix the lock\nFiles Modified:\n- src/a.ts\n- src/b.ts',
    );
    expect(formatSemanticQuery('Docs only', [])).toBe('search_query: Change Description: Docs only\nFiles Modified:\n');
  });

  it('hashes the exact text: SHA-256 of its UTF-8 bytes', () => {
    expect(embeddingInputHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(embeddingInputHash('é')).toBe(embeddingInputHash(Buffer.from('é', 'utf8').toString('utf8')));
  });

  it('gives the same content a different input, and hash, under a different path', () => {
    const [a] = chunkArtifact('a/x.md', 'same\n', 1000);
    const [b] = chunkArtifact('b/x.md', 'same\n', 1000);
    expect(embeddingInputHash(a!.text)).not.toBe(embeddingInputHash(b!.text));
  });
});

describe('chunkArtifact', () => {
  const sections = (count: number, size: number) =>
    Array.from({ length: count }, (_, i) => `# Section ${i}\n${'word '.repeat(size)}\n`).join('');

  it('keeps a file that fits as one input with no chunk label', () => {
    const text = 'x'.repeat(100);
    const [only, ...rest] = chunkArtifact('a.ts', text, 'search_document: File: a.ts\n\n'.length + 100);
    expect(rest).toEqual([]);
    expect(only!.text).not.toContain('Chunk');
  });

  it('splits Markdown at headings of any level and labels each chunk', () => {
    const text = `# One\n${'a '.repeat(250)}\n## Two\n${'b '.repeat(250)}\n# Three\n${'c '.repeat(250)}\n`;
    const chunks = chunkArtifact('docs/guide.md', text, 800);

    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(chunks[0]!.text).toMatch(/^search_document: File: docs\/guide\.md \(Chunk 0\)\n\n# One\n/);
    expect(chunks[1]!.text).toContain('## Two');
    expect(chunks[2]!.text).toMatch(/\(Chunk 2\)\n\n# Three\n/);
  });

  it('packs consecutive Markdown sections into one chunk while they fit', () => {
    const text = sections(6, 30);
    const chunks = chunkArtifact('a.md', text, 700);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(6);
    expect(chunks.map((c) => c.text.split('\n\n').slice(1).join('\n\n')).join('')).toBe(text);
  });

  it('splits TS/JS before line-leading export, function and class, without stray fragments', () => {
    const body = (name: string) => `${'  const filler = 1;\n'.repeat(22)}// ${name}\n`;
    const text = `export const a = 1;\n${body('a')}function b() {}\n${body('b')}class C {}\n${body('c')}`;
    const chunks = chunkArtifact('src/mod.ts', text, 800);
    const contents = chunks.map((c) => c.text.slice(c.text.indexOf('\n\n') + 2));

    expect(contents.join('')).toBe(text);
    expect(contents.some((c) => c.startsWith('export const a'))).toBe(true);
    expect(contents.some((c) => c.startsWith('function b'))).toBe(true);
    expect(contents.some((c) => c.startsWith('class C'))).toBe(true);
    expect(contents.every((c) => c !== 'export ' && c !== 'function ' && c !== 'class ')).toBe(true);
  });

  it('falls back to lines for other file types and for a part larger than the budget', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
    const chunks = chunkArtifact('data/config.json', lines, 600);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(600);
    // Every line survives, each ending in the newline B7.1 appended.
    expect(chunks.map((c) => c.text.split('\n\n').slice(1).join('\n\n')).join('')).toBe(lines.split('\n').map((l) => `${l}\n`).join(''));
  });

  it('splits a Markdown section larger than the budget by lines', () => {
    const text = `# Huge\n${Array.from({ length: 60 }, (_, i) => `row ${i} ${'y'.repeat(30)}`).join('\n')}\n`;
    const chunks = chunkArtifact('big.md', text, 500);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(500);
  });

  it('slices a single line longer than the budget by characters, never inside a surrogate pair', () => {
    const text = '😀'.repeat(900);
    const chunks = chunkArtifact('minified.js', text, 600);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(600);
      expect(chunk.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    }
    const body = chunks.map((c) => c.text.slice(c.text.indexOf('\n\n') + 2)).join('');
    expect(body).toBe(`${text}\n`); // like B7.1, line-based splitting ends every line with a newline
  });

  it('keeps every input within the limit, whatever the path length', () => {
    const path = `some/deeply/nested/directory/${'long-name-'.repeat(5)}file.md`;
    for (const chunk of chunkArtifact(path, sections(40, 40), 1000)) expect(chunk.text.length).toBeLessThanOrEqual(1000);
  });

  it('is deterministic', () => {
    const text = sections(30, 20);
    expect(chunkArtifact('a.md', text, 700)).toEqual(chunkArtifact('a.md', text, 700));
  });

  it('numbers chunks from 0 without gaps', () => {
    const chunks = chunkArtifact('a.md', sections(20, 40), 700);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('refuses a path so long that no content fits', () => {
    expect(() => chunkArtifact(`${'d/'.repeat(400)}a.md`, 'x'.repeat(5000), 900)).toThrow(/no room/);
  });

  it('produces a single input for an empty file', () => {
    expect(chunkArtifact('empty.md', '', 1000)).toEqual([{ chunkIndex: 0, text: 'search_document: File: empty.md\n\n' }]);
  });
});
