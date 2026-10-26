import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { fromHexFloat, pythonGolden } from '../../../test/helpers/index.js';
import {
  fnmatchcase,
  formatTemplate,
  PY_WHITESPACE,
  pyCompare,
  pyFormat,
  pyLen,
  pyRepr,
  pyRound,
  pySlice,
  pySorted,
  pySplit,
  pySplitlines,
  pyStr,
  pyStrip,
  pyTruthy,
} from '../py.js';
import { loads, pyFloat } from '../pyjson.js';

const golden = pythonGolden();

describe('pyRepr / pyStr', () => {
  test('match repr() for every golden value', () => {
    for (const [source, expected] of golden.repr) {
      assert.equal(pyRepr(loads(source)), expected, source);
    }
  });

  test('str() leaves strings alone and reprs everything else', () => {
    assert.equal(pyStr('a'), 'a');
    assert.equal(pyStr(null), 'None');
    assert.equal(pyStr(pyFloat(2)), '2.0');
    assert.equal(pyStr({ tuple: 1 }), "{'tuple': 1}");
  });
});

describe('pyTruthy', () => {
  test('follows Python, not JavaScript, for containers, zero and NaN', () => {
    assert.equal(pyTruthy([]), false);
    assert.equal(pyTruthy({}), false);
    assert.equal(pyTruthy(''), false);
    assert.equal(pyTruthy(pyFloat(0)), false);
    assert.equal(pyTruthy(Number.NaN), true);
    assert.equal(pyTruthy([0]), true);
    assert.equal(pyTruthy({ a: null }), true);
  });
});

describe('pyRound', () => {
  test('matches round(x) and round(x, n) on the exact binary value', () => {
    // The repr also tells int from float: round(2.5) is `2`, round(2.5, 0) is `2.0`.
    for (const [hex, ndigits, expected] of golden.round) {
      const value = fromHexFloat(hex);
      const result = ndigits === null ? pyRound(value) : pyRound(value, ndigits);

      assert.equal(pyRepr(result), expected, `round(${hex}, ${ndigits})`);
    }
  });
});

describe('pyFormat / formatTemplate', () => {
  test('match format(value, spec) for every golden case', () => {
    for (const [source, hex, spec, expected] of golden.format) {
      const value = hex === null ? loads(source) : pyFloat(fromHexFloat(hex));

      assert.equal(pyFormat(value, spec), expected, `format(${source}, ${JSON.stringify(spec)})`);
    }
  });

  test('fills named fields like str.format', () => {
    assert.equal(formatTemplate('{{x}} {a} {b:>3} {c!r}', { a: 1, b: 'z', c: 'q' }), "{x} 1   z 'q'");
    assert.throws(() => formatTemplate('{missing}', {}), RangeError);
  });

  test('rejects specs it does not implement instead of misprinting', () => {
    assert.throws(() => pyFormat(1.5, '.3e'), RangeError);
  });
});

describe('ordering', () => {
  test('compares like Python tuples and sorts stably, also in reverse', () => {
    assert.equal(pyCompare([1, 'b'], [1, 'a']), 1);
    assert.equal(pyCompare([false, 2], [true, 0]), -1);
    assert.throws(() => pyCompare('a', 1), TypeError);

    const rows = [
      { k: 1, id: 'a' },
      { k: 0, id: 'b' },
      { k: 1, id: 'c' },
    ];

    assert.deepEqual(
      pySorted(rows, (row) => row.k, { reverse: true }).map((row) => row.id),
      ['a', 'c', 'b'],
    );
  });
});

describe('strings', () => {
  test('PY_WHITESPACE is exactly the set str.isspace() accepts', () => {
    assert.deepEqual(
      Array.from(PY_WHITESPACE, (char) => char.codePointAt(0)),
      golden.isspace,
    );
  });

  test('strip and split use Python whitespace', () => {
    for (const [text, stripped, split, splitSpace, splitOnce, lines] of golden.strings) {
      assert.equal(pyStrip(text), stripped, JSON.stringify(text));
      assert.deepEqual(pySplit(text), split);
      assert.deepEqual(pySplit(text, ' '), splitSpace);
      assert.deepEqual(pySplit(text, null, 1), splitOnce);
      assert.deepEqual(pySplitlines(text), lines);
    }
  });

  test('splitlines splits on every Python line boundary', () => {
    for (const [text, lines] of golden.splitlines) {
      assert.deepEqual(pySplitlines(text), lines, JSON.stringify(text));
    }
  });

  test('len and slices count code points', () => {
    const text = `a${String.fromCodePoint(0x1f600)}b`;

    assert.equal(pyLen(text), 3);
    assert.equal(pySlice(text, 1, 2), String.fromCodePoint(0x1f600));
    assert.equal(pySlice(text, -1), 'b');
  });
});

describe('fnmatchcase', () => {
  test('matches fnmatch.fnmatchcase for every golden pattern and name', () => {
    for (const [pattern, name, expected] of golden.fnmatch) {
      assert.equal(
        fnmatchcase(name, pattern),
        expected,
        `fnmatchcase(${JSON.stringify(name)}, ${JSON.stringify(pattern)})`,
      );
    }
  });
});
