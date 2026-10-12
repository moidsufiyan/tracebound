import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

// Canonical serialization for M9 artifacts: RFC 8785 JSON Canonicalization Scheme, provided by the
// `canonicalize` package (the RFC's reference implementation). Creation and verification both go
// through this module, so a digest always means the SHA-256 of the same bytes.

export const CANONICALIZATION = Object.freeze({
  specification: 'RFC 8785 (JSON Canonicalization Scheme)',
  library: 'canonicalize',
  libraryVersion: '5.1.0',
});

/**
 * The RFC 8785 serialization of `value`. Values JSON cannot represent exactly (undefined, NaN,
 * infinities, functions, bigint, symbols) are rejected rather than serialized as null or dropped.
 */
export function canonicalJson(value: unknown): string {
  assertJsonValue(value, '$');
  const text = canonicalize(value);
  if (text === undefined) throw new TypeError('The value has no JSON representation');
  return text;
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of the canonical bytes of `value`: the digest of a JSON artifact, however it is formatted on disk. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}

/** Pretty-printed JSON for files people read; its digest is still `digestOf` the parsed value. */
export function readableJson(value: unknown): string {
  assertJsonValue(value, '$');
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertJsonValue(value: unknown, at: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${at} is a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${at}[${index}]`));
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${at}.${key}`);
    return;
  }
  throw new TypeError(`${at} is not a plain JSON value (${typeof value})`);
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 timestamp with an explicit offset, as UTC with milliseconds: `YYYY-MM-DDTHH:mm:ss.sssZ`. */
export function normalizeTimestamp(input: string): string {
  if (!TIMESTAMP.test(input)) throw new RangeError(`Not an ISO 8601 timestamp with an offset: ${JSON.stringify(input)}`);
  const time = new Date(input);
  if (Number.isNaN(time.getTime())) throw new RangeError(`Not a valid timestamp: ${JSON.stringify(input)}`);
  return time.toISOString();
}

/**
 * Checks that a path is a portable repository-relative POSIX path and returns it unchanged. An
 * artifact path is exactly as Git's tree has it, so nothing is rewritten: a path that is absolute,
 * has a drive letter or backslashes, or has `.`/`..` segments is rejected.
 */
export function assertPortablePath(path: string): string {
  const invalid =
    path.length === 0 ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
  if (invalid) throw new RangeError(`Not a portable repository-relative POSIX path: ${JSON.stringify(path)}`);
  return path;
}
