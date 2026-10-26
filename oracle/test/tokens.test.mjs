import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { NAMED_COLORS, tokenize } from '../lib/tokens.mjs';

describe('tokenize', () => {
  test('recognizes color functions, hex and named colors', () => {
    const kinds = tokenize('0px 0px 4px rgba(0, 0, 0, 0.5), inset 1px 2px #fff, red').map((t) => t.t);

    assert.equal(kinds.filter((k) => k === 'color').length, 3);
  });

  test('splits text, numbers with units, and whole color calls', () => {
    assert.deepEqual(tokenize('calc(1.5em + rgb(1, 2, 3))'), [
      { t: 'text', v: 'calc(' },
      { t: 'num', v: 1.5, unit: 'em', raw: '1.5em' },
      { t: 'text', v: ' + ' },
      { t: 'color', v: 'rgb(1, 2, 3)', fn: 'rgb' },
      { t: 'text', v: ')' },
    ]);
  });

  test('names inside identifiers are not colors', () => {
    assert.deepEqual(tokenize('redish'), [{ t: 'text', v: 'redish' }]);
    assert.deepEqual(tokenize('dark-red'), [{ t: 'text', v: 'dark-red' }]);
    assert.deepEqual(tokenize('red-x'), [{ t: 'text', v: 'red-x' }]);
    assert.deepEqual(tokenize('red2'), [{ t: 'text', v: 'red2' }]);
    assert.deepEqual(tokenize('red,blue'), [
      { t: 'color', v: 'red', fn: 'named' },
      { t: 'text', v: ',' },
      { t: 'color', v: 'blue', fn: 'named' },
    ]);
    assert.deepEqual(tokenize('xrgb(1)'), [
      { t: 'text', v: 'xrgb(' },
      { t: 'num', v: 1, unit: '', raw: '1' },
      { t: 'text', v: ')' },
    ]);
  });

  test('numbers glued to an identifier stay text, after a separator they are numbers', () => {
    assert.deepEqual(tokenize('h1'), [{ t: 'text', v: 'h1' }]);
    assert.deepEqual(tokenize('a,-2.5E3PX'), [
      { t: 'text', v: 'a,' },
      { t: 'num', v: -2500, unit: 'px', raw: '-2.5E3PX' },
    ]);
  });

  test('an unclosed color call runs to the end of the value', () => {
    assert.deepEqual(tokenize('x rgb(1, 2'), [
      { t: 'text', v: 'x ' },
      { t: 'color', v: 'rgb(1, 2', fn: 'rgb' },
    ]);
  });

  test('the named-color list is css-color-4 plus transparent', () => {
    assert.equal(NAMED_COLORS.size, 149);
    assert.ok(NAMED_COLORS.has('rebeccapurple') && NAMED_COLORS.has('transparent'));
  });
});
