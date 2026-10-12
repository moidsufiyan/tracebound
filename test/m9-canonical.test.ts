import { describe, expect, it } from 'vitest';
import { assertPortablePath, canonicalJson, digestOf, normalizeTimestamp, sha256Hex } from '../src/evaluation/m9/canonical.js';

describe('RFC 8785 canonical JSON', () => {
  it('serializes the RFC 8785 number samples (section 3.2.2.3)', () => {
    const value = JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"literals":[null,true,false]}');
    expect(canonicalJson(value)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
  });

  it('sorts keys by UTF-16 code units (RFC 8785 section 3.2.3)', () => {
    const value = { '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew Letter Dalet With Dagesh', '1': 'One', '\u{1f600}': 'Emoji: Grinning Face', '\u0080': 'Control', '\u00f6': 'Latin Small Letter O With Diaeresis' };
    // Read the order from the text: a JavaScript object lists integer-like keys such as "1" first whatever the text says.
    const keys = [...canonicalJson(value).matchAll(/"((?:[^"\\]|\\.)*)":"/g)].map((match) => JSON.parse(`"${match[1]}"`) as string);
    expect(keys).toEqual(['\r', '1', '\u0080', '\u00f6', '\u20ac', '\u{1f600}', '\ufb33']);
  });

  it('escapes only what JSON requires and keeps other characters as they are', () => {
    expect(canonicalJson('\u000f\n"\\/€')).toBe('"\\u000f\\n\\"\\\\/€"');
  });

  it('is independent of key insertion order and of whitespace in the source text', () => {
    const a = JSON.parse('{ "b": [1, 2, {"y": 1, "x": 2}], "a": "x" }');
    const b = { a: 'x', b: [1, 2, { x: 2, y: 1 }] };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(digestOf(a)).toBe(digestOf(b));
    expect(digestOf(a)).toBe(sha256Hex(Buffer.from('{"a":"x","b":[1,2,{"x":2,"y":1}]}', 'utf8')));
  });

  it('keeps array order significant', () => {
    expect(digestOf({ paths: ['a', 'b'] })).not.toBe(digestOf({ paths: ['b', 'a'] }));
  });

  it('rejects values JSON cannot represent instead of dropping or nulling them', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow(TypeError);
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(TypeError);
  });

  it('treats a digest as a function of the payload only', () => {
    const payload = { schema: 'x', value: 1 };
    expect(digestOf(payload)).toBe(digestOf({ value: 1, schema: 'x' }));
    expect(digestOf({ ...payload, digest: digestOf(payload) })).not.toBe(digestOf(payload));
  });
});

describe('timestamps and paths', () => {
  it('normalizes offsets to UTC with milliseconds', () => {
    expect(normalizeTimestamp('2026-09-05T23:06:00+05:30')).toBe('2026-09-05T17:36:00.000Z');
    expect(normalizeTimestamp('2026-10-01T21:43:59+09:00')).toBe('2026-10-01T12:43:59.000Z');
    expect(normalizeTimestamp('2026-09-30T06:45:12.000Z')).toBe('2026-09-30T06:45:12.000Z');
  });

  it('rejects a timestamp without an offset or one that is not a time', () => {
    expect(() => normalizeTimestamp('2026-09-05T23:06:00')).toThrow(RangeError);
    expect(() => normalizeTimestamp('2026-13-45T00:00:00Z')).toThrow(RangeError);
    expect(() => normalizeTimestamp('yesterday')).toThrow(RangeError);
  });

  it('accepts repository paths exactly as Git has them and rejects machine-specific ones', () => {
    for (const path of ['src/utils/stream.ts', 'CHECKOUT_STATE_MACHINE.md', '.github/ISSUE_TEMPLATE/2-feature-request.yml', 'a b/Ünï.ts']) {
      expect(assertPortablePath(path)).toBe(path);
    }
    for (const path of ['', '/etc/passwd', 'C:\\repo\\a.ts', 'C:/repo/a.ts', 'src\\a.ts', '../a.ts', 'a/./b', 'a//b', 'a/']) {
      expect(() => assertPortablePath(path)).toThrow(RangeError);
    }
  });
});
