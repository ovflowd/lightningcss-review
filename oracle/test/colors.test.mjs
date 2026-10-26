import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Color from 'colorjs.io';

import { compareColors, toSrgbGamut } from '../lib/colors.mjs';

describe('compareColors', () => {
  test('equal strings are equal without parsing', () => {
    assert.deepEqual(compareColors('not a color', 'not a color'), { level: 'equal' });
  });

  test('an unparseable color is different', () => {
    assert.deepEqual(compareColors('rgb(1, 2, 3)', 'bogus(1)'), {
      level: 'different',
      reason: 'unparseable-color',
    });
  });

  test('a none component appearing is different in the same engine only', () => {
    assert.equal(
      compareColors('oklch(0.7 0.1 none)', 'oklch(0.7 0.1 0)').reason,
      'missing-component-changed',
    );
    assert.notEqual(
      compareColors('oklch(0.7 0.1 none)', 'oklch(0.7 0.1 0)', 'lowering').reason,
      'missing-component-changed',
    );
  });

  test('a legacy/modern spelling of the same color is space-changed in the same engine, noise when lowering', () => {
    assert.equal(compareColors('rgb(255, 0, 0)', 'color(srgb 1 0 0)').level, 'space-changed');
    assert.equal(compareColors('rgb(255, 0, 0)', 'color(srgb 1 0 0)', 'lowering').level, 'noise');
  });

  test('near and different carry rounded distances', () => {
    const near = compareColors('oklch(0.7 0.1 200)', 'rgb(52, 178, 188)');

    assert.equal(near.level, 'near');
    assert.equal(near.spaceChanged, true);
    assert.equal(Math.round((near.deltaE ?? 0) * 1e6), (near.deltaE ?? 0) * 1e6);

    const far = compareColors('rgb(255, 0, 0)', 'rgb(0, 0, 255)');

    assert.deepEqual(Object.keys(far), ['level', 'deltaE', 'alpha', 'reason']);
    assert.equal(far.reason, 'color-distance');
  });

  test('alpha beyond the near tolerance is different', () => {
    assert.equal(compareColors('rgba(0, 0, 0, 0.5)', 'rgba(0, 0, 0, 0.6)').level, 'different');
  });
});

describe('toSrgbGamut', () => {
  test('maps an out-of-gamut color into sRGB', () => {
    const mapped = toSrgbGamut(new Color('color(display-p3 1 0 0)'));

    assert.ok(mapped.inGamut('srgb'));
  });
});
