import { createHash } from 'node:crypto';

// The embedding inputs of the Phase 1 B7.1 experiment (experiments/semantic/index.js): the text
// sent to the embedding model is the file path plus the file text, or a numbered piece of a file
// that is too large to send whole. Documented differences from B7.1 are noted where they occur and
// in docs/architecture/decisions/semantic-retrieval.md.

export interface EmbeddingInput {
  chunkIndex: number;
  /** Exactly what is sent to the provider. */
  text: string;
}

const CODE_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx'];
const MARKDOWN_EXTENSIONS = ['.md', '.mdx'];

// Longest chunk number the budget has to leave room for.
const WIDEST_CHUNK_LABEL = 'search_document: File:  (Chunk 999999)\n\n';
const MIN_CONTENT_BUDGET = 200;

function formatWhole(path: string, text: string): string {
  return `search_document: File: ${path}\n\n${text}`;
}

function formatChunk(path: string, chunkIndex: number, content: string): string {
  return `search_document: File: ${path} (Chunk ${chunkIndex})\n\n${content}`;
}

/** The B7 query: the change description and the paths of the modified files. */
export function formatSemanticQuery(description: string, changedPaths: readonly string[]): string {
  return `search_query: Change Description: ${description}\nFiles Modified:\n${changedPaths.map((p) => `- ${p}`).join('\n')}`;
}

/** SHA-256 of the exact text sent to the provider; with the model id it identifies an embedding. */
export function embeddingInputHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The embedding inputs for one artifact. The whole file is one input when it fits `maxChars`;
 * otherwise it is split and each piece becomes an input of at most `maxChars` characters,
 * numbered from 0. Splitting is deterministic: Markdown at headings, TS/JS at line-leading
 * `export`/`function`/`class`, anything else by lines; pieces too large for the budget are split by
 * lines, and a line longer than the budget by characters.
 *
 * B7.1 used two fixed limits (28,672 characters to decide, 25,000 per chunk) that the served model
 * does not honor: its context is 2,048 tokens and Ollama truncated longer inputs silently. Here the
 * limit is the provider's `maxChars`, so no input needs truncating.
 */
export function chunkArtifact(path: string, text: string, maxChars: number): EmbeddingInput[] {
  const whole = formatWhole(path, text);
  if (whole.length <= maxChars) return [{ chunkIndex: 0, text: whole }];

  const budget = maxChars - (WIDEST_CHUNK_LABEL.length + path.length);
  if (budget < MIN_CONTENT_BUDGET) {
    throw new Error(`Path "${path}" leaves no room for content within ${maxChars} characters`);
  }
  return pack(splitIntoParts(path, text), budget).map((content, chunkIndex) => ({
    chunkIndex,
    text: formatChunk(path, chunkIndex, content),
  }));
}

function splitIntoParts(path: string, text: string): string[] {
  const lower = path.toLowerCase();
  // Zero-width splits before the marker. (B7.1's code splitter used a capturing group, which
  // inserted the matched keyword as a stray extra part; it is not reproduced.)
  if (MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))) return text.split(/(?=^#+ )/m);
  if (CODE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return text.split(/(?=^\s*(?:export |function |class ))/m);
  return lines(text);
}

function lines(text: string): string[] {
  return text.split('\n').map((line) => `${line}\n`);
}

/** Greedily joins consecutive parts into chunks of at most `budget` characters. */
function pack(parts: readonly string[], budget: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const part of parts) {
    if (current.length + part.length <= budget) {
      current += part;
      continue;
    }
    if (current) chunks.push(current);
    if (part.length > budget) {
      chunks.push(...splitOversizedPart(part, budget));
      current = '';
    } else {
      current = part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitOversizedPart(part: string, budget: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines(part)) {
    if (current.length + line.length <= budget) {
      current += line;
      continue;
    }
    if (current) chunks.push(current);
    current = '';
    if (line.length > budget) chunks.push(...sliceByCharacters(line, budget));
    else current = line;
  }
  if (current) chunks.push(current);
  return chunks;
}

function sliceByCharacters(text: string, budget: number): string[] {
  const slices: string[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + budget, text.length);
    // Never cut between the two halves of a surrogate pair.
    if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end -= 1;
    slices.push(text.slice(start, end));
    start = end;
  }
  return slices;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
