import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { FIXTURES_DIR } from '../../../test/helpers/index.js';
import { wrap } from '../textwrap.js';

/** Python's `textwrap.wrap(text, width)` on 300 random texts (hyphens, dashes, long words). */
const GOLDEN = /** @type {{ text: string, width: number, lines: string[] }[]} */ (
  JSON.parse(readFileSync(join(FIXTURES_DIR, 'infra', 'textwrap.json'), 'utf8'))
);

test('wrap breaks lines where Python textwrap breaks them', () => {
  for (const { text, width, lines } of GOLDEN) {
    assert.deepEqual(wrap(text, width), lines, `${JSON.stringify(text)} at ${width}`);
  }
});

test('wrap breaks after the hyphen of a hyphenated word and cuts words longer than a line', () => {
  assert.deepEqual(wrap('assemble cases (tests, probes, WPT, real-world), run', 41), [
    'assemble cases (tests, probes, WPT, real-',
    'world), run',
  ]);
  assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrap('  ', 10), []);
});
