import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { balanced, validityProbe } from '../lib/probes.mjs';

describe('validityProbe', () => {
  test('uses the exact source text', () => {
    assert.deepEqual(validityProbe('.a{margin:1px  2px!important}').decls, [['margin', '1px  2px', true]]);
  });

  test('preludes are sliced from the at-keyword to the block and stay balanced', () => {
    const probe = validityProbe(
      '@supports ((-webkit-appearance:none) or (appearance:none)){.a{color:red}}@media (min-width:1px) and ((hover)){.b{color:red}}',
    );

    assert.deepEqual(probe.preludes, [
      ['supports', '((-webkit-appearance:none) or (appearance:none))'],
      ['media', '(min-width:1px) and ((hover))'],
    ]);
  });

  test('conditional preludes are probed up to their block (css-tree drops the final paren)', () => {
    assert.deepEqual(validityProbe('@supports (a:b) and ((-webkit-c:d)){.x{color:red}}').preludes, [
      ['supports', '(a:b) and ((-webkit-c:d))'],
    ]);
    assert.deepEqual(validityProbe('@media (min-width:1px) and (max-width:2px){.x{color:red}}').preludes, [
      ['media', '(min-width:1px) and (max-width:2px)'],
    ]);
  });

  test('keyframe selectors are not probed as selectors', () => {
    assert.deepEqual(validityProbe('@keyframes k{0%{color:red}from{color:blue}}').selectors, []);
  });

  test('nested rules: declarations are probed, nested and & selectors are not', () => {
    assert.deepEqual(validityProbe('.p{.c{color:red} margin:1px}').decls, [
      ['color', 'red', false],
      ['margin', '1px', false],
    ]);
    assert.deepEqual(validityProbe('.p{> .c{color:red}}').selectors, ['.p']);
    assert.deepEqual(validityProbe('&.x{color:red}').selectors, []);
  });

  test('each list stops at the limit', () => {
    const probe = validityProbe('.a{color:red}.b{color:red}.c{color:red}', 2);

    assert.deepEqual([probe.decls.length, probe.selectors.length], [2, 2]);
  });

  test('a sheet css-tree cannot parse yields empty lists', () => {
    assert.equal(validityProbe('.a{color:red}').parsed, true);
    // css-tree recovers from any CSS text; only a non-string makes it throw.
    assert.deepEqual(validityProbe(/** @type {string} */ (/** @type {unknown} */ (null))), {
      decls: [],
      selectors: [],
      preludes: [],
      parsed: false,
    });
  });
});

describe('balanced', () => {
  test('parentheses and brackets outside strings, comments and escapes', () => {
    assert.equal(balanced('(a) or (b))'), false);
    assert.equal(balanced('(")") or [x]'), true);
    assert.equal(balanced('(/* ) */)'), true);
    assert.equal(balanced('(\\))'), true);
    assert.equal(balanced('(]'), false);
    assert.equal(balanced('(('), false);
  });
});
