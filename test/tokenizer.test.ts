import { describe, expect, it } from 'vitest';
import { queryTerms, tokenize } from '../src/retrieval/tokenizer.js';

describe('tokenize', () => {
  it('lowercases and splits on punctuation and whitespace', () => {
    expect(tokenize('Hello, World! (foo-bar) "baz"')).toEqual(['hello', 'world', 'foo', 'bar', 'baz']);
  });

  it('splits camelCase and also keeps the joined identifier', () => {
    expect(tokenize('InventoryService.updateStock')).toEqual([
      'inventory',
      'service',
      'inventoryservice',
      'update',
      'stock',
      'updatestock',
    ]);
  });

  it('splits snake_case, SCREAMING_CASE and camelCase identifiers into the same tokens', () => {
    const expected = ['release', 'lock', 'lua', 'releaselocklua'];
    expect(tokenize('release_lock_lua')).toEqual(expected);
    expect(tokenize('RELEASE_LOCK_LUA')).toEqual(expected);
    expect(tokenize('releaseLockLua')).toEqual(expected);
  });

  it('keeps digits inside words and does not split acronyms', () => {
    expect(tokenize('expandIPv6')).toEqual(['expand', 'ipv6', 'expandipv6']);
    expect(tokenize('XMLParser')).toEqual(['xmlparser']);
  });

  it('treats path separators and extensions as separators, keeping the extension as a token', () => {
    expect(tokenize('src/middleware/combine/index.test.ts')).toEqual([
      'src',
      'middleware',
      'combine',
      'index',
      'test',
      'ts',
    ]);
  });

  it('returns distinct tokens in order of first appearance and does no filtering', () => {
    expect(tokenize('a the A The to')).toEqual(['a', 'the', 'to']);
  });

  it('returns nothing for text without letters or digits', () => {
    expect(tokenize('  -- ... __ ')).toEqual([]);
  });

  it('is deterministic', () => {
    const text = 'fix(checkout): handle ReservationLock timeouts';
    expect(tokenize(text)).toEqual(tokenize(text));
  });
});

describe('queryTerms', () => {
  it('drops stop words, B2 extension terms and tokens shorter than three characters', () => {
    expect(queryTerms({ text: 'Fix the cart in a src/ts file to go' })).toEqual(['fix', 'cart']);
  });

  it('does not treat tsx as an extension stop word, like B2', () => {
    expect(queryTerms({ text: 'OrderTracking.tsx' })).toEqual(['order', 'tracking', 'ordertracking', 'tsx']);
  });

  it('keeps identifier parts and their joined form searchable', () => {
    expect(queryTerms({ text: 'getProductIdsInStock' })).toEqual(['get', 'product', 'ids', 'stock', 'getproductidsinstock']);
  });

  it('keeps explicit symbols searchable even when they are short or stop words', () => {
    expect(queryTerms({ text: 'fix combine', symbols: ['some'] })).toEqual(['fix', 'combine', 'some']);
    expect(queryTerms({ text: '', symbols: ['id'] })).toEqual(['id']);
  });

  it('adds the joined name and filtered parts of a dotted or compound symbol', () => {
    expect(queryTerms({ text: '', symbols: ['StreamingApi.abort', 'getProductIdsInStock'] })).toEqual([
      'streamingapi',
      'streaming',
      'api',
      'abort',
      'getproductidsinstock',
      'get',
      'product',
      'ids',
      'stock',
    ]);
  });

  it('deduplicates terms across text and symbols', () => {
    expect(queryTerms({ text: 'abort abort', symbols: ['abort'] })).toEqual(['abort']);
  });

  it('is empty when nothing is searchable', () => {
    expect(queryTerms({ text: 'the a of to' })).toEqual([]);
  });
});
