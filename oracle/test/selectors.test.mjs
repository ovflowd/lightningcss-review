import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as csstree from 'css-tree';

import { parseSheet } from '../lib/css.mjs';
import {
  collectSelectors,
  firstCompoundOf,
  pseudoElementName,
  resolveNested,
  toSteps,
} from '../lib/selectors.mjs';

/** @import { CssNode } from 'css-tree' */
/** @import { Steps } from '../lib/selectors.mjs' */

/**
 * @param {Steps} steps
 * @returns {[string | null, string][]}
 */
const show = (steps) =>
  steps.map((step) => [step.combinator, step.compound.map((node) => csstree.generate(node)).join('')]);

/**
 * @param {string} css
 * @returns {CssNode}
 */
function firstSelector(css) {
  const ast = /** @type {CssNode} */ (parseSheet(css));

  return /** @type {CssNode} */ (ast.children?.first?.prelude?.children?.first);
}

/**
 * @param {string} css
 * @returns {string[][]}
 */
function selectorsOf(css) {
  return collectSelectors(/** @type {CssNode} */ (parseSheet(css))).selectors.map((steps) =>
    show(steps).map(([combinator, text]) => `${combinator ?? ''}${text}`),
  );
}

describe('toSteps', () => {
  test('splits a selector at combinators', () => {
    assert.deepEqual(show(toSteps(firstSelector('.a > .b + .c{}'))), [
      [null, '.a'],
      ['>', '.b'],
      ['+', '.c'],
    ]);
  });

  test('a relative selector keeps an empty first step', () => {
    const ast = /** @type {CssNode} */ (parseSheet('.p{> .c{}}'));
    const nested = /** @type {CssNode} */ (
      ast.children?.first?.block?.children?.first?.prelude?.children?.first
    );

    assert.deepEqual(show(toSteps(nested)), [
      [null, ''],
      ['>', '.c'],
    ]);
  });
});

describe('resolveNested', () => {
  test('& is replaced by the parent; no & means a descendant', () => {
    assert.deepEqual(selectorsOf('.a{&.b{} .c{} > .d{} .e &{}}'), [
      ['.a'],
      ['.a.b'],
      ['.a', ' .c'],
      ['.a', '>.d'],
      ['.e', ' .a'],
    ]);
  });

  test('every parent of a list gets the nested rule', () => {
    assert.deepEqual(selectorsOf('.a,.b{.c{}}'), [['.a'], ['.b'], ['.a', ' .c'], ['.b', ' .c']]);
  });

  test('a top-level & is dropped', () => {
    assert.deepEqual(show(resolveNested(toSteps(firstSelector('&.x{}')), null)[0]), [[null, '.x']]);
  });
});

describe('collectSelectors', () => {
  test('@scope roots act as the parent; conditional rules are walked; keyframes are not', () => {
    assert.deepEqual(selectorsOf('@scope (.card) to (.x){.t{}}@media print{.m{}}@keyframes k{from{}}'), [
      ['.card', ' .t'],
      ['.m'],
    ]);
  });

  test('counts pseudo-elements it cannot read', () => {
    const found = collectSelectors(
      /** @type {CssNode} */ (parseSheet('.a::-webkit-scrollbar{} .b::before{}')),
    );

    assert.deepEqual([found.pseudos, found.unsupported], [['::before'], 1]);
  });
});

describe('pseudoElementName', () => {
  test('standard names, aliases and one-colon CSS 2 forms', () => {
    const nodeOf = (/** @type {string} */ css) =>
      /** @type {CssNode} */ (firstSelector(css).children?.toArray().at(-1));

    assert.equal(pseudoElementName(nodeOf('.a::-ms-browse{}')), 'file-selector-button');
    assert.equal(pseudoElementName(nodeOf('.a:first-letter{}')), 'first-letter');
    assert.equal(pseudoElementName(nodeOf('.a:hover{}')), null);
    assert.equal(pseudoElementName(nodeOf('.a{}')), null);
  });
});

describe('firstCompoundOf', () => {
  test('the first single-step selector of a list', () => {
    const is = /** @type {CssNode} */ (firstSelector(':is(.a .b, .c.d){}').children?.first);
    const compound = firstCompoundOf(/** @type {CssNode} */ (is.children?.first));

    assert.deepEqual(
      compound?.map((node) => csstree.generate(node)),
      ['.c', '.d'],
    );
    assert.equal(firstCompoundOf(null), null);
  });
});
