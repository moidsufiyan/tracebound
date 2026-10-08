import { describe, expect, it } from 'vitest';
import { createOllamaEmbeddingProvider } from '../src/semantic/ollama-provider.js';
import { EmbeddingInputTooLongError, EmbeddingProviderError } from '../src/semantic/provider.js';
import { EmbeddingResponseError } from '../src/semantic/vectors.js';

const DIGEST = '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f';

interface Recorded {
  url: string;
  body: unknown;
}

/** A stand-in for fetch that answers /api/tags and delegates /api/embed to `embed`. */
function stubFetch(embed: (body: { input: string[] }) => { status?: number; body: unknown } | string, tags?: unknown) {
  const requests: Recorded[] = [];
  const implementation = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: address, body });
    if (address.endsWith('/api/tags')) {
      const payload = tags ?? {
        models: [{ name: 'nomic-embed-text:v1.5', digest: DIGEST, details: { embedding_length: 3 } }, { name: 'other:1', digest: 'x' }],
      };
      return new Response(JSON.stringify(payload));
    }
    const answer = embed(body);
    if (typeof answer === 'string') return new Response(answer);
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { implementation, requests };
}

describe('createOllamaEmbeddingProvider', () => {
  it('identifies the model by tag and weights digest and takes dimensions from the server', async () => {
    const { implementation } = stubFetch(() => ({ body: { embeddings: [] } }));
    const provider = await createOllamaEmbeddingProvider({ fetch: implementation });

    expect(provider.modelId).toBe(`ollama:nomic-embed-text:v1.5@${DIGEST.slice(0, 12)}`);
    expect(provider.dimensions).toBe(3);
    expect(provider.maxInputChars).toBe(3500);
  });

  it('sends one batch request that disables silent truncation and returns validated vectors', async () => {
    const { implementation, requests } = stubFetch(({ input }) => ({
      body: { embeddings: input.map((_, i) => [i + 1, 0, 0]) },
    }));
    const provider = await createOllamaEmbeddingProvider({ fetch: implementation, endpoint: 'http://ollama.test:1234/' });

    const vectors = await provider.embed(['first', 'second']);

    expect(vectors).toEqual([Float32Array.from([1, 0, 0]), Float32Array.from([2, 0, 0])]);
    const embedRequest = requests.find((r) => r.url.endsWith('/api/embed'))!;
    expect(embedRequest.url).toBe('http://ollama.test:1234/api/embed');
    expect(embedRequest.body).toEqual({ model: 'nomic-embed-text:v1.5', input: ['first', 'second'], truncate: false });
  });

  it('does not call the server for an empty batch', async () => {
    const { implementation, requests } = stubFetch(() => ({ body: { embeddings: [] } }));
    const provider = await createOllamaEmbeddingProvider({ fetch: implementation });
    expect(await provider.embed([])).toEqual([]);
    expect(requests.filter((r) => r.url.endsWith('/api/embed'))).toEqual([]);
  });

  it('rejects responses with the wrong number of vectors, the wrong dimensions, or no embeddings', async () => {
    const wrongCount = await createOllamaEmbeddingProvider({ fetch: stubFetch(() => ({ body: { embeddings: [[1, 0, 0]] } })).implementation });
    await expect(wrongCount.embed(['a', 'b'])).rejects.toThrow(EmbeddingResponseError);

    const wrongSize = await createOllamaEmbeddingProvider({ fetch: stubFetch(() => ({ body: { embeddings: [[1, 0]] } })).implementation });
    await expect(wrongSize.embed(['a'])).rejects.toThrow(/2 dimensions, expected 3/);

    const missing = await createOllamaEmbeddingProvider({ fetch: stubFetch(() => ({ body: {} })).implementation });
    await expect(missing.embed(['a'])).rejects.toThrow(/not a list/);
  });

  it('maps a context-length rejection to a distinct error and other failures to provider errors', async () => {
    const tooLong = await createOllamaEmbeddingProvider({
      fetch: stubFetch(() => ({ status: 400, body: '{"error":"the input length exceeds the context length"}' })).implementation,
    });
    await expect(tooLong.embed(['a'])).rejects.toThrow(EmbeddingInputTooLongError);

    const broken = await createOllamaEmbeddingProvider({ fetch: stubFetch(() => ({ status: 500, body: 'boom' })).implementation });
    await expect(broken.embed(['a'])).rejects.toThrow(/failed \(500\): boom/);

    const notJson = await createOllamaEmbeddingProvider({ fetch: stubFetch(() => 'not json').implementation });
    await expect(notJson.embed(['a'])).rejects.toThrow(/not JSON/);
  });

  it('refuses a server without the model, without its digest, or without a declared size', async () => {
    const fetchWith = (tags: unknown) => stubFetch(() => ({ body: {} }), tags).implementation;

    await expect(createOllamaEmbeddingProvider({ fetch: fetchWith({ models: [] }) })).rejects.toThrow(/not have nomic-embed-text:v1.5/);
    await expect(
      createOllamaEmbeddingProvider({ fetch: fetchWith({ models: [{ name: 'nomic-embed-text:v1.5', details: { embedding_length: 3 } }] }) }),
    ).rejects.toThrow(EmbeddingProviderError);
    await expect(
      createOllamaEmbeddingProvider({ fetch: fetchWith({ models: [{ name: 'nomic-embed-text:v1.5', digest: DIGEST }] }) }),
    ).rejects.toThrow(/embedding length/);
  });

  it('reports an unreachable server clearly', async () => {
    const unreachable = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(createOllamaEmbeddingProvider({ fetch: unreachable })).rejects.toThrow(/Cannot reach Ollama/);
  });

  it('gives different ids to different builds of the same tag', async () => {
    const build = (digest: string) =>
      createOllamaEmbeddingProvider({
        fetch: stubFetch(() => ({ body: {} }), { models: [{ name: 'nomic-embed-text:v1.5', digest, details: { embedding_length: 3 } }] }).implementation,
      });
    expect((await build('aaaaaaaaaaaaaaaa')).modelId).not.toBe((await build('bbbbbbbbbbbbbbbb')).modelId);
  });
});
