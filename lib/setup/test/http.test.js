import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchChecked } from '../http.js';

const OPTIONS = { timeoutMs: 1000, remedy: 'check the network' };

test('a network failure names its cause, not just "fetch failed"', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND x.invalid') });
  });

  await assert.rejects(fetchChecked('https://x.invalid/a', OPTIONS), {
    name: 'LcrError',
    message: 'could not fetch https://x.invalid/a: getaddrinfo ENOTFOUND x.invalid; check the network',
  });
});

test('an unexpected status is an LcrError; an allowed one is an answer', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404, statusText: 'Not Found' }));

  await assert.rejects(fetchChecked('https://x/a', OPTIONS), {
    name: 'LcrError',
    message: 'could not fetch https://x/a: HTTP 404 Not Found; check the network',
  });
  assert.equal((await fetchChecked('https://x/a', { ...OPTIONS, allow: [404] })).status, 404);
});
