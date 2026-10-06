import { describe, expect, it } from 'vitest';
import { normalizeContent } from '../src/ingestion/content.js';

const bytes = (text: string) => Buffer.from(text, 'utf8');

describe('normalizeContent', () => {
  it('hashes the UTF-8 bytes of the text with SHA-256', () => {
    const result = normalizeContent(bytes('hello\n'));
    expect(result).toEqual({
      ok: true,
      text: 'hello\n',
      sha256: '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
      byteLength: 6,
    });
  });

  it('is deterministic across calls', () => {
    const input = bytes('export const x = 1;\n');
    expect(normalizeContent(input)).toEqual(normalizeContent(Buffer.from(input)));
  });

  it('gives CRLF, CR and LF line endings the same identity', () => {
    const lf = normalizeContent(bytes('a\nb\n'));
    expect(normalizeContent(bytes('a\r\nb\r\n'))).toEqual(lf);
    expect(normalizeContent(bytes('a\rb\r'))).toEqual(lf);
  });

  it('drops a UTF-8 byte order mark', () => {
    expect(normalizeContent(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes('a\n')]))).toEqual(
      normalizeContent(bytes('a\n')),
    );
  });

  it('distinguishes content that differs only in trailing whitespace', () => {
    const a = normalizeContent(bytes('a\n'));
    const b = normalizeContent(bytes('a \n'));
    expect(a.ok && b.ok && a.sha256 !== b.sha256).toBe(true);
  });

  it('rejects content containing NUL bytes as binary', () => {
    expect(normalizeContent(Uint8Array.from([0x61, 0x00, 0x62]))).toEqual({ ok: false, reason: 'binary' });
  });

  it('rejects invalid UTF-8 instead of substituting characters', () => {
    expect(normalizeContent(Uint8Array.from([0x61, 0xff, 0x62]))).toEqual({ ok: false, reason: 'not_utf8' });
  });
});
