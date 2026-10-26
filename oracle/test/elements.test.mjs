import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseSheet } from '../lib/css.mjs';
import { RTL_LANGS, applyCompound, newElement, nthIndex } from '../lib/elements.mjs';
import { toSteps } from '../lib/selectors.mjs';

/** @import { CssNode } from 'css-tree' */

/**
 * The element synthesized for a one-compound selector.
 *
 * @param {string} selector
 * @returns {{ element: import('../lib/elements.mjs').SynthElement, context: { unsupported: number, root?: boolean } }}
 */
function elementFor(selector) {
  const ast = /** @type {CssNode} */ (parseSheet(`${selector}{}`));
  const steps = toSteps(/** @type {CssNode} */ (ast.children?.first?.prelude?.children?.first));
  const element = newElement();
  const context = { unsupported: 0 };

  applyCompound(element, steps[0].compound, context);

  return { element, context };
}

describe('applyCompound', () => {
  test('type, class, id and attribute selectors', () => {
    const { element } = elementFor('svg|Rect.a.b#i[x][y="1"][z~=w]');

    assert.equal(element.tag, 'rect');
    assert.deepEqual(element.classes, ['a', 'b']);
    assert.equal(element.id, 'i');
    assert.deepEqual(element.attrs, { x: '', y: '1', z: 'w' });
  });

  test('escaped identifiers are decoded', () => {
    assert.deepEqual(elementFor('.\\31 a').element.classes, ['1a']);
  });

  test('user-action pseudo-classes become the rewritten attributes', () => {
    assert.deepEqual(elementFor('.a:hover:focus-visible').element.attrs, {
      'data-lcr-hover': '',
      'data-lcr-focus-visible': '',
    });
  });

  test('form pseudo-classes turn a div into an input; an explicit tag wins', () => {
    assert.deepEqual(elementFor(':checked').element, {
      ...newElement('input'),
      attrs: { type: 'checkbox', checked: '' },
    });
    assert.equal(elementFor('select:required').element.tag, 'select');
    assert.deepEqual(elementFor(':read-only').element.attrs, { readonly: '' });
    assert.equal(elementFor(':any-link').element.tag, 'a');
  });

  test('pseudo-elements that need a host element get one', () => {
    assert.equal(elementFor('.a::marker').element.tag, 'li');
    assert.deepEqual(elementFor('::placeholder').element.attrs, { placeholder: 'x' });
    assert.deepEqual(elementFor('::file-selector-button').element.attrs, { type: 'file' });
  });

  test(':is() applies its first single-step selector; unknown pseudo-classes are unsupported', () => {
    assert.deepEqual(elementFor(':is(.a .b, .c)').element.classes, ['c']);
    assert.equal(elementFor(':is(.a .b)').context.unsupported, 1);
    assert.equal(elementFor(':playing').context.unsupported, 1);
    assert.equal(elementFor(':not(.a)').context.unsupported, 0);
  });

  test(':root and :empty', () => {
    assert.equal(elementFor(':root').context.root, true);
    assert.equal(elementFor('.a:empty').element.empty, true);
  });
});

describe('nthIndex', () => {
  test('the smallest positive index matching An+B', () => {
    const nth = (/** @type {string} */ arg) => {
      const { element } = elementFor(`.a:nth-child(${arg})`);

      return (element.spacersBefore ?? 0) + 1;
    };

    assert.equal(nth('3'), 3);
    assert.equal(nth('2n+1'), 1);
    assert.equal(nth('3n+5'), 5);
    assert.equal(nth('-n+3'), 1);
    assert.equal(nth('even'), 2);
    assert.equal(nth('odd'), 1);
    assert.equal(nthIndex(null), 1);
  });
});

describe('RTL_LANGS', () => {
  test('lists the languages lowered :dir(rtl) matches', () => {
    assert.equal(RTL_LANGS.size, 19);
    assert.ok(RTL_LANGS.has('he') && RTL_LANGS.has('yi'));
  });
});
