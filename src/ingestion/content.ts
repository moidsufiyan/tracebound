import { createHash } from 'node:crypto';
import type { Content } from '../artifacts/artifacts.js';

export type NormalizedContent = ({ ok: true } & Content) | { ok: false; reason: 'binary' | 'not_utf8' };

// fatal: invalid UTF-8 throws instead of producing U+FFFD; a leading BOM is dropped.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Converts raw blob bytes into canonical text: strict UTF-8 without BOM, with every
 * CRLF or lone CR rewritten as LF. The hash covers the canonical text, so a file's
 * identity does not depend on how a contributor's checkout encoded line endings.
 */
export function normalizeContent(raw: Uint8Array): NormalizedContent {
  if (raw.includes(0)) return { ok: false, reason: 'binary' };

  let decoded: string;
  try {
    decoded = strictUtf8.decode(raw);
  } catch {
    return { ok: false, reason: 'not_utf8' };
  }

  const text = decoded.replace(/\r\n?/g, '\n');
  const bytes = Buffer.from(text, 'utf8');
  return { ok: true, text, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
}
