import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { refsOf, specCards, specInventory } from '../lib/spec.mjs';

/** @import { WebrefData } from '@webref/css' */

/** @type {WebrefData} */
const DATA = {
  properties: [
    {
      name: 'mask',
      href: 'm',
      syntax: '<mask-layer>#',
      initial: 'see individual properties',
      longhands: ['mask-image'],
    },
    { name: 'color', href: 'c', syntax: '<color>', initial: 'CanvasText', inherited: 'yes' },
    { name: '-webkit-mask', href: 'w', syntax: '<mask-layer>#', legacyAliasOf: 'mask' },
  ],
  types: [
    { name: 'color', syntax: '<color-base> | currentColor' },
    { name: '<mask-layer>', syntax: '<mask-reference> || <position>' },
  ],
  functions: [
    { name: 'color()', syntax: 'color( <colorspace-params> )' },
    { name: 'abs()' },
    { name: 'abs()' },
  ],
  atrules: [{ name: '@media', href: 'a', descriptors: [{ name: 'width' }] }, { name: '@layer' }],
  selectors: [{ name: '::before', href: 's' }, { name: ':active' }],
};

describe('refsOf', () => {
  test('types, property references, functions and ranged types, in first-use order', () => {
    assert.deepEqual(refsOf("<length [0,∞]> | <'margin-top'> | <color()> | <length>"), [
      'length',
      'margin-top',
      'color()',
    ]);
    assert.deepEqual(refsOf(undefined), []);
  });
});

describe('specCards', () => {
  test('cards carry the property fields and the grammar of referenced types', () => {
    const cards = specCards(DATA, ['color', 'mask', 'nope']);

    assert.deepEqual(Object.keys(cards), ['color', 'mask', 'nope']);
    assert.deepEqual(cards.color.types, { color: '<color-base> | currentColor' });
    assert.deepEqual(cards.mask.types, { 'mask-layer': '<mask-reference> || <position>' });
    assert.deepEqual(cards.mask.longhands, ['mask-image']);
    assert.equal(cards.color.longhands, null);
    assert.deepEqual(cards.nope, { missing: true });
    assert.equal(
      JSON.stringify(cards.color),
      '{"href":"c","syntax":"<color>","initial":"CanvasText","inherited":"yes","longhands":null,"legacyAliasOf":null,"types":{"color":"<color-base> | currentColor"}}',
    );
  });

  test('a prefixed name falls back to the standard property only when webref lacks it', () => {
    const cards = specCards(DATA, ['-webkit-mask', '-moz-color']);

    assert.equal(cards['-webkit-mask'].href, 'w');
    assert.equal(cards['-moz-color'].href, 'c');
  });
});

describe('specInventory', () => {
  test('lists every name, sorted, functions de-duplicated', () => {
    const inventory = specInventory(DATA);

    assert.deepEqual(
      inventory.properties.map((p) => p.name),
      ['-webkit-mask', 'color', 'mask'],
    );
    assert.deepEqual(inventory.properties[0], { name: '-webkit-mask', href: 'w', legacyAliasOf: 'mask' });
    assert.deepEqual(inventory.atrules, [
      { name: '@layer', href: undefined, descriptors: [] },
      { name: '@media', href: 'a', descriptors: ['width'] },
    ]);
    assert.deepEqual(
      inventory.selectors.map((s) => s.name),
      ['::before', ':active'],
    );
    assert.deepEqual(inventory.functions, ['abs()', 'color()']);
  });
});
