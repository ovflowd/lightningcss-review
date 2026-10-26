import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildGolden } from '../../../test/fixtures/build/golden.js';
import { FIXTURES_DIR } from '../../../test/helpers/index.js';
import { pyDigitsToInt, pyInt, pyIntOrRaise, pyIsdigit, pyParseFloat, pySum } from '../py-number.js';
import { pyFloatRepr } from '../pyjson.js';

// Expected values below were produced with CPython 3.14.

/** `str.isdigit()` and `int(str)` (null for ValueError) from Python, on edge cases. */
const DIGITS_GOLDEN = /** @type {{ text: string, isdigit: boolean, int: number | null }[]} */ (
  JSON.parse(readFileSync(join(FIXTURES_DIR, 'infra', 'py-digits.json'), 'utf8'))
);

describe('int()', () => {
  test('isdigit and int agree with Python', () => {
    for (const { text, isdigit, int } of DIGITS_GOLDEN) {
      assert.equal(pyIsdigit(text), isdigit, `isdigit(${JSON.stringify(text)})`);
      assert.equal(pyInt(text), int, `int(${JSON.stringify(text)})`);
    }
  });

  test('int of a negative zero is zero, not -0', () => {
    assert.ok(Object.is(pyInt('-0'), 0));
  });

  test('pyIntOrRaise: Unicode digits, underscores, whitespace, base 16; invalid text throws', () => {
    for (const [text, expected, base = 10] of buildGolden().int) {
      if (expected === null) {
        assert.throws(() => pyIntOrRaise(text, base), /invalid literal/, JSON.stringify(text));
      } else {
        assert.equal(pyIntOrRaise(text, base), expected, JSON.stringify(text));
      }
    }
  });

  test('int() of decimal digits from any script', () => {
    assert.equal(pyDigitsToInt('0129'), 129);
    assert.equal(pyDigitsToInt(String.fromCodePoint(0x661, 0x662, 0x663)), 123);
    // Mathematical digit sets sit back to back (bold, double-struck, …).
    assert.equal(pyDigitsToInt(String.fromCodePoint(0x1d7d8, 0x1d7d9, 0x1d7ff)), 19);
    assert.equal(pyDigitsToInt('123456789012345678901234567890'), 123456789012345678901234567890n);
  });
});

describe('float()', () => {
  test('float() accepts what CPython accepts', () => {
    const cases = /** @type {[string, number | null][]} */ ([
      ['1_0.5', 10.5],
      [' 1e1 ', 10],
      ['.5', 0.5],
      ['5.', 5],
      ['+5', 5],
      ['-0', -0],
      ['INF', Infinity],
      ['-infinity', -Infinity],
      [`${String.fromCodePoint(0x661, 0x660)}`, 10],
      ['1__0', null],
      ['_1', null],
      ['0x10', null],
      ['', null],
      ['1e', null],
      ['.', null],
    ]);

    for (const [text, expected] of cases) {
      assert.equal(pyParseFloat(text), expected, text);
    }

    assert.ok(Number.isNaN(pyParseFloat('nan')));
  });

  test("pySum adds floats as CPython's sum() does (compensated, not left to right)", () => {
    /** @type {[number[], string][]} */
    const cases = [
      [Array(10).fill(0.1), '1.0'],
      [[2.27, 3.171, 0.333, 101.5, 7.007, 0.1, 0.2], '114.581'],
      [[1e16, 1, -1e16], '1.0'],
      [[-0], '0.0'],
      [[1e308, 1e308], 'inf'],
      [[123.456, 0.001, 789.012, 0.3, 0.6], '913.3689999999999'],
    ];

    for (const [values, expected] of cases) {
      assert.equal(pyFloatRepr(pySum(values)), expected, String(values));
    }

    assert.equal(pySum([]), 0);
  });
});
