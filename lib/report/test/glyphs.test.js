/**
 * The report's non-ASCII characters are exactly the code points earlier reports contain.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as glyphs from '../glyphs.js';

describe('glyphs', () => {
  test('each glyph is the code point the report format uses', () => {
    const codePoints = Object.fromEntries(
      Object.entries(glyphs).map(([name, glyph]) => [name, /** @type {number} */ (glyph.codePointAt(0))]),
    );

    assert.deepEqual(codePoints, {
      ARROW: 0x2192,
      CHECK_MARK: 0x2713,
      CROSS_MARK: 0x2717,
      DELTA: 0x0394,
      ELLIPSIS: 0x2026,
      EMPTY_SET: 0x2205,
      EM_DASH: 0x2014,
      MIDDLE_DOT: 0x00b7,
      NOT_EQUAL: 0x2260,
      SECTION: 0x00a7,
    });

    for (const glyph of Object.values(glyphs)) {
      assert.equal([...glyph].length, 1);
    }
  });
});
