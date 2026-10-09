import {
  ReasoningProviderError,
  ReasoningProviderTimeoutError,
  serializeReasoningInput,
  type ReasoningProvider,
  type ReasoningRequest,
} from './provider.js';

// A reasoning provider backed by a local Ollama server. Nothing about the model is assumed: the
// caller names it and says how much input it accepts, and the server must have it installed.

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_ERROR_TEXT_CHARS = 200;

export interface OllamaReasoningOptions {
  /** The model to ask, for example one from `ollama list`. */
  model: string;
  /** The most characters one request (instructions plus serialized input) may have for this model. */
  maxInputChars: number;
  endpoint?: string;
  /** Passed as `num_ctx` when given; otherwise the server's default applies. It must be large enough for `maxInputChars`. */
  contextTokens?: number;
  /** How long one request may take. */
  timeoutMs?: number;
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface TagsResponse {
  models?: { name?: string; digest?: string }[];
}

interface ChatResponse {
  message?: { content?: unknown };
  done_reason?: unknown;
}

/**
 * Connects to the Ollama server and checks that the model is installed. The provider id includes
 * the digest of the installed weights. Requests ask for JSON constrained to the output schema, with
 * temperature 0 and a fixed seed; the answer is parsed here and validated by the caller.
 */
export async function createOllamaReasoningProvider(options: OllamaReasoningOptions): Promise<ReasoningProvider> {
  if (typeof options.model !== 'string' || options.model.trim() === '') throw new RangeError('An Ollama reasoning model must be named');
  if (!Number.isInteger(options.maxInputChars) || options.maxInputChars <= 0) {
    throw new RangeError(`maxInputChars must be a positive integer, received ${options.maxInputChars}`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError(`timeoutMs must be a positive integer, received ${timeoutMs}`);
  if (options.contextTokens !== undefined && (!Number.isInteger(options.contextTokens) || options.contextTokens <= 0)) {
    throw new RangeError(`contextTokens must be a positive integer, received ${options.contextTokens}`);
  }

  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;

  const tags = (await send(fetchImpl, `${endpoint}/api/tags`, undefined, timeoutMs)) as TagsResponse;
  const wanted = options.model.includes(':') ? [options.model] : [options.model, `${options.model}:latest`];
  const installed = tags.models?.find((model) => model.name !== undefined && wanted.includes(model.name));
  if (!installed?.name || !installed.digest) {
    throw new ReasoningProviderError(`Ollama at ${endpoint} does not have the model ${JSON.stringify(options.model)} installed`);
  }
  const name = installed.name;

  return {
    modelId: `ollama:${name}@${installed.digest.slice(0, 12)}`,
    maxInputChars: options.maxInputChars,
    async reason(request: ReasoningRequest): Promise<unknown> {
      const body = JSON.stringify({
        model: name,
        messages: [
          { role: 'system', content: request.instructions },
          { role: 'user', content: serializeReasoningInput(request.input) },
        ],
        format: request.outputSchema,
        stream: false,
        options: { temperature: 0, seed: 0, ...(options.contextTokens !== undefined ? { num_ctx: options.contextTokens } : {}) },
      });
      const response = (await send(fetchImpl, `${endpoint}/api/chat`, body, timeoutMs)) as ChatResponse;

      if (response.done_reason === 'length') {
        throw new ReasoningProviderError('The model stopped at its output limit before finishing its answer');
      }
      const content = response.message?.content;
      if (typeof content !== 'string') throw new ReasoningProviderError('The model response has no message content');
      try {
        return JSON.parse(content);
      } catch (error) {
        // The content is not repeated: it can contain repository text.
        throw new ReasoningProviderError('The model answered with text that is not JSON', { cause: error });
      }
    },
  };
}

async function send(fetchImpl: typeof fetch, url: string, body: string | undefined, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(url, {
        ...(body !== undefined ? { method: 'POST', body, headers: { 'Content-Type': 'application/json' } } : {}),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) throw new ReasoningProviderTimeoutError(`No answer from Ollama within ${timeoutMs} ms`);
      throw new ReasoningProviderError(`Cannot reach Ollama at ${url}`, { cause: error });
    }
    if (!response.ok) {
      throw new ReasoningProviderError(`Ollama request to ${url} failed (${response.status}): ${text.slice(0, MAX_ERROR_TEXT_CHARS)}`);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ReasoningProviderError(`Ollama response from ${url} is not JSON`, { cause: error });
    }
  } finally {
    clearTimeout(timer);
  }
}
