import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { pythonGolden } from '../../../test/helpers/index.js';
import {
  compareCodePoints,
  dumps,
  isPyFloat,
  jsonFileText,
  jsonLineText,
  loads,
  PyFloat,
  pyFloat,
  pyFloatRepr,
} from '../pyjson.js';

const golden = pythonGolden();

describe('pyFloatRepr', () => {
  test('matches repr(float) for every golden value', () => {
    for (const [, repr] of golden.float_repr) {
      assert.equal(pyFloatRepr(Number(repr)), repr, repr);
    }
  });

  test('spells the non-finite values as Python does', () => {
    assert.equal(pyFloatRepr(Number.NaN), 'nan');
    assert.equal(pyFloatRepr(Number.POSITIVE_INFINITY), 'inf');
    assert.equal(pyFloatRepr(Number.NEGATIVE_INFINITY), '-inf');
  });
});

describe('dumps', () => {
  test('reproduces json.dumps byte for byte in all four layouts', () => {
    golden.dumps_sources.forEach((source, index) => {
      const value = loads(source);
      const expected = golden.dumps[index];

      assert.equal(jsonFileText(value), expected.file);
      assert.equal(jsonLineText(value), expected.line);
      assert.equal(dumps(value), expected.ascii);
      assert.equal(dumps(value, { indent: 2 }), expected.ascii_indent);
    });
  });

  test('prints integral floats with .0 only when they are PyFloats', () => {
    assert.equal(
      jsonLineText([1, pyFloat(1), pyFloat(0.5), pyFloat(-0), 1e16]),
      '[1, 1.0, 0.5, -0.0, 1e+16]',
    );
  });

  test('skips undefined members and rejects what Python cannot serialize', () => {
    assert.equal(jsonLineText({ a: 1, b: undefined }), '{"a": 1}');
    assert.throws(() => jsonLineText(new Map()), TypeError);
    assert.throws(() => jsonLineText([undefined]), TypeError);
  });
});

describe('loads', () => {
  test('keeps integral float literals as PyFloat and plain ints as numbers', () => {
    const value = /** @type {unknown[]} */ (loads('[1, 1.0, 2.5, 3e2, -0.0, 12345678901234567890]'));

    assert.equal(value[0], 1);
    assert.ok(isPyFloat(value[1]));
    assert.equal(Number(value[1]), 1);
    assert.equal(value[2], 2.5);
    assert.ok(value[3] instanceof PyFloat);
    assert.ok(Object.is(Number(value[4]), -0));
    assert.equal(value[5], 12345678901234567890n);
  });

  test('reads the NaN and Infinity literals Python writes', () => {
    const value = /** @type {Record<string, number>} */ (
      loads('{"a": NaN, "b": -Infinity, "c": [Infinity, 1.0]}')
    );

    assert.ok(Number.isNaN(value.a));
    assert.equal(value.b, Number.NEGATIVE_INFINITY);
    assert.equal(jsonLineText(value), '{"a": NaN, "b": -Infinity, "c": [Infinity, 1.0]}');
  });

  test('round-trips a value through file text unchanged', () => {
    const text = '{\n  "a": [\n    1.0,\n    2\n  ],\n  "b": "é"\n}\n';

    assert.equal(jsonFileText(loads(text)), text);
  });

  test('still rejects malformed JSON', () => {
    assert.throws(() => loads('{"a": NaN,}'), SyntaxError);
    assert.throws(() => loads('[1] 2'), SyntaxError);
  });
});

describe('compareCodePoints', () => {
  test('orders astral characters after the BMP, as Python does', () => {
    const astral = String.fromCodePoint(0x1f600);
    const keys = [astral, '￿', 'a', ''];

    assert.deepEqual(keys.toSorted(compareCodePoints), ['a', '', '￿', astral]);
  });
});
