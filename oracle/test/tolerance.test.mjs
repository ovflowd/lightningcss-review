import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LEVEL_RANK, TOLERANCE, roundMetric, worstLevel } from '../lib/tolerance.mjs';

describe('tolerance', () => {
  test('worstLevel picks the most severe level, equal for none', () => {
    assert.equal(worstLevel([]), 'equal');
    assert.equal(worstLevel(['noise', 'near', 'space-changed']), 'near');
    assert.equal(worstLevel(['custom-changed', 'space-changed']), 'custom-changed');
    assert.equal(worstLevel(['noise', 'different', 'near']), 'different');
  });

  test('levels are ranked equal < noise < space-changed < custom-changed < near < different', () => {
    const order = Object.entries(LEVEL_RANK)
      .toSorted((a, b) => a[1] - b[1])
      .map(([level]) => level);

    assert.deepEqual(order, ['equal', 'noise', 'space-changed', 'custom-changed', 'near', 'different']);
  });

  test('roundMetric keeps six decimals and passes non-finite values', () => {
    assert.equal(roundMetric(0.12345678), 0.123457);
    assert.equal(roundMetric(Infinity), Infinity);
    assert.ok(Number.isNaN(roundMetric(NaN)));
  });

  test('tolerances are frozen', () => {
    assert.ok(Object.isFrozen(TOLERANCE));
    assert.ok(TOLERANCE.deltaEOKNoise < TOLERANCE.deltaEOKNoiseLowering);
    assert.ok(TOLERANCE.deltaEOKNoiseLowering < TOLERANCE.deltaEOKNear);
  });
});
