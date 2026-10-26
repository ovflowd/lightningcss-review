import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeResponse } from '../normalize.js';

test('normalizing ignores error noise but keeps behavior', () => {
  const a = normalizeResponse({
    ok: false,
    stage: 'parse',
    error: 'line 1 col 2 | UnexpectedToken(Ident("x"))',
  });
  const b = normalizeResponse({
    ok: false,
    stage: 'parse',
    error: "line 9 col 9 | UnexpectedToken(Delim('}'))",
  });

  assert.deepEqual(a, b);
  assert.deepEqual(a, { ok: false, stage: 'parse', kind: 'UnexpectedToken' });
  assert.notDeepEqual(normalizeResponse({ ok: true, code: 'a' }), normalizeResponse({ ok: true, code: 'b' }));
});

test('successes keep code, non-empty exports and recognition; failures keep stage and kind', () => {
  assert.deepEqual(normalizeResponse({ ok: true, code: 'x', exports: {}, warnings: ['w'] }), {
    ok: true,
    code: 'x',
  });
  assert.deepEqual(normalizeResponse({ ok: true, exports: { a: 'b' }, recognition: 'typed' }), {
    ok: true,
    code: null,
    exports: { a: 'b' },
    recognition: 'typed',
  });
  // Without a `|`, the first 80 characters (code points) stand for the kind.
  assert.deepEqual(normalizeResponse({ ok: false, error: 'x'.repeat(100) }), {
    ok: false,
    stage: null,
    kind: 'x'.repeat(80),
  });
  assert.deepEqual(normalizeResponse({ ok: false, stage: 'crash' }), { ok: false, stage: 'crash', kind: '' });
  assert.deepEqual(normalizeResponse({ ok: false, error: 'a | Kind Thing(1) | more' }), {
    ok: false,
    stage: null,
    kind: 'Kind',
  });
});

test('an empty recognition is dropped, as Python drops falsy values', () => {
  assert.deepEqual(normalizeResponse({ ok: true, code: 'x', recognition: '' }), { ok: true, code: 'x' });
});
