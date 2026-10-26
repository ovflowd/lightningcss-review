import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GRADIENT_PROPS, compareValues } from '../lib/normalize.mjs';

describe('compareValues', () => {
  test('numbers and colors within tolerance are noise; real changes are different', () => {
    assert.equal(compareValues('width', '100.0004px', '100px').level, 'noise');
    assert.equal(compareValues('width', '100.5px', '100px').level, 'different');
    // Large values get a relative tolerance (1e-4).
    assert.equal(compareValues('width', '100005px', '100000px').level, 'noise');
    assert.equal(compareValues('width', '100011px', '100000px').level, 'different');
    assert.equal(compareValues('width', '10px', '10em').level, 'different');
    assert.equal(compareValues('color', 'oklch(0.7 0.1 200)', 'oklch(0.700001 0.1 200)').level, 'noise');
    assert.equal(compareValues('color', 'rgb(255, 0, 0)', 'rgb(0, 0, 255)').level, 'different');
  });

  test('a `none` component replaced by a number is a semantic change', () => {
    assert.equal(compareValues('color', 'oklch(0.7 0.1 none)', 'oklch(0.7 0.1 0)').level, 'different');
  });

  test('legacy/modern switch is visible in gradients only', () => {
    assert.equal(compareValues('color', 'oklch(0.7 0.1 200)', 'rgb(52, 178, 188)').level, 'near');
    assert.equal(
      compareValues(
        'background-image',
        'linear-gradient(oklch(0.7 0.1 200), rgb(255, 0, 0))',
        'linear-gradient(rgb(52, 178, 188), rgb(255, 0, 0))',
      ).level,
      'different',
    );
    assert.ok(GRADIENT_PROPS.has('mask-image'));
  });

  test('lowering mode gamut-maps the reference and tolerates 8-bit quantization', () => {
    assert.notEqual(
      compareValues('color', 'color(display-p3 1 0 0)', 'rgb(255, 0, 0)', 'lowering').level,
      'different',
    );
  });

  test('identical strings are equal; a missing value is different', () => {
    assert.deepEqual(compareValues('color', 'red', 'red'), { level: 'equal' });
    assert.deepEqual(compareValues('color', null, 'red'), { level: 'different', reason: 'missing' });
    assert.deepEqual(compareValues('color', 'red', undefined), { level: 'different', reason: 'missing' });
  });

  test('custom properties: added/removed and rewritten values are custom-changed, whitespace is noise', () => {
    assert.deepEqual(compareValues('--x', null, '1px'), {
      level: 'custom-changed',
      reason: 'custom-property-added-or-removed',
    });
    assert.deepEqual(compareValues('--x', ' 1px  2px', '1px 2px'), { level: 'noise' });

    const changed = compareValues('--x', 'color-mix(in oklab, red, blue)', 'rgb(1, 2, 3)');

    assert.equal(changed.level, 'custom-changed');
    assert.ok(Array.isArray(changed.details));
    // A non-different inner result is returned as it is.
    assert.equal(compareValues('--x', '1px', '1.0001px').level, 'noise');
  });

  test('token shape: a different token count is different; a color is one token however spelled', () => {
    assert.deepEqual(compareValues('margin', '1px 2px', '1px'), { level: 'different', reason: 'shape' });
    assert.equal(compareValues('color', 'color(srgb 1 0 0)', 'rgb(255, 0, 0)').level, 'space-changed');
  });

  test('token kinds, units and text are compared position by position', () => {
    assert.equal(compareValues('x', 'a 1px', 'a red').details?.[0]?.reason, 'token-kind');
    assert.equal(compareValues('x', '1px', '1%').details?.[0]?.reason, 'unit');
    assert.equal(compareValues('font-family', 'a,  b', 'a, b').level, 'equal');
    assert.equal(compareValues('font-family', 'serif', 'sans').details?.[0]?.reason, 'text');
  });

  test('details keep the first four non-equal tokens; the worst token decides', () => {
    const result = compareValues('x', '1px 2px 3px 4px 5px', '9px 9px 9px 9px 9px');

    assert.equal(result.level, 'different');
    assert.equal(result.details?.length, 4);
    assert.deepEqual(result.details?.[0], { level: 'different', reason: 'number', delta: 8 });
  });
});
