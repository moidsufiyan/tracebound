import { EmbeddingInputTooLongError, EmbeddingProviderError, type EmbeddingProvider } from './provider.js';
import { validateEmbeddings } from './vectors.js';

// The one validated provider: a local Ollama server serving nomic-embed-text:v1.5 (B7.1).

const MODEL = 'nomic-embed-text:v1.5';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

// The served model's context is 2,048 tokens. The shortest text seen was 2.4 characters per token,
// which allows about 4,900 characters; the limit leaves a margin below that.
const MAX_INPUT_CHARS = 3500;

export interface OllamaOptions {
  endpoint?: string;
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface TagsResponse {
  models?: { name?: string; digest?: string; details?: { embedding_length?: number } }[];
}

/**
 * Connects to the Ollama server and builds the provider. The model id includes the digest of the
 * installed weights, so re-pulling a different build under the same tag yields a different id rather
 * than silently mixing vector spaces. Inputs are sent with `truncate: false`: Ollama otherwise cuts
 * an over-long input to the context length without saying so, as it did for B7.1.
 */
export async function createOllamaEmbeddingProvider(options: OllamaOptions = {}): Promise<EmbeddingProvider> {
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;

  const tags = (await request(fetchImpl, `${endpoint}/api/tags`)) as TagsResponse;
  const installed = tags.models?.find((model) => model.name === MODEL);
  if (!installed) throw new EmbeddingProviderError(`Ollama at ${endpoint} does not have ${MODEL} installed`);
  const dimensions = installed.details?.embedding_length;
  if (!installed.digest || !Number.isInteger(dimensions) || dimensions! <= 0) {
    throw new EmbeddingProviderError(`Ollama did not report a digest and embedding length for ${MODEL}`);
  }

  const modelId = `ollama:${MODEL}@${installed.digest.slice(0, 12)}`;
  return {
    modelId,
    dimensions: dimensions!,
    maxInputChars: MAX_INPUT_CHARS,
    async embed(texts) {
      if (texts.length === 0) return [];
      const body = JSON.stringify({ model: MODEL, input: texts, truncate: false });
      const response = (await request(fetchImpl, `${endpoint}/api/embed`, { method: 'POST', body })) as {
        embeddings?: unknown;
      };
      return validateEmbeddings(response.embeddings, texts.length, dimensions!);
    },
  };
}

async function request(fetchImpl: typeof fetch, url: string, init?: { method: string; body: string }): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      ...(init ? { headers: { 'Content-Type': 'application/json' } } : {}),
    });
  } catch (error) {
    throw new EmbeddingProviderError(`Cannot reach Ollama at ${url}`, { cause: error });
  }

  const text = await response.text();
  if (!response.ok) {
    if (response.status === 400 && text.includes('exceeds the context length')) {
      throw new EmbeddingInputTooLongError(`Ollama rejected an input as longer than the model context: ${text}`);
    }
    throw new EmbeddingProviderError(`Ollama request to ${url} failed (${response.status}): ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new EmbeddingProviderError(`Ollama response from ${url} is not JSON`, { cause: error });
  }
}
