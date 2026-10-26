import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildGolden } from '../../../test/fixtures/build/golden.js';
import { PY_CI_I, PY_DIGIT, PY_SPACE, PY_WORD_END, pyRe } from '../py-re.js';

test('pyRe finds what Python re finds (Unicode classes, dot, anchors, MULTILINE, IGNORECASE)', () => {
  for (const [pattern, flags, text, expected] of buildGolden().regex) {
    const regex = pyRe(pattern, `${flags}g`);

    assert.deepEqual(
      Array.from(text.matchAll(regex), (match) => match[0]),
      expected,
      `${pattern} /${flags} on ${JSON.stringify(text)}`,
    );
  }
});

test('pyRe keeps escapes it does not translate', () => {
  assert.ok(pyRe(String.raw`\.unwrap\(\)`).test('x.unwrap()'));
  assert.ok(pyRe(String.raw`[\w-]+`).test('a-b'));
  assert.equal(pyRe(String.raw`[^\\']`).exec('\\x')?.[0], 'x');
});

test('the class building blocks are Unicode-aware, as Python str patterns are', () => {
  const nbsp = String.fromCodePoint(0xa0);
  const arabicOne = String.fromCodePoint(0x661);
  const dotlessI = String.fromCodePoint(0x131);

  assert.ok(new RegExp(`^${PY_SPACE}$`, 'u').test(nbsp));
  assert.ok(new RegExp(`^${PY_DIGIT}$`, 'u').test(arabicOne));
  assert.ok(new RegExp(`^${PY_CI_I}$`, 'u').test(dotlessI));
  assert.ok(new RegExp(`a${PY_WORD_END}`, 'u').test('a-'));
  assert.ok(!new RegExp(`a${PY_WORD_END}`, 'u').test(`a${String.fromCodePoint(0xe9)}`));
});
