import assert from 'node:assert/strict';
import test from 'node:test';
import { ExactPayloadHashCache } from '../src/services/cloudsync/v2/exactPayloadHashCache.ts';

test('hash reuse compares owned bytes, rejects same-size mutation and stays bounded', async () => {
  const original = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto.subtle, 'digest');
  let hashes = 0;
  Object.defineProperty(globalThis.crypto.subtle, 'digest', { configurable: true, value: (...args: Parameters<SubtleCrypto['digest']>) => { hashes++; return original(...args); } });
  try {
    const cache = new ExactPayloadHashCache(8);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const first = await cache.hash('page', bytes);
    assert.equal(await cache.hash('page', bytes.slice()), first);
    assert.equal(hashes, 1);
    bytes[0] = 9;
    assert.notEqual(await cache.hash('page', bytes), first, 'caller mutation cannot alter cached proof');
    assert.equal(hashes, 2);
    await cache.hash('other', new Uint8Array(8));
    await cache.hash('page', bytes);
    assert.equal(hashes, 4, 'LRU capacity evicts old copies');
    await cache.hash('oversize', new Uint8Array(9)); await cache.hash('oversize', new Uint8Array(9));
    assert.equal(hashes, 6, 'oversize payloads never remain resident');
    assert.equal(await new ExactPayloadHashCache().hash('page', bytes), await cache.hash('page', bytes));
    assert.equal(hashes, 7, 'new account/source cache establishes a fresh proof');
  } finally {
    if (descriptor) Object.defineProperty(globalThis.crypto.subtle, 'digest', descriptor);
    else Reflect.deleteProperty(globalThis.crypto.subtle, 'digest');
  }
});
