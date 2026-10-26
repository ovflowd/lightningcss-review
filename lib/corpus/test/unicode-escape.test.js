import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeUnicodeEscape } from '../unicode-escape.js';

// Expected values below were produced with CPython 3.14.

test('escapes and Latin-1 bytes', () => {
  const cases = [
    ['a\\nb', 'a\nb'],
    ['\\t\\\\\\"\\\'', '\t\\"\''],
    ['\\x41\\u00e9\\U0001F600', `A${String.fromCodePoint(0xe9, 0x1f600)}`],
    ['\\101\\7', `A${String.fromCodePoint(7)}`],
    ['\\777', String.fromCodePoint(0o777)],
    ['\\q\\8', '\\q\\8'],
    ['a\\\nb', 'ab'],
    [`${String.fromCodePoint(0xe9)}\\n`, `${String.fromCodePoint(0xc3, 0xa9)}\n`],
  ];

  for (const [input, expected] of cases) {
    assert.equal(decodeUnicodeEscape(input), expected, input);
  }
});

test('malformed escapes throw as Python raises', () => {
  for (const input of ['a\\', '\\x4', '\\u12', '\\U00110000']) {
    assert.throws(() => decodeUnicodeEscape(input), RangeError, input);
  }
});

test('named escapes are not supported (a documented deviation: Python looks the name up)', () => {
  assert.throws(() => decodeUnicodeEscape('\\N{BULLET}'), RangeError);
});
